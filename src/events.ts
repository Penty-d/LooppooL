import { EventEmitter } from 'events';

/**
 * UI 事件总线
 *
 * 所有 ui.ts 函数不再直接 console.log，而是 emit 一个事件。
 * TUI（Ink 组件）订阅这些事件、更新 React state。
 *
 * 这样 ui.ts 的调用方（looppool / orchestrator / task-pool / agent-engine）
 * 完全不感知渲染层——它们只"报告发生了什么"，怎么显示是 TUI 的事。
 *
 * 事件设计原则：每个事件携带足够让 TUI 重建画面的信息，
 * 不依赖事件到达顺序（并发时序乱），靠 id 关联。
 */

export type TaskKind = 'execute' | 'validate';

export interface ToolCallEvent {
  taskId: string;
  toolName: string;
  briefArgs: string;
  ts: number;
}

export interface ToolResultEvent {
  taskId: string;
  brief: string;
  ts: number;
}

export interface AgentTextEvent {
  taskId: string;
  brief: string;
  ts: number;
}

export interface ContextCompactionEvent {
  taskId: string;
  beforeTokens: number;
  afterTokens: number;
  keptSteps: number;
  ts: number;
}

/** 上下文压缩时用摘要模型把老对话压成工作摘要（F1） */
export interface ContextSummarizedEvent {
  taskId: string;
  beforeTokens: number;
  afterTokens: number;
  ts: number;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEvent {
  level: LogLevel;
  message: string;
  detailsPath?: string;
  ts: number;
}

/** 人工确认请求（计划审批 / 危险命令确认）。响应走 confirm.ts 的 respondConfirm，不经过事件总线。 */
export interface UserConfirmEvent {
  id: string;
  message: string;
  ts: number;
}

export interface IterationStartEvent {
  iteration: number;
  maxIterations: number;
  ts: number;
}

export interface PlanReadyEvent {
  stages: number;
  tasks: number;
  reasoning: string;
  ts: number;
}

export interface StageStartEvent {
  index: number;
  total: number;
  id: string;
  mode: 'parallel' | 'serial';
  taskCount: number;
  ts: number;
}

export interface StageSummaryEvent {
  stageId: string;
  success: number;
  total: number;
  ts: number;
}

export interface TaskStartEvent {
  taskId: string;
  modelId: string;
  description: string;
  kind: TaskKind;
  ts: number;
}

export interface TaskDoneEvent {
  taskId: string;
  ok: boolean;
  durationMs: number;
  modelUsed: string;
  /** 本次任务消耗的 token 数（可观测性用） */
  tokensUsed?: number;
  /** 本次任务成本 USD（可观测性用） */
  costUSD?: number;
  ts: number;
}

export interface DecisionEvent {
  shouldContinue: boolean;
  qualityScore: number;
  reason: string;
  ts: number;
}

export interface FinalSummaryEvent {
  iterations: number;
  totalTasks: number;
  qualityScore?: number;
  status: 'completed' | 'partial';
  ts: number;
}

export interface FinalResultEvent {
  result: any;
  ts: number;
}

export interface RequestEvent {
  request: string;
  ts: number;
}

export interface BannerEvent {
  ts: number;
}

/** 所有事件类型的并集，便于 TUI 做统一 reducer */
export type UiEvent =
  | { type: 'banner'; payload: BannerEvent }
  | { type: 'request'; payload: RequestEvent }
  | { type: 'iteration-start'; payload: IterationStartEvent }
  | { type: 'plan-ready'; payload: PlanReadyEvent }
  | { type: 'stage-start'; payload: StageStartEvent }
  | { type: 'stage-summary'; payload: StageSummaryEvent }
  | { type: 'task-start'; payload: TaskStartEvent }
  | { type: 'task-done'; payload: TaskDoneEvent }
  | { type: 'tool-call'; payload: ToolCallEvent }
  | { type: 'tool-result'; payload: ToolResultEvent }
  | { type: 'agent-text'; payload: AgentTextEvent }
  | { type: 'context-compaction'; payload: ContextCompactionEvent }
  | { type: 'decision'; payload: DecisionEvent }
  | { type: 'final-summary'; payload: FinalSummaryEvent }
  | { type: 'final-result'; payload: FinalResultEvent }
  | { type: 'log'; payload: LogEvent }
  | { type: 'user-confirm'; payload: UserConfirmEvent }
  | { type: 'context-summarized'; payload: ContextSummarizedEvent };

/** 全部事件类型（供 RequestLog 订阅 / useTuiState 对齐；新事件必须加进这个列表） */
export const ALL_EVENT_TYPES: UiEvent['type'][] = [
  'banner',
  'request',
  'iteration-start',
  'plan-ready',
  'stage-start',
  'stage-summary',
  'task-start',
  'task-done',
  'tool-call',
  'tool-result',
  'agent-text',
  'context-compaction',
  'context-summarized',
  'decision',
  'final-summary',
  'final-result',
  'log',
  'user-confirm',
];

class UiEventBus extends EventEmitter {
  emit(type: UiEvent['type'], payload: any): boolean {
    return super.emit(type, payload);
  }

  on(type: UiEvent['type'], listener: (payload: any) => void): this {
    return super.on(type, listener);
  }

  off(type: UiEvent['type'], listener: (payload: any) => void): this {
    super.removeListener(type, listener);
    return this;
  }

  /** 发任意事件，给 ui.ts 用 */
  dispatch(event: UiEvent): void {
    this.emit(event.type, event.payload);
  }
}

export const bus = new UiEventBus();

export function now(): number {
  return Date.now();
}
