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
  logTaskRetry,
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
  private taskRetries: number;
  /** 运行中任务的 AbortController，供 cancelTask 中止 */
  private runningControllers = new Map<string, AbortController>();
  /** 已被用户取消的任务 id（取消不自动重试） */
  private canceled = new Set<string>();
  /** 任务池暂停标志（暂停 = 不再启动新任务，不中断运行中的任务） */
  private paused = false;

  constructor(
    executor: TaskExecutor,
    registry: ModelRegistry,
    globalParallelLimit: number = 10,
    taskRetries: number = 1
  ) {
    this.executor = executor;
    this.registry = registry;
    this.globalParallelLimit = globalParallelLimit;
    this.taskRetries = taskRetries;
  }

  /** 执行完整的执行计划 */
  async executePlan(plan: ExecutionPlan): Promise<Map<string, ExecutionResult>> {
    const allResults = new Map<string, ExecutionResult>();
    this.canceled.clear(); // 防止上一轮取消误伤本轮同名任务

    for (let i = 0; i < plan.stages.length; i++) {
      await this.waitIfPaused(); // 暂停时不再启动新 stage
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
    // 已结束的任务数（含失败）。不能用 results.size 判断完成——
    // 若调度器输出了重复 task id，results.set 会覆盖导致 size 永远小于 tasks.length，
    // 完成条件永不满足 → Promise 永不 resolve → 进程挂死。
    let completed = 0;

    return new Promise((resolve) => {
      const tryDispatch = async () => {
        await this.waitIfPaused();

        // 全部完成（按已结束任务数判断，不受重复 id 影响）
        if (completed === tasks.length && running === 0) {
          resolve(results);
          return;
        }

        // 尝试从 pending 中挑出可以启动的任务
        for (let i = 0; i < pending.length; ) {
          if (running >= this.globalParallelLimit) break;

          const task = pending[i];

          // 已被取消的任务：直接标记失败，不入队执行
          if (this.canceled.has(task.id)) {
            this.canceled.delete(task.id);
            const err = new Error(`任务 ${task.id} 已被用户取消`);
            results.set(task.id, this.toFailure(task, err));
            logTaskDone(task.id, false, 0, 'unknown');
            pending.splice(i, 1);
            completed++;
            continue; // splice 后当前下标已是下一个任务
          }

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

          this.executeTaskWithRetries(task)
            .then((result) => {
              results.set(task.id, result);
            })
            .catch((error) => {
              results.set(task.id, this.toFailure(task, error));
            })
            .finally(() => {
              running--;
              completed++;
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
      await this.waitIfPaused();

      // 已被取消的任务：标记失败后断链
      if (this.canceled.has(task.id)) {
        this.canceled.delete(task.id);
        const err = new Error(`任务 ${task.id} 已被用户取消`);
        results.set(task.id, this.toFailure(task, err));
        logTaskDone(task.id, false, 0, 'unknown');
        break;
      }

      const result = await this.executeTaskWithRetries(task);
      results.set(task.id, result);

      // 最终尝试仍失败 → 断链（后续任务有依赖，继续无意义）
      if (result.status === 'failed') {
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

  private async executeTaskWithLogging(
    task: Task,
    signal?: AbortSignal
  ): Promise<ExecutionResult> {
    logTaskStart(task.id, task.model, task.description, task.kind);

    try {
      const result = await this.executor.execute(task, signal);
      logTaskDone(
        task.id,
        result.status === 'success',
        result.metrics.duration,
        result.metrics.modelUsed,
        result.metrics.tokensUsed,
        result.metrics.costUSD
      );
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logTaskError(task.id, msg);
      // 执行抛错（validate 缺目标 / abort 等）也必须发 task-done，
      // 否则 TUI 里该任务永远显示"运行中"
      logTaskDone(task.id, false, 0, task.model);
      return this.toFailure(task, error);
    }
  }

  /**
   * 执行任务并带失败重试（指数退避 1s/2s/4s…）。
   * retryable === false → 只尝试一次（显式不重试）；否则最多 1 + taskRetries 次。
   * 每次尝试挂在 runningControllers 上，取消可中止进行中的请求。
   */
  private async executeTaskWithRetries(task: Task): Promise<ExecutionResult> {
    const maxAttempts = task.retryable === false ? 1 : 1 + this.taskRetries;
    let result: ExecutionResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      this.runningControllers.set(task.id, controller);
      try {
        result = await this.executeTaskWithLogging(task, controller.signal);
      } finally {
        this.runningControllers.delete(task.id);
      }

      // 用户取消：不自动重试，直接结束
      if (this.canceled.has(task.id)) {
        this.canceled.delete(task.id);
        break;
      }

      if (result.status !== 'failed' || attempt === maxAttempts) {
        return result;
      }
      const delayMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s...
      logTaskRetry(task.id, result.error ?? '未知错误', attempt, maxAttempts, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    return result!;
  }

  /**
   * 取消一个运行中的任务（后续不自动重试）。
   * 未启动（还在 pending）的任务由派发循环消费；已启动的任务通过 abort 中止。
   */
  cancelTask(taskId: string): void {
    this.canceled.add(taskId); // 先标记，保证重试/派发检查一定能看到
    this.runningControllers.get(taskId)?.abort();
  }

  /** 暂停任务池：不再启动新任务（不中断运行中的任务） */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** 暂停时等待恢复（轮询 200ms） */
  private async waitIfPaused(): Promise<void> {
    while (this.paused) {
      await new Promise((r) => setTimeout(r, 200));
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
