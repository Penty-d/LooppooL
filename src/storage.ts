import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'fs';
import { resolve as pathResolve, dirname, join as pathJoin } from 'path';
import type {
  ExecutionPlan,
  ExecutionResult,
  IterationRecord,
  Decision,
} from './types';

/**
 * 断点持久化（Checkpoint / Resume）
 *
 * 每个成功完成的迭代后，LoopPool 把运行状态（history、累计结果、下一轮 pendingPlan、
 * startedAt）落盘到 config.storage.historyPath/<requestId>/checkpoint.json。
 * 崩溃后用 --resume 从断点继续，不重跑已完成的迭代。
 *
 * 序列化要点：
 *   - Map<string, ExecutionResult> → 普通对象（Object.fromEntries），载入时还原回 Map
 *   - Date 字段（metrics.startTime/endTime、plan.createdAt、timestamp）→ ISO 字符串，载入时还原
 *   - 必须逐字段显式转换，不能偷懒用通用 ISO reviver——
 *     任务的 output 字符串如果长得像 ISO 日期会被误转
 */

export type CheckpointStatus = 'in-progress' | 'completed';

export const CHECKPOINT_FILE = 'checkpoint.json';
export const CHECKPOINT_VERSION = 1;

/** 已反序列化的完整检查点（Map/Date 已还原），resume() 直接使用 */
export interface ResumeCheckpoint {
  requestId: string;
  userRequest: string;
  userContext?: any;
  /** epoch ms，跨崩溃累计 totalTime */
  startedAt: number;
  status: CheckpointStatus;
  updatedAt: string;
  history: IterationRecord[];
  accumulatedResults: Map<string, ExecutionResult>;
  /** 上一轮决策排队给下一轮的 plan（decision.newPlan） */
  pendingPlan?: ExecutionPlan;
}

/** save() 入参：领域对象，序列化在内部完成 */
export interface SaveCheckpointInput {
  requestId: string;
  userRequest: string;
  userContext?: any;
  startedAt: number;
  pendingPlan?: ExecutionPlan;
  accumulatedResults: Map<string, ExecutionResult>;
  history: IterationRecord[];
  status?: CheckpointStatus;
}

/** listResumable() 返回的元信息（给 --resume 自动选最近一次用） */
export interface ResumableRun {
  requestId: string;
  userRequest: string;
  iterations: number;
  startedAt: number;
  updatedAt: string;
  status: CheckpointStatus;
}

// ============================================================
// 序列化 helpers（导出供 looppool 等处复用）
// ============================================================

export function serializePlan(plan: ExecutionPlan): any {
  const out: any = { ...plan };
  if (out.createdAt !== undefined) {
    out.createdAt =
      out.createdAt instanceof Date
        ? out.createdAt.toISOString()
        : new Date(out.createdAt).toISOString();
  }
  return out;
}

export function deserializePlan(o: any): ExecutionPlan {
  if (!o || typeof o !== 'object' || !Array.isArray(o.stages)) {
    throw new Error('plan 结构缺失或 stages 非法');
  }
  return {
    reasoning: o.reasoning,
    stages: o.stages,
    estimatedTime: o.estimatedTime,
    createdAt: o.createdAt ? new Date(o.createdAt) : new Date(),
  };
}

export function serializeExecutionResult(r: ExecutionResult): any {
  return {
    ...r,
    metrics: {
      ...r.metrics,
      startTime:
        r.metrics.startTime instanceof Date
          ? r.metrics.startTime.toISOString()
          : String(r.metrics.startTime),
      endTime:
        r.metrics.endTime instanceof Date
          ? r.metrics.endTime.toISOString()
          : String(r.metrics.endTime),
    },
  };
}

export function deserializeExecutionResult(o: any): ExecutionResult {
  return {
    ...o,
    metrics: {
      ...o.metrics,
      startTime: new Date(o.metrics?.startTime ?? Date.now()),
      endTime: new Date(o.metrics?.endTime ?? Date.now()),
    },
  };
}

export function serializeResultMap(
  map: Map<string, ExecutionResult>
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of map) out[k] = serializeExecutionResult(v);
  return out;
}

export function deserializeResultMap(o: any): Map<string, ExecutionResult> {
  const map = new Map<string, ExecutionResult>();
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      map.set(k, deserializeExecutionResult(v));
    }
  }
  return map;
}

export function serializeDecision(d: Decision): any {
  return {
    ...d,
    newPlan: d.newPlan ? serializePlan(d.newPlan) : null,
  };
}

export function deserializeDecision(o: any): Decision {
  return {
    shouldContinue: o.shouldContinue,
    reason: o.reason,
    qualityScore: o.qualityScore,
    newPlan: o.newPlan ? deserializePlan(o.newPlan) : undefined,
    finalResult: o.finalResult,
  };
}

export function serializeIterationRecord(rec: IterationRecord): any {
  return {
    ...rec,
    plan: serializePlan(rec.plan),
    results: serializeResultMap(rec.results),
    decision: serializeDecision(rec.decision),
    timestamp:
      rec.timestamp instanceof Date
        ? rec.timestamp.toISOString()
        : String(rec.timestamp),
  };
}

export function deserializeIterationRecord(o: any): IterationRecord {
  return {
    iteration: o.iteration,
    plan: deserializePlan(o.plan),
    results: deserializeResultMap(o.results),
    decision: deserializeDecision(o.decision),
    timestamp: new Date(o.timestamp ?? Date.now()),
  };
}

// ============================================================
// CheckpointStore
// ============================================================

export class CheckpointStore {
  private root: string;

  constructor(rootDir: string) {
    this.root = pathResolve(rootDir);
  }

  /**
   * 清洗 requestId 并返回 checkpoint 文件绝对路径。
   * requestId 可能来自 CLI argv，必须拒绝路径穿越（分隔符 / .. / . 开头 / 空）。
   */
  private filePathFor(requestId: string): string {
    if (
      !requestId ||
      /[\\/]/.test(requestId) ||
      requestId.includes('..') ||
      requestId.startsWith('.')
    ) {
      throw new Error(`非法 requestId: ${JSON.stringify(requestId)}`);
    }
    return pathJoin(this.root, requestId, CHECKPOINT_FILE);
  }

  /** 落盘检查点（覆盖写）。同步：必须在循环继续前确认已写入磁盘。 */
  save(input: SaveCheckpointInput): void {
    const filePath = this.filePathFor(input.requestId);
    const payload = {
      version: CHECKPOINT_VERSION,
      requestId: input.requestId,
      userRequest: input.userRequest,
      userContext: input.userContext,
      startedAt: input.startedAt,
      status: input.status ?? 'in-progress',
      updatedAt: new Date().toISOString(),
      pendingPlan: input.pendingPlan ? serializePlan(input.pendingPlan) : null,
      history: input.history.map(serializeIterationRecord),
      accumulatedResults: serializeResultMap(input.accumulatedResults),
    };
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  /** 读取检查点并反序列化；缺文件 / JSON 坏 / 版本不符 / 形状不对 → null */
  load(requestId: string): ResumeCheckpoint | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePathFor(requestId), 'utf-8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed.version !== CHECKPOINT_VERSION) return null;
      if (
        typeof parsed.requestId !== 'string' ||
        !Array.isArray(parsed.history)
      ) {
        return null;
      }
      return {
        requestId: parsed.requestId,
        userRequest: parsed.userRequest,
        userContext: parsed.userContext,
        startedAt: parsed.startedAt,
        status: parsed.status === 'completed' ? 'completed' : 'in-progress',
        updatedAt: parsed.updatedAt,
        history: parsed.history.map(deserializeIterationRecord),
        accumulatedResults: deserializeResultMap(parsed.accumulatedResults),
        pendingPlan: parsed.pendingPlan
          ? deserializePlan(parsed.pendingPlan)
          : undefined,
      };
    } catch (err: any) {
      console.error(
        `[checkpoint] 读取检查点失败: ${this.filePathFor(requestId)} — ${err?.message ?? err}`
      );
      return null;
    }
  }

  /** 列出可恢复的 run（status==='in-progress'），按 updatedAt 倒序（最近优先） */
  listResumable(): ResumableRun[] {
    if (!existsSync(this.root)) return [];

    let dirs: string[];
    try {
      dirs = readdirSync(this.root);
    } catch {
      return [];
    }

    const out: ResumableRun[] = [];
    for (const dir of dirs) {
      let ckpt: ResumeCheckpoint | null;
      try {
        ckpt = this.load(dir);
      } catch {
        ckpt = null; // 目录名异常等情况，跳过
      }
      if (!ckpt || ckpt.status !== 'in-progress') continue;
      out.push({
        requestId: ckpt.requestId,
        userRequest: ckpt.userRequest,
        iterations: ckpt.history.length,
        startedAt: ckpt.startedAt,
        updatedAt: ckpt.updatedAt,
        status: ckpt.status,
      });
    }

    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  /** 就地把检查点标记为 completed（不再可恢复）。缺文件时告警、不抛错。 */
  finalize(requestId: string): void {
    const filePath = this.filePathFor(requestId);
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      parsed.status = 'completed';
      parsed.updatedAt = new Date().toISOString();
      writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(
        `[checkpoint] finalize 失败: ${requestId} — ${err?.message ?? err}`
      );
    }
  }

  statusOf(requestId: string): CheckpointStatus | null {
    const ckpt = this.load(requestId);
    return ckpt ? ckpt.status : null;
  }
}
