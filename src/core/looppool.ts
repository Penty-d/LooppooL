import {
  Context,
  Decision,
  ExecutionPlan,
  ExecutionResult,
  IterationRecord,
  Config,
  ModelsConfig,
  ApprovalMode,
} from '../types';
import { TaskExecutor } from '../agents';
import { ModelRegistry } from '../execution/model-registry';
import { AnthropicClient } from '../llm';
import { Orchestrator } from './orchestrator';
import { TaskPool } from './task-pool';
import { CheckpointStore, CheckpointStatus } from '../storage';
import { requestConfirm } from '../confirm';
import { PlanRejectedError } from '../errors';
import { requestLog } from '../observability';
import { loadRunLog, appendRunLog } from '../run-log';
import {
  logIteration,
  logError,
  printFinalSummary,
  logPlanReady,
  logReasoning,
  logStage,
  logTaskStart,
  logTaskDone,
  logStageSummary,
  logDecision,
  logBudgetExceeded,
} from '../ui';

/** LoopPool 构造选项（CLI 覆盖用） */
export interface LoopPoolOptions {
  /** 计划审批模式覆盖（--approve/--no-approve）；优先于 config */
  approvalMode?: ApprovalMode;
  /** 成本预算覆盖（--budget）；优先于 config */
  budgetUSD?: number;
  /** 项目运行日志 key 覆盖（--project）；优先于 config */
  projectKey?: string;
}

export class LoopPool {
  private config: Config;
  private models: ModelsConfig;
  private orchestrator: Orchestrator;
  private taskPool: TaskPool;
  private executor: TaskExecutor;
  private approvalMode: ApprovalMode;
  private budgetUSD: number;
  private projectKey?: string;

  /**
   * 检查点存储：config.storage.persistHistory=false 时为 null（不落盘、不可恢复）。
   * resume() 与 CLI 的 --resume 依赖它。
   */
  public readonly checkpointStore: CheckpointStore | null;

  constructor(config: Config, models: ModelsConfig, options: LoopPoolOptions = {}) {
    this.config = config;
    this.models = models;

    // 审批模式 / 成本预算 / 运行日志 key：CLI 覆盖 > config > 默认
    this.approvalMode = options.approvalMode ?? config.system.approvalMode ?? 'none';
    this.budgetUSD = options.budgetUSD ?? config.system.budgetUSD ?? 0;
    this.projectKey = options.projectKey ?? config.storage.projectKey;

    // 模型库：把模型条目 id 解析为具体模型（含并发能力）；并向调度器提供可用模型清单
    const registry = new ModelRegistry(models);

    // 执行器：所有 execute/validate 任务走 AgentEngine（Vercel AI SDK + 工具集）
    this.executor = new TaskExecutor(registry, config.system.taskTimeout, {
      dangerousShell: config.system.dangerousShell,
    });

    // 调度器：直连 Anthropic 协议端点（手写 fetch），返回结构化 JSON
    const client = new AnthropicClient(models.orchestrator);
    this.orchestrator = new Orchestrator(client, registry, { budgetUSD: this.budgetUSD });

    // 任务池：按模型并发能力调度并行/串行，失败任务自动重试 taskRetries 次
    this.taskPool = new TaskPool(
      this.executor,
      registry,
      config.system.globalParallelLimit,
      config.system.taskRetries
    );

    // 断点持久化：尊重 persistHistory 开关
    this.checkpointStore = config.storage.persistHistory
      ? new CheckpointStore(config.storage.historyPath)
      : null;
  }

  /**
   * 执行用户请求（全新 run）
   * @param requestId 可选，供 CLI/测试注入；缺省自动生成
   */
  async execute(userRequest: string, userContext?: any, requestId?: string): Promise<any> {
    // 记录启动时间，用于最终结果的真实耗时统计（totalTime 由系统实测，而非 LLM 编造）
    const startedAt = Date.now();

    // 初始化上下文
    const context: Context = {
      requestId: requestId ?? this.generateRequestId(),
      userRequest,
      history: [],
      accumulatedResults: new Map(),
      userContext,
    };

    // NDJSON 请求日志：整次 run 的事件流落盘
    requestLog.start(context.requestId);
    try {
      return await this.runLoop({ context, startedAt, iteration: 0, pendingPlan: undefined });
    } finally {
      requestLog.stop();
    }
  }

  /**
   * 从断点恢复一个未完成的 run
   */
  async resume(requestId: string): Promise<any> {
    if (!this.checkpointStore) {
      throw new Error('config.storage.persistHistory=false，未持久化检查点，无法恢复');
    }

    const ckpt = this.checkpointStore.load(requestId);
    if (!ckpt) {
      throw new Error(`检查点不存在或已损坏: ${requestId}`);
    }
    if (ckpt.status === 'completed') {
      throw new Error(`该任务已完成，无需恢复: ${requestId}`);
    }

    const context: Context = {
      requestId: ckpt.requestId,
      userRequest: ckpt.userRequest,
      history: ckpt.history,
      accumulatedResults: ckpt.accumulatedResults,
      userContext: ckpt.userContext,
    };

    // 回灌结果缓存：恢复后的 validate 任务要能查到崩溃前的 targetTaskId
    this.executor.seedResults(context.accumulatedResults);

    // 先把历史迭代折叠重放到 TUI，再继续流式跑新迭代
    this.replayHistory(context.history);

    requestLog.start(context.requestId);
    try {
      return await this.runLoop({
        context,
        startedAt: ckpt.startedAt, // 沿用原 startedAt，totalTime 跨崩溃累计
        iteration: context.history.length,
        pendingPlan: ckpt.pendingPlan,
      });
    } finally {
      requestLog.stop();
    }
  }

  /** 取消一个运行中的任务（TUI 的 c 键） */
  cancelTask(taskId: string): void {
    this.taskPool.cancelTask(taskId);
  }

  /** 暂停任务池：不再启动新任务（TUI 的 p 键） */
  pausePool(): void {
    this.taskPool.pause();
  }

  resumePool(): void {
    this.taskPool.resume();
  }

  /**
   * 主循环（fresh 与 resume 共用）
   * @param iteration 已完成的迭代数（fresh=0，resume=history.length）；
   *                  循环顶部 ++，故本轮迭代号 = iteration+1，
   *                  正好对上 orchestrator 里 context.history.length + 1 的 dump key / prompt 计数
   */
  private async runLoop(opts: {
    context: Context;
    startedAt: number;
    iteration: number;
    pendingPlan?: ExecutionPlan;
  }): Promise<any> {
    const { context, startedAt } = opts;
    let iteration = opts.iteration;
    let pendingPlan = opts.pendingPlan;

    const maxIterations = this.config.system.maxIterations;
    // 连续失败熔断：连续 N 次迭代抛错即停止（说明存在稳定故障，重试不会变好）
    const MAX_CONSECUTIVE_FAILURES = 3;
    let consecutiveFailures = 0;

    while (iteration < maxIterations) {
      iteration++;
      logIteration(iteration, maxIterations);

      try {
        // 1. 生成执行计划：第二轮起优先用上轮决策给的 newPlan（基于 agent output 写的）
        //    没有时才回退到 generatePlan（重新规划，但上下文比 newPlan 弱）
        const plan = pendingPlan
          ? this.adoptPendingPlan(pendingPlan)
          : await this.orchestrator.generatePlan(context);
        pendingPlan = undefined;

        const taskCount = plan.stages.reduce((s, st) => s + st.tasks.length, 0);

        // 防"无限空迭代"：plan 里一个 task 都没有，直接报错退出
        if (taskCount === 0) {
          throw new Error(
            `调度器生成的计划没有任何任务（stages=${plan.stages.length}），无法执行。` +
            `可能是调度器输出格式异常，查看 .looppool-logs/${context.requestId}/ 下的 plan-raw-* 文件`
          );
        }

        // 计划审批：按模式在计划产出后、执行前征询用户（否决 → PlanRejectedError 中止）
        if (this.shouldRequestApproval(iteration)) {
          const approved = await this.askApproval(plan, context, iteration);
          if (!approved) throw new PlanRejectedError();
        }

        // 2. 执行计划
        const results = await this.taskPool.executePlan(plan);

        // 累积结果
        results.forEach((result, taskId) => {
          context.accumulatedResults.set(taskId, result);
        });

        // 3. 分析结果并决策
        const decision = await this.orchestrator.analyzeAndDecide(
          context,
          plan,
          results
        );

        // 记录历史
        context.history.push({
          iteration,
          plan,
          results,
          decision,
          timestamp: new Date(),
        });

        // 4. 根据决策判断是否继续
        if (!decision.shouldContinue) {
          this.checkpoint(context, {
            pendingPlan: undefined,
            startedAt,
            status: 'completed',
          });
          printFinalSummary({
            status: 'completed',
            iterations: iteration,
            totalTasks: context.accumulatedResults.size,
            qualityScore: decision.qualityScore,
          });
          const finalResult = this.formatFinalResult(decision, context, startedAt);
          this.logRun(context, { status: 'completed', result: finalResult });
          return finalResult;
        }

        // 成本预算硬停：只有"模型说继续但已超预算"才强制停
        // （预算内"完成"仍走上面的 completed 分支；无价格数据 costUSD=undefined 当 0，不误触）
        if (this.budgetUSD > 0) {
          const spent = this.totalCostUSD(context) ?? 0;
          if (spent > this.budgetUSD) {
            logBudgetExceeded(spent, this.budgetUSD);
            this.checkpoint(context, {
              pendingPlan: undefined,
              startedAt,
              status: 'completed',
            });
            printFinalSummary({
              status: 'partial',
              iterations: iteration,
              totalTasks: context.accumulatedResults.size,
              qualityScore: context.history[context.history.length - 1]?.decision.qualityScore,
            });
            const partialResult = this.formatPartialResult(context, startedAt);
            this.logRun(context, { status: 'partial', result: partialResult });
            return partialResult;
          }
        }

        // 决策决定继续：把 newPlan 暂存到下一轮采用
        // 这样下一轮的 plan 直接基于本轮 agent output（事实），不再重新 generatePlan
        if (decision.newPlan && decision.newPlan.stages?.length > 0) {
          pendingPlan = decision.newPlan;
        }

        // 本轮完整成功，清零连续失败计数
        consecutiveFailures = 0;

        // 5. 落盘检查点 —— 必须在 pendingPlan 赋值之后，否则下一轮计划存不下来
        this.checkpoint(context, { pendingPlan, startedAt, status: 'in-progress' });

        // [test] 崩溃模拟钩子：验证断点续跑（仅在该环境变量设置时触发）
        const crashAt = Number(process.env.LOOPPOOL_CRASH_AT || 0);
        if (crashAt && iteration === crashAt) {
          console.error(`[test] 模拟第 ${iteration} 次迭代完成后崩溃`);
          process.exit(1);
        }

      } catch (error) {
        // 用户否决：立即中止，不得计入失败/触发重规划重问
        if (error instanceof PlanRejectedError) throw error;
        consecutiveFailures++;
        logError(`迭代 ${iteration}`, error);

        // 达到最大迭代次数，或连续失败超过熔断阈值：直接抛错
        // 连续失败说明存在稳定故障（模型持续输出坏 JSON / 网络错误等），
        // 继续重试只是白白烧掉剩余迭代次数。
        if (
          iteration === maxIterations ||
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
        ) {
          throw error;
        }
      }
    }

    // 达到最大迭代次数（partial）——落盘 completed 供历史留档，不再可恢复
    this.checkpoint(context, {
      pendingPlan: undefined,
      startedAt,
      status: 'completed',
    });
    printFinalSummary({
      status: 'partial',
      iterations: iteration,
      totalTasks: context.accumulatedResults.size,
      qualityScore: context.history[context.history.length - 1]?.decision.qualityScore,
    });

    const partialResult = this.formatPartialResult(context, startedAt);
    this.logRun(context, { status: 'partial', result: partialResult });
    return partialResult;
  }

  /**
   * 落盘检查点。写盘失败只告警、不中断执行（丢持久性但不丢进度）。
   */
  private checkpoint(
    context: Context,
    opts: { pendingPlan?: ExecutionPlan; startedAt: number; status?: CheckpointStatus }
  ): void {
    if (!this.checkpointStore) return;
    try {
      this.checkpointStore.save({
        requestId: context.requestId,
        userRequest: context.userRequest,
        userContext: context.userContext,
        startedAt: opts.startedAt,
        pendingPlan: opts.pendingPlan,
        accumulatedResults: context.accumulatedResults,
        history: context.history,
        status: opts.status ?? 'in-progress',
      });
    } catch (error) {
      logError('检查点落盘失败', error);
    }
  }

  /**
   * 是否需要对本次迭代的计划做审批
   * resume 后 iteration 从 history.length+1 起，'initial' 不重复问（原 run 的首计划已批过）。
   */
  private shouldRequestApproval(iteration: number): boolean {
    return (
      this.approvalMode === 'always' ||
      (this.approvalMode === 'initial' && iteration === 1)
    );
  }

  /** 生成计划摘要并请求人工确认 */
  private async askApproval(
    plan: ExecutionPlan,
    context: Context,
    iteration: number
  ): Promise<boolean> {
    return requestConfirm(this.buildPlanSummary(plan, context, iteration));
  }

  /** 把计划压成紧凑文本给确认弹窗展示 */
  private buildPlanSummary(
    plan: ExecutionPlan,
    context: Context,
    iteration: number
  ): string {
    const total = plan.stages.reduce((s, st) => s + st.tasks.length, 0);
    const lines: string[] = [
      `计划审批 — 迭代 ${iteration}/${this.config.system.maxIterations}`,
      '',
      `【用户需求】${this.truncate(context.userRequest, 200)}`,
    ];
    if (plan.reasoning) {
      lines.push(`【规划思路】${this.truncate(plan.reasoning, 400)}`);
    }
    lines.push(`【任务清单】共 ${total} 个任务`);
    plan.stages.forEach((st, i) => {
      lines.push(`  Stage ${i + 1} [${st.mode}]`);
      st.tasks.forEach((t) => {
        lines.push(`    - ${t.id} [${t.kind}/${t.model}] ${t.description}`);
        lines.push(`        ${this.truncate(t.prompt.replace(/\s+/g, ' ').trim(), 120)}`);
      });
    });
    lines.push('');
    lines.push('批准后将立即开始执行此计划（Enter 批准 / Esc 拒绝）。');
    return lines.join('\n');
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
  }

  /**
   * 折叠重放历史迭代到 TUI（resume 启动时调用）。
   * 只发迭代/阶段/任务/决策事件，不发 tool-call 等细节事件——
   * 过去的迭代以"已完成"状态呈现，新迭代随后流式展示。
   * 事件顺序与 state.ts reducer 对齐：
   *   stage-start 设 currentStageId → task-start 落入正确 stage；
   *   task-done 从后往前匹配最近一次同名任务。
   */
  private replayHistory(history: IterationRecord[]): void {
    const maxIterations = this.config.system.maxIterations;

    for (const rec of history) {
      logIteration(rec.iteration, maxIterations);
      logReasoning(rec.plan.reasoning);

      const stageCount = rec.plan.stages.length;
      rec.plan.stages.forEach((stage, i) => {
        logStage(i + 1, stageCount, stage.id, stage.mode, stage.tasks.length);

        for (const task of stage.tasks) {
          logTaskStart(task.id, task.model, task.description, task.kind);
          const result = rec.results.get(task.id);
          if (result) {
            logTaskDone(
              task.id,
              result.status === 'success',
              result.metrics.duration,
              result.metrics.modelUsed,
              result.metrics.tokensUsed,
              result.metrics.costUSD
            );
          }
          // 无结果的任务（critical-failure 中止 / serial break 未执行）保持 ○ 未完成态
        }

        const stageResults = stage.tasks
          .map((t) => rec.results.get(t.id))
          .filter((r): r is ExecutionResult => !!r);
        logStageSummary(
          stageResults.filter((r) => r.status === 'success').length,
          stageResults.length
        );
      });

      logDecision(
        rec.decision.shouldContinue,
        rec.decision.qualityScore,
        rec.decision.reason
      );
    }
  }

  /**
   * 采用上一轮决策给出的 newPlan：补 createdAt 并打日志，使日志风格与 generatePlan 一致
   */
  private adoptPendingPlan(
    plan: import('../types').ExecutionPlan
  ): import('../types').ExecutionPlan {
    const adopted: import('../types').ExecutionPlan = {
      ...plan,
      createdAt: plan.createdAt ?? new Date(),
    };
    const totalTasks = adopted.stages.reduce((s, st) => s + st.tasks.length, 0);
    logPlanReady(adopted.stages.length, totalTasks);
    logReasoning(adopted.reasoning);
    return adopted;
  }

  /**
   * 累计本次运行全部任务的成本（USD）。
   * 未配价格的模型不计入；没有任何成本数据时返回 undefined（最终结果不显示该字段）。
   */
  private totalCostUSD(context: Context): number | undefined {
    let total: number | undefined;
    for (const r of context.accumulatedResults.values()) {
      if (typeof r.metrics?.costUSD === 'number') {
        total = (total ?? 0) + r.metrics.costUSD;
      }
    }
    return total;
  }

  /**
   * 把本次 run 的要点写进项目运行日志（仅当配置了 projectKey）。
   * 这是可观测性（人类/排查看），不注入规划 prompt。
   */
  private logRun(context: Context, opts: { status: string; result: any }): void {
    if (!this.projectKey) return;
    try {
      const finalResult = opts.result?.result;
      const summary =
        (typeof finalResult?.summary === 'string' ? finalResult.summary : '') ||
        context.history[context.history.length - 1]?.decision?.reason ||
        '';
      const outputs = finalResult?.outputs
        ? Object.keys(finalResult.outputs).slice(0, 8).join(', ')
        : '';
      const cost = this.totalCostUSD(context);
      const entry =
        `[${new Date().toISOString().slice(0, 10)}] req=${context.requestId} ` +
        `status=${opts.status} 总结=${summary.slice(0, 300)} 产物=${outputs} ` +
        `cost=${cost !== undefined ? cost.toFixed(4) : '?'}`;
      appendRunLog(this.projectKey, entry);
    } catch (error) {
      logError('运行日志写入失败', error);
    }
  }

  /**
   * 格式化最终结果
   */
  private formatFinalResult(
    decision: Decision,
    context: Context,
    startedAt: number
  ): any {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const cost = this.totalCostUSD(context);

    // metadata 由系统覆盖：totalTime 用实测耗时（LLM 写的恒为 0），totalCostUSD 按任务实际用量累计
    const finalResult = decision.finalResult
      ? {
          ...decision.finalResult,
          metadata: {
            ...(decision.finalResult.metadata ?? {}),
            totalTime: elapsed,
            ...(cost !== undefined
              ? { totalCostUSD: Number(cost.toFixed(4)) }
              : {}),
          },
        }
      : decision.finalResult;

    return {
      status: 'completed',
      result: finalResult,
      context: {
        requestId: context.requestId,
        iterations: context.history.length,
        totalTasks: context.accumulatedResults.size,
      },
    };
  }

  /**
   * 格式化部分结果（达到最大迭代次数时）
   */
  private formatPartialResult(context: Context, startedAt: number): any {
    const lastDecision = context.history[context.history.length - 1]?.decision;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const cost = this.totalCostUSD(context);

    const result = lastDecision?.finalResult
      ? {
          ...lastDecision.finalResult,
          metadata: {
            ...(lastDecision.finalResult.metadata ?? {}),
            totalTime: elapsed,
            ...(cost !== undefined
              ? { totalCostUSD: Number(cost.toFixed(4)) }
              : {}),
          },
        }
      : lastDecision?.finalResult;

    return {
      status: 'partial',
      message: '达到最大迭代次数，返回当前最佳结果',
      qualityScore: lastDecision?.qualityScore || 0,
      result,
      context: {
        requestId: context.requestId,
        iterations: context.history.length,
        totalTasks: context.accumulatedResults.size,
      },
    };
  }

  /**
   * 生成请求 ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
