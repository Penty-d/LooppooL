// ============================================================
// 架构概览（双路径）
//   调度器 orchestrator  → 直连 Anthropic API（手写 fetch）→ 返回 JSON 计划/决策
//   执行/验收 task        → 走 AgentEngine（Vercel AI SDK + 工具集）→ 返回富文本结果
// 配置：models.json（含真实 key，已 gitignore）定义调度器 + 分级模型库 + 供应商
// ============================================================

// ============ 模型等级 ============

/** 模型的智能等级标注，供调度器按任务难度挑选合适的模型 */
export type ModelTier = 'high' | 'medium' | 'low';

// ============ 任务相关 ============

export interface Task {
  id: string;

  /** execute = 通过工具集（bash/读写文件/检索）执行实际工作；validate = 对某个任务结果做验收 */
  kind: 'execute' | 'validate';

  /** 简短描述，用于日志 */
  description: string;

  /**
   * 调度器从「可用模型清单」中为该任务挑中的模型条目 id
   * （对应 ModelEntry.id，不是底层模型名）
   */
  model: string;

  /** 调度器现场为该任务编写的完整指令（传给执行模型，用户不需要写） */
  prompt: string;

  /** 附加输入 */
  input?: {
    /** validate 任务：要验收的目标任务 ID */
    targetTaskId?: string;
    /** 验收标准 */
    criteria?: string[];
    [key: string]: any;
  };

  // 元数据
  timeout?: number;
  retryable?: boolean;
}

export interface ValidationIssue {
  severity: 'critical' | 'major' | 'minor';
  description: string;
  location?: string;
  recommendation: string;
}

export interface ExecutionResult {
  taskId: string;
  status: 'success' | 'failed' | 'partial';
  output?: any;
  error?: string;

  metrics: {
    startTime: Date;
    endTime: Date;
    duration: number;
    tokensUsed?: number;
    /** 实际请求 API 时使用的底层模型名 */
    modelUsed: string;
    /** 调度器挑中的模型条目 id（对应 ModelEntry.id） */
    model?: string;
    /** 该模型的等级标注，便于分析 */
    tier?: ModelTier;
    passed?: boolean;
    score?: number; // 0-100
    issues?: ValidationIssue[];
    suggestions?: string[];
  };
}

// ============ 计划相关 ============

export interface Stage {
  id: string;
  /**
   * parallel: stage 内任务互不关联，可分给不同模型并行
   * serial:   stage 内任务有先后依赖，顺序执行
   */
  mode: 'parallel' | 'serial';
  tasks: Task[];
}

export interface ExecutionPlan {
  reasoning: string;
  stages: Stage[];
  estimatedTime?: number;
  createdAt: Date;
}

// ============ 决策相关 ============

export interface Decision {
  shouldContinue: boolean;
  reason: string;
  qualityScore: number; // 0-100

  newPlan?: ExecutionPlan;

  finalResult?: {
    summary: string;
    outputs: Record<string, any>;
    metadata: {
      totalIterations: number;
      totalTasks: number;
      totalTime: number;
    };
  };
}

export interface IterationRecord {
  iteration: number;
  plan: ExecutionPlan;
  results: Map<string, ExecutionResult>;
  decision: Decision;
  timestamp: Date;
}

export interface Context {
  requestId: string;
  userRequest: string;
  history: IterationRecord[];
  accumulatedResults: Map<string, ExecutionResult>;
  userContext?: any;
}

// ============ 模型库配置（models.json） ============

/** 鉴权方式：api-key 写入 ANTHROPIC_API_KEY；bearer 写入 ANTHROPIC_AUTH_TOKEN（兼容网关） */
export type AuthMode = 'api-key' | 'bearer';

/** 供应商：端点 + 密钥 + 鉴权方式（供 AgentEngine 调用模型 API 时使用） */
export interface ProviderConfig {
  /** Anthropic 兼容端点，注入为 ANTHROPIC_BASE_URL；非 Anthropic 供应商需指向翻译网关 */
  baseURL: string;
  /** 密钥（写在配置文件里，文件已 gitignore） */
  apiKey: string;
  /** 缺省按 claude=api-key、其它=bearer 推断 */
  authMode?: AuthMode;
}

/**
 * 模型条目：配置的主体单位
 *
 * 用户配的是一份「模型清单」，给每个模型标注智能等级 tier。
 * 同一等级可以有多个模型；某个等级也可以一个都没有。
 * 调度器拿到整份清单，自己为每个任务挑选合适的模型条目。
 */
export interface ModelEntry {
  /** 模型条目唯一 id（调度器在计划里用它指认模型，建议用易读名如 "sonnet"、"local-qwen"） */
  id: string;
  /** 智能等级标注，供调度器按任务难度挑选 */
  tier: ModelTier;
  /** 供应商标识，对应 providers 中的键 */
  provider: string;
  /** 底层模型 ID，作为 model 字段传给 /v1/messages 请求 */
  modelId: string;
  /** 该模型是否支持并发，缺省 true */
  concurrent?: boolean;
  /** 可选的一句话说明，写进给调度器的清单，帮助它挑选 */
  note?: string;
}

/**
 * 调度器配置：项目直连「Anthropic Messages API 协议」端点
 *
 * 注意：这里依赖的是协议格式，不绑定 Anthropic 官方。
 * baseURL 指向任意兼容网关（LiteLLM / claude-code-router 等）即可用别家模型驱动调度器。
 */
export interface OrchestratorConfig {
  /** 兼容端点，缺省 https://api.anthropic.com；指向网关即可换模型 */
  baseURL?: string;
  /** 密钥 / 令牌 */
  apiKey: string;
  /** 调度器模型 ID */
  modelId: string;
  /**
   * 鉴权方式：
   * - api-key: 走 x-api-key 头（Anthropic 原生）
   * - bearer:  走 Authorization: Bearer（多数兼容网关）
   * 缺省按 baseURL 推断：官方域名 → api-key，其它 → bearer
   */
  authMode?: AuthMode;
  /** 单次响应最大 token，缺省 8192 */
  maxTokens?: number;
}

/** models.json 顶层结构 */
export interface ModelsConfig {
  orchestrator: OrchestratorConfig;
  /** 可用模型清单（配置主体）；调度器从中为每个任务挑选 */
  models: ModelEntry[];
  providers: Record<string, ProviderConfig>;
}

// ============ 系统配置（config.json） ============

export interface SystemConfig {
  maxIterations: number;
  taskTimeout: number;
  globalParallelLimit: number;
  validationThreshold: number;
}

export interface Config {
  system: SystemConfig;
  logging: {
    level: string;
    outputs: string[];
    filePath: string;
  };
  storage: {
    persistHistory: boolean;
    historyPath: string;
  };
}
