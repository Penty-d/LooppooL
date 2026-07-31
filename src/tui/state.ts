import { useEffect, useReducer } from 'react';
import { bus } from '../events';
import type {
  UiEvent,
  TaskKind,
} from '../events';

/**
 * TUI 状态：一棵执行树
 *
 * 结构：
 *   iterations[]
 *     └ stages[]
 *         └ tasks[]
 *             └ events[]  （tool-call / tool-result / agent-text / context-compaction）
 *
 * 外加：
 *   - bannerShown: 是否已显示横幅
 *   - request: 用户需求
 *   - currentStageId: 最近开始的 stage（用于 stage-summary 事件关联）
 *   - decision: 最新决策
 *   - finalSummary / finalResult: 收尾信息
 *   - logs: 错误/警告日志（不在任务树里的）
 */

export interface TaskEventEntry {
  kind: 'tool-call' | 'tool-result' | 'agent-text' | 'context-compaction';
  ts: number;
  toolName?: string;
  briefArgs?: string;
  brief?: string;
  beforeTokens?: number;
  afterTokens?: number;
  keptSteps?: number;
}

/** 单个 task 保留的最大事件数：超出丢弃最早的部分（长任务事件无上限会拖慢渲染） */
export const MAX_TASK_EVENTS = 200;

export interface TaskEntry {
  /** 全局唯一 key（iteration-stage-taskId），用于选中/展开区分，避免不同迭代同名 task 撞车 */
  uid: string;
  taskId: string;
  modelId: string;
  description: string;
  kind: TaskKind;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  durationMs?: number;
  modelUsed?: string;
  events: TaskEventEntry[];
  /** 工具调用次数（O(1) 计数，避免每次渲染 filter 全量 events） */
  toolCalls: number;
  /** 因超过 MAX_TASK_EVENTS 被丢弃的早期事件数 */
  truncatedEvents?: number;
  expanded: boolean;
}

export interface StageEntry {
  id: string;
  index: number;
  total: number;
  mode: 'parallel' | 'serial';
  taskCount: number;
  startedAt: number;
  summary?: { success: number; total: number };
  tasks: TaskEntry[];
}

export interface IterationEntry {
  iteration: number;
  maxIterations: number;
  startedAt: number;
  reasoning?: string;
  stages: StageEntry[];
  decision?: {
    shouldContinue: boolean;
    qualityScore: number;
    reason: string;
  };
}

export interface TuiState {
  bannerShown: boolean;
  request?: string;
  iterations: IterationEntry[];
  currentStageId?: string;
  logs: { level: 'info' | 'warn' | 'error'; message: string; detailsPath?: string; ts: number }[];
  finalSummary?: { iterations: number; totalTasks: number; qualityScore?: number; status: string };
  finalResult?: any;
  selectedTaskId?: string; // 当前展开/选中的 task
}

export const initialState: TuiState = {
  bannerShown: false,
  iterations: [],
  logs: [],
};

type Action =
  | { type: 'event'; event: UiEvent };

export function reducer(state: TuiState, action: Action): TuiState {
  if (action.type !== 'event') return state;
  const e = action.event;
  const p = e.payload as any;
  const state1 = { ...state };

  switch (e.type) {
    case 'banner':
      return { ...state, bannerShown: true };

    case 'request':
      return { ...state, request: p.request };

    case 'iteration-start': {
      const iterations = [...state.iterations];
      // 同一 iteration 不重复添加
      if (!iterations.some((it) => it.iteration === p.iteration)) {
        iterations.push({
          iteration: p.iteration,
          maxIterations: p.maxIterations,
          startedAt: p.ts,
          stages: [],
        });
      }
      return { ...state, iterations };
    }

    case 'plan-ready': {
      if (!p.reasoning) return state;
      const iterations = state.iterations.map((it, i) =>
        i === state.iterations.length - 1
          ? { ...it, reasoning: (it.reasoning || '') + (it.reasoning ? '\n' : '') + p.reasoning }
          : it
      );
      return { ...state, iterations };
    }

    case 'stage-start': {
      const iterations = state.iterations.map((it, i) => {
        if (i !== state.iterations.length - 1) return it;
        const stages = [
          ...it.stages,
          {
            id: p.id,
            index: p.index,
            total: p.total,
            mode: p.mode,
            taskCount: p.taskCount,
            startedAt: p.ts,
            tasks: [],
          },
        ];
        return { ...it, stages };
      });
      return { ...state, iterations, currentStageId: p.id };
    }

    case 'task-start': {
      const iterations = state.iterations.map((it, i) => {
        if (i !== state.iterations.length - 1) return it;
        const stages = it.stages.map((st) => {
          if (st.id !== state.currentStageId) return st;
          // 同 taskId 不重复
          if (st.tasks.some((t) => t.taskId === p.taskId)) return st;
          return {
            ...st,
            tasks: [
              ...st.tasks,
              {
                uid: `i${it.iteration}-s${st.id}-${p.taskId}`,
                taskId: p.taskId,
                modelId: p.modelId,
                description: p.description,
                kind: p.kind,
                startedAt: p.ts,
                events: [],
                toolCalls: 0,
                expanded: false,
              },
            ],
          };
        });
        return { ...it, stages };
      });
      return { ...state, iterations };
    }

    case 'task-done': {
      const iterations = updateTask(state.iterations, p.taskId, (t) => ({
        ...t,
        endedAt: p.ts,
        ok: p.ok,
        durationMs: p.durationMs,
        modelUsed: p.modelUsed,
      }));
      return { ...state, iterations };
    }

    case 'tool-call':
    case 'tool-result':
    case 'agent-text':
    case 'context-compaction': {
      const iterations = updateTask(state.iterations, p.taskId, (t) => {
        const entry: TaskEventEntry = {
          kind: e.type as any,
          ts: p.ts,
        };
        if (e.type === 'tool-call') {
          entry.toolName = p.toolName;
          entry.briefArgs = p.briefArgs;
        } else if (e.type === 'tool-result') {
          entry.brief = p.brief;
        } else if (e.type === 'agent-text') {
          entry.brief = p.brief;
        } else if (e.type === 'context-compaction') {
          entry.beforeTokens = p.beforeTokens;
          entry.afterTokens = p.afterTokens;
          entry.keptSteps = p.keptSteps;
        }
        // 事件封顶：只保留最近 MAX_TASK_EVENTS 条，丢弃最早的记入 truncatedEvents
        let events = [...t.events, entry];
        let truncated = t.truncatedEvents ?? 0;
        if (events.length > MAX_TASK_EVENTS) {
          const removed = events.length - MAX_TASK_EVENTS;
          events = events.slice(removed);
          truncated += removed;
        }
        return {
          ...t,
          events,
          truncatedEvents: truncated || undefined,
          toolCalls: t.toolCalls + (e.type === 'tool-call' ? 1 : 0),
        };
      });
      return { ...state, iterations };
    }

    case 'stage-summary': {
      // 没传 stageId，关联到最近 stage
      const iterations = state.iterations.map((it, i) => {
        if (i !== state.iterations.length - 1) return it;
        if (it.stages.length === 0) return it;
        const stages = [...it.stages];
        const lastIdx = stages.length - 1;
        stages[lastIdx] = {
          ...stages[lastIdx],
          summary: { success: p.success, total: p.total },
        };
        return { ...it, stages };
      });
      return { ...state, iterations };
    }

    case 'decision': {
      const iterations = state.iterations.map((it, i) =>
        i === state.iterations.length - 1
          ? {
              ...it,
              decision: {
                shouldContinue: p.shouldContinue,
                qualityScore: p.qualityScore,
                reason: p.reason,
              },
            }
          : it
      );
      return { ...state, iterations };
    }

    case 'final-summary':
      return {
        ...state,
        finalSummary: {
          iterations: p.iterations,
          totalTasks: p.totalTasks,
          qualityScore: p.qualityScore,
          status: p.status,
        },
      };

    case 'final-result':
      return { ...state, finalResult: p.result };

    case 'log': {
      return {
        ...state,
        logs: [
          ...state.logs,
          {
            level: p.level,
            message: p.message,
            detailsPath: p.detailsPath,
            ts: p.ts,
          },
        ],
      };
    }

    default:
      return state;
  }
}

function updateTask(
  iterations: IterationEntry[],
  taskId: string,
  fn: (t: TaskEntry) => TaskEntry
): IterationEntry[] {
  // 事件只携带 taskId，但不同迭代会复用同名 taskId（"task-1"、"task-2"...）。
  // 迭代严格串行执行，事件必然属于「最新一次」出现的该 task——
  // 所以只更新最后一个匹配项，避免上一轮已完成任务的 events/状态被下一轮事件污染。
  for (let i = iterations.length - 1; i >= 0; i--) {
    const it = iterations[i];
    for (let j = it.stages.length - 1; j >= 0; j--) {
      const st = it.stages[j];
      for (let k = st.tasks.length - 1; k >= 0; k--) {
        if (st.tasks[k].taskId === taskId) {
          const newTasks = [...st.tasks];
          newTasks[k] = fn(st.tasks[k]);
          const newStages = [...it.stages];
          newStages[j] = { ...st, tasks: newTasks };
          const newIters = [...iterations];
          newIters[i] = { ...it, stages: newStages };
          return newIters;
        }
      }
    }
  }
  return iterations;
}

/**
 * 订阅事件总线，返回当前 TUI 状态
 */
export function useTuiState(): TuiState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const types: UiEvent['type'][] = [
      'banner',
      'request',
      'iteration-start',
      'plan-ready',
      'stage-start',
      'task-start',
      'task-done',
      'tool-call',
      'tool-result',
      'agent-text',
      'context-compaction',
      'stage-summary',
      'decision',
      'final-summary',
      'final-result',
      'log',
    ];
    const subscriptions = types.map((type) => {
      const listener = (payload: any) => {
        dispatch({ type: 'event', event: { type, payload } as UiEvent });
      };
      bus.on(type, listener);
      return { type, listener };
    });
    return () => {
      subscriptions.forEach(({ type, listener }) => bus.off(type, listener));
    };
  }, []);

  return state;
}

/**
 * 切换某个 task 实例的展开状态
 *
 * 用 uid（全局唯一）匹配，而不是 taskId——不同迭代可能有同名 task-1，
 * 用 taskId 会把所有轮的 task-1 都展开。
 */
export function toggleTask(state: TuiState, uid: string): TuiState {
  const iterations = state.iterations.map((it) => ({
    ...it,
    stages: it.stages.map((st) => ({
      ...st,
      tasks: st.tasks.map((t) =>
        t.uid === uid ? { ...t, expanded: !t.expanded } : t
      ),
    })),
  }));
  return {
    ...state,
    iterations,
    selectedTaskId: state.selectedTaskId === uid ? undefined : uid,
  };
}
