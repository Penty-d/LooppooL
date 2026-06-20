import { Task, ExecutionResult } from '../types';
import { ModelRegistry } from '../execution/model-registry';
import { AgentEngine } from '../execution/agent-engine';

/**
 * 任务执行器
 *
 * 新架构中不再有「命名 Agent 库」。每个任务自带：
 *   - model:  调度器从可用模型清单中挑中的模型条目 id → 由 ModelRegistry 解析为具体模型
 *   - prompt: 调度器现场编写的完整指令
 *
 * 执行器只做三件事：
 *   1) 验收任务（validate）：把目标任务的结果注入 prompt
 *   2) model id → 模型解析
 *   3) 走 AgentEngine（Vercel AI SDK + tool loop）执行，缓存结果供后续验收引用
 */
export class TaskExecutor {
  private registry: ModelRegistry;
  private engine: AgentEngine;
  private resultCache: Map<string, ExecutionResult> = new Map();
  /** 记录每个 task 的 workdir，validate 任务可复用被验收任务的 workdir */
  private workdirCache: Map<string, string> = new Map();

  constructor(registry: ModelRegistry, timeoutDefault: number = 1800000) {
    this.registry = registry;
    this.engine = new AgentEngine({ timeoutDefault });
  }

  async execute(task: Task): Promise<ExecutionResult> {
    const preparedTask = this.prepareTask(task);
    const model = this.registry.resolve(preparedTask.model);
    const result = await this.engine.run(preparedTask, model);

    this.resultCache.set(task.id, result);
    // 记录 workdir，供 validate 任务复用
    if (preparedTask.workdir) {
      this.workdirCache.set(task.id, preparedTask.workdir);
    }
    return result;
  }

  /**
   * 验收任务准备：把目标任务的输出拼进 prompt，并复用其 workdir
   *
   * validate 任务默认不指定 workdir 时，复用被验收任务的 workdir——
   * 这样验收 agent 能直接 read_file 被验收的产物，不用绕 bash。
   */
  private prepareTask(task: Task): Task {
    if (task.kind !== 'validate' || !task.input?.targetTaskId) {
      return task;
    }

    const target = this.resultCache.get(task.input.targetTaskId);
    if (!target) {
      throw new Error(`验收任务 ${task.id} 找不到目标任务 ${task.input.targetTaskId} 的结果`);
    }

    const criteria = task.input.criteria?.length
      ? `\n\n验收标准：\n${task.input.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';

    const augmentedPrompt =
      `${task.prompt}\n\n` +
      `======== 被验收任务（${task.input.targetTaskId}）的执行结果 ========\n` +
      `${typeof target.output === 'string' ? target.output : JSON.stringify(target.output, null, 2)}` +
      criteria;

    // validate 任务未显式指定 workdir 时，复用被验收任务的 workdir
    const targetWorkdir = this.workdirCache.get(task.input.targetTaskId);
    const workdir = task.workdir ?? targetWorkdir;

    return { ...task, prompt: augmentedPrompt, workdir };
  }

  getTaskResult(taskId: string): ExecutionResult | undefined {
    return this.resultCache.get(taskId);
  }

  clearCache(): void {
    this.resultCache.clear();
  }
}
