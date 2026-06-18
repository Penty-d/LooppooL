import { ExecutionPlan, ExecutionResult, Task } from '../types';
import { TaskExecutor } from '../agents';
import { ModelRegistry } from '../execution/model-registry';
import {
  logStage,
  logTaskStart,
  logTaskDone,
  logTaskError,
  logStageSummary,
  logCriticalAbort,
} from '../ui';

/**
 * 任务池 —— 负责按阶段调度任务执行
 *
 * 并发模型（你强调的重点）：
 *   - serial 阶段：任务有依赖，严格顺序执行。
 *   - parallel 阶段：任务互不关联，可分给不同模型同时跑。但要尊重
 *     每个模型的并发能力：
 *       · concurrent: true  的模型——可同时承担多个任务（受全局上限约束）
 *       · concurrent: false 的模型——同一时刻只能跑一个任务，但不阻塞其他模型
 *
 *   实现方式：并行阶段用一个「动态调度循环」——不断挑出当前可以启动的任务
 *   （该任务对应模型未达到自身并发上限、且总并发未超全局上限）启动，
 *   有任务完成就回收名额再调度，直到全部完成。
 */
export class TaskPool {
  private executor: TaskExecutor;
  private registry: ModelRegistry;
  private globalParallelLimit: number;

  constructor(
    executor: TaskExecutor,
    registry: ModelRegistry,
    globalParallelLimit: number = 10
  ) {
    this.executor = executor;
    this.registry = registry;
    this.globalParallelLimit = globalParallelLimit;
  }

  /** 执行完整的执行计划 */
  async executePlan(plan: ExecutionPlan): Promise<Map<string, ExecutionResult>> {
    const allResults = new Map<string, ExecutionResult>();

    for (let i = 0; i < plan.stages.length; i++) {
      const stage = plan.stages[i];
      logStage(i + 1, plan.stages.length, stage.id, stage.mode, stage.tasks.length);

      const stageResults =
        stage.mode === 'parallel'
          ? await this.executeParallel(stage.tasks)
          : await this.executeSerial(stage.tasks);

      stageResults.forEach((result, taskId) => allResults.set(taskId, result));

      const success = Array.from(stageResults.values()).filter((r) => r.status === 'success').length;
      logStageSummary(success, stageResults.size);

      if (this.checkCriticalFailure(stageResults)) {
        logCriticalAbort();
        break;
      }
    }

    return allResults;
  }

  /**
   * 并行执行（按模型并发能力动态调度）
   *
   * 维护两个计数：
   *   - running:        当前总在跑的任务数（受 globalParallelLimit 约束）
   *   - perModelRunning: 每个模型当前在跑的任务数（concurrent:false 时上限为 1）
   */
  private async executeParallel(tasks: Task[]): Promise<Map<string, ExecutionResult>> {
    const results = new Map<string, ExecutionResult>();
    const pending = [...tasks];
    const perModelRunning = new Map<string, number>(); // key: provider:modelId
    let running = 0;

    return new Promise((resolve) => {
      const tryDispatch = () => {
        // 全部完成
        if (results.size === tasks.length && running === 0) {
          resolve(results);
          return;
        }

        // 尝试从 pending 中挑出可以启动的任务
        for (let i = 0; i < pending.length; ) {
          if (running >= this.globalParallelLimit) break;

          const task = pending[i];
          const model = this.safeResolveConcurrency(task);
          const key = model.key;
          const inFlight = perModelRunning.get(key) || 0;

          // 该模型不支持并发且已有任务在跑 → 跳过，留待下次调度
          if (!model.concurrent && inFlight >= 1) {
            i++;
            continue;
          }

          // 启动该任务
          pending.splice(i, 1);
          running++;
          perModelRunning.set(key, inFlight + 1);

          this.executeTaskWithLogging(task)
            .then((result) => {
              results.set(task.id, result);
            })
            .catch((error) => {
              results.set(task.id, this.toFailure(task, error));
            })
            .finally(() => {
              running--;
              perModelRunning.set(key, (perModelRunning.get(key) || 1) - 1);
              tryDispatch();
            });
          // 不递增 i：splice 后当前下标已是下一个任务
        }
      };

      tryDispatch();
    });
  }

  /** 串行执行 */
  private async executeSerial(tasks: Task[]): Promise<Map<string, ExecutionResult>> {
    const results = new Map<string, ExecutionResult>();

    for (const task of tasks) {
      const result = await this.executeTaskWithLogging(task);
      results.set(task.id, result);

      if (result.status === 'failed' && !task.retryable) {
        break;
      }
    }

    return results;
  }

  /**
   * 解析任务对应模型的并发能力（解析失败按可并发处理，避免卡死调度）
   *
   * 并发名额按「模型条目 id」隔离：同一条目的任务共享并发上限，
   * 不同条目互不影响——即使它们底层指向同一供应商。
   */
  private safeResolveConcurrency(task: Task): { key: string; concurrent: boolean } {
    try {
      const m = this.registry.resolve(task.model);
      return { key: m.id, concurrent: m.concurrent };
    } catch {
      return { key: `unknown:${task.model}`, concurrent: true };
    }
  }

  private async executeTaskWithLogging(task: Task): Promise<ExecutionResult> {
    logTaskStart(task.id, task.model, task.description, task.kind);

    try {
      const result = await this.executor.execute(task);
      logTaskDone(
        task.id,
        result.status === 'success',
        result.metrics.duration,
        result.metrics.modelUsed
      );
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logTaskError(task.id, msg);
      return this.toFailure(task, error);
    }
  }

  private toFailure(task: Task, error: unknown): ExecutionResult {
    return {
      taskId: task.id,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      metrics: {
        startTime: new Date(),
        endTime: new Date(),
        duration: 0,
        modelUsed: 'unknown',
        model: task.model,
      },
    };
  }

  private checkCriticalFailure(results: Map<string, ExecutionResult>): boolean {
    for (const result of results.values()) {
      if (result.status === 'failed') return true;
    }
    return false;
  }
}
