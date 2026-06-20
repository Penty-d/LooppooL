import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { bus, now } from './events';

/**
 * 终端 UI 工具集 —— 统一颜色、图标、分组打印
 *
 * v2：不再直接 console.log，所有函数都 emit 一个事件到事件总线。
 * TUI（Ink）订阅这些事件做渲染。
 *
 * 调用方（looppool / orchestrator / task-pool / agent-engine）完全不感知
 * 渲染层——它们只"报告发生了什么"。
 *
 * 函数签名保持不变，所以接入层零改动。
 */

const C = {
  brand: chalk.hex('#a78bfa'),
  orchestrator: chalk.cyan,
  execute: chalk.green,
  validate: chalk.magenta,
  agent: chalk.gray,
  toolCall: chalk.blue,
  toolResult: chalk.gray,
  thought: chalk.yellow,
  ok: chalk.greenBright,
  warn: chalk.yellow,
  err: chalk.red,
  dim: chalk.gray,
  bold: chalk.bold,
  num: chalk.bold.white,
};

const ICON = {
  brand: '✦',
  brain: '🧠',
  hammer: '🔨',
  check: '✔',
  cross: '✘',
  arrow: '→',
  curve: '↳',
  bubble: '💬',
  sparkle: '✨',
  warn: '⚠',
  pin: '▸',
};

export { C as color, ICON as icon };

/* ============================================================
 * 收尾
 * ============================================================ */

export function printFinalSummary(opts: {
  iterations: number;
  totalTasks: number;
  qualityScore?: number;
  status: 'completed' | 'partial';
}): void {
  bus.dispatch({
    type: 'final-summary',
    payload: { ...opts, ts: now() },
  });
}

export function printFinalResult(result: any): void {
  bus.dispatch({ type: 'final-result', payload: { result, ts: now() } });
}

/* ============================================================
 * 调度器 / 阶段 / 任务
 * ============================================================ */

export function logIteration(n: number, max: number): void {
  bus.dispatch({
    type: 'iteration-start',
    payload: { iteration: n, maxIterations: max, ts: now() },
  });
}

export function logPlanning(): void {
  // 不再单独发事件——plan-ready 时统一发 reasoning
}

export function logPlanReady(stages: number, tasks: number): void {
  bus.dispatch({
    type: 'plan-ready',
    payload: { stages, tasks, reasoning: '', ts: now() },
  });
}

export function logReasoning(text: string): void {
  if (!text) return;
  bus.dispatch({
    type: 'plan-ready',
    payload: { stages: 0, tasks: 0, reasoning: text, ts: now() },
  });
}

export function logStage(
  index: number,
  total: number,
  id: string,
  mode: 'parallel' | 'serial',
  taskCount: number
): void {
  bus.dispatch({
    type: 'stage-start',
    payload: { index, total, id, mode, taskCount, ts: now() },
  });
}

export function logTaskStart(
  taskId: string,
  modelId: string,
  description: string,
  kind: 'execute' | 'validate'
): void {
  bus.dispatch({
    type: 'task-start',
    payload: { taskId, modelId, description, kind, ts: now() },
  });
}

export function logTaskDone(
  taskId: string,
  ok: boolean,
  durationMs: number,
  modelUsed: string
): void {
  bus.dispatch({
    type: 'task-done',
    payload: { taskId, ok, durationMs, modelUsed, ts: now() },
  });
}

export function logTaskError(taskId: string, msg: string): void {
  bus.dispatch({
    type: 'log',
    payload: { level: 'error', message: `[${taskId}] ${msg}`, ts: now() },
  });
}

export function logStageSummary(success: number, total: number): void {
  // 注意：原 API 没传 stageId，这里用一个占位 id，TUI 用最近一个 stage 关联
  bus.dispatch({
    type: 'stage-summary',
    payload: { stageId: '', success, total, ts: now() },
  });
}

export function logCriticalAbort(): void {
  bus.dispatch({
    type: 'log',
    payload: {
      level: 'warn',
      message: '检测到关键失败，终止后续 Stage',
      ts: now(),
    },
  });
}

/* ============================================================
 * Agent 工具调用 / 思考 / 上下文压缩
 * ============================================================ */

export function logToolCall(
  taskId: string,
  toolName: string,
  briefArgs: string
): void {
  bus.dispatch({
    type: 'tool-call',
    payload: { taskId, toolName, briefArgs, ts: now() },
  });
}

export function logToolResult(taskId: string, brief: string): void {
  bus.dispatch({
    type: 'tool-result',
    payload: { taskId, brief, ts: now() },
  });
}

export function logAgentText(taskId: string, brief: string): void {
  bus.dispatch({
    type: 'agent-text',
    payload: { taskId, brief, ts: now() },
  });
}

export function logContextCompaction(
  taskId: string,
  beforeTokens: number,
  afterTokens: number,
  keptSteps: number
): void {
  bus.dispatch({
    type: 'context-compaction',
    payload: { taskId, beforeTokens, afterTokens, keptSteps, ts: now() },
  });
}

/* ============================================================
 * 决策
 * ============================================================ */

export function logDecisionStart(): void {
  // decision 事件会带全部信息，这里不发单独事件
}

export function logDecision(
  shouldContinue: boolean,
  qualityScore: number,
  reason: string
): void {
  bus.dispatch({
    type: 'decision',
    payload: { shouldContinue, qualityScore, reason, ts: now() },
  });
}

/* ============================================================
 * 错误
 * ============================================================ */

export function logError(prefix: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const [first, ...rest] = msg.split('\n');
  const message = `${prefix}: ${first}`;
  let detailsPath: string | undefined;
  for (const line of rest) {
    const fileMatch = line.match(/^(?:完整原文|raw):\s*(.+)$/);
    if (fileMatch) {
      detailsPath = fileMatch[1].trim();
      break;
    }
  }
  bus.dispatch({
    type: 'log',
    payload: { level: 'error', message, detailsPath, ts: now() },
  });
}

export function spinner(text: string): Ora {
  // TUI 模式下 spinner 没意义，但保留 API 兼容
  // 返回一个 mock spinner，调用方调 .start()/.stop() 不报错
  return ora({ text: C.dim(text), spinner: 'dots', isEnabled: false });
}
