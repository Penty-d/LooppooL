/**
 * 跨模块共享的错误类型
 */

/**
 * 用户否决了执行计划。必须在 runLoop 的 catch 里最先 re-throw，
 * 绕过连续失败熔断（用户否决绝不能触发重新规划重问）。
 */
export class PlanRejectedError extends Error {
  constructor(message = '用户拒绝执行计划，运行中止') {
    super(message);
    this.name = 'PlanRejectedError';
  }
}
