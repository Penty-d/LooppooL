import { Context, Decision, ExecutionPlan, Config, ModelsConfig } from '../types';
import { TaskExecutor } from '../agents';
import { ModelRegistry } from '../execution/model-registry';
import { AnthropicClient } from '../llm';
import { Orchestrator } from './orchestrator';
import { TaskPool } from './task-pool';
import {
  logIteration,
  logError,
  printFinalSummary,
  logPlanReady,
  logReasoning,
} from '../ui';

export class LoopPool {
  private config: Config;
  private models: ModelsConfig;
  private orchestrator: Orchestrator;
  private taskPool: TaskPool;

  constructor(config: Config, models: ModelsConfig) {
    this.config = config;
    this.models = models;

    // 模型库：把模型条目 id 解析为具体模型（含并发能力）；并向调度器提供可用模型清单
    const registry = new ModelRegistry(models);

    // 执行器：所有 execute/validate 任务走 AgentEngine（Vercel AI SDK + 工具集）
    const executor = new TaskExecutor(registry, config.system.taskTimeout);

    // 调度器：直连 Anthropic 协议端点（手写 fetch），返回结构化 JSON
    const client = new AnthropicClient(models.orchestrator);
    this.orchestrator = new Orchestrator(client, registry);

    // 任务池：按模型并发能力调度并行/串行
    this.taskPool = new TaskPool(executor, registry, config.system.globalParallelLimit);
  }

  /**
   * 执行用户请求
   */
  async execute(userRequest: string, userContext?: any): Promise<any> {
    // 初始化上下文
    const context: Context = {
      requestId: this.generateRequestId(),
      userRequest,
      history: [],
      accumulatedResults: new Map(),
      userContext,
    };

    let iteration = 0;
    const maxIterations = this.config.system.maxIterations;
    // 上一轮决策给出的 newPlan：第二轮起优先用，避免重复规划丢上下文
    let pendingPlan: import('../types').ExecutionPlan | undefined;

    while (iteration < maxIterations) {
      iteration++;
      logIteration(iteration, maxIterations);

      try {
        // 1. 生成执行计划：第二轮起优先用上轮决策给的 newPlan（基于 agent output 写的）
        //    没有时才回退到 generatePlan（重新规划，但上下文比 newPlan 弱）
        const usedNewPlan = !!pendingPlan;
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
          printFinalSummary({
            status: 'completed',
            iterations: iteration,
            totalTasks: context.accumulatedResults.size,
            qualityScore: decision.qualityScore,
          });
          return this.formatFinalResult(decision, context);
        }

        // 决策决定继续：把 newPlan 暂存到下一轮采用
        // 这样下一轮的 plan 直接基于本轮 agent output（事实），不再重新 generatePlan
        if (decision.newPlan && decision.newPlan.stages?.length > 0) {
          pendingPlan = decision.newPlan;
        }

      } catch (error) {
        logError(`迭代 ${iteration}`, error);

        if (iteration === maxIterations) {
          throw error;
        }
      }
    }

    // 达到最大迭代次数
    printFinalSummary({
      status: 'partial',
      iterations: iteration,
      totalTasks: context.accumulatedResults.size,
      qualityScore: context.history[context.history.length - 1]?.decision.qualityScore,
    });

    return this.formatPartialResult(context);
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
   * 格式化最终结果
   */
  private formatFinalResult(decision: Decision, context: Context): any {
    return {
      status: 'completed',
      result: decision.finalResult,
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
  private formatPartialResult(context: Context): any {
    const lastDecision = context.history[context.history.length - 1]?.decision;

    return {
      status: 'partial',
      message: '达到最大迭代次数，返回当前最佳结果',
      qualityScore: lastDecision?.qualityScore || 0,
      result: lastDecision?.finalResult,
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
