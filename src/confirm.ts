import { bus, now } from './events';

/**
 * 人工确认原语（计划审批 / 危险命令确认共用）
 *
 * 避免把 askUser 回调穿过 LoopPool → TaskExecutor → AgentEngine → createTools 四层：
 * 请求方调 requestConfirm() 返回一个 Promise；确认方（TUI 弹窗 / 非 TTY readline）
 * 注册一个全局 responder，用户操作后调 respondConfirm(id, ok) 直接 resolve。
 *
 * - responder 是单槽「替换」语义：TTY（App）与非 TTY（index.tsx）互斥注册。
 * - 无 responder 时 requestConfirm 立即 resolve false（默认拒绝）——核心代码未接线也安全。
 * - user-confirm 事件只作审计/可观测通道，响应不经过事件总线。
 */

type ConfirmResponder = (id: string, message: string) => void;
type Resolver = (ok: boolean) => void;

const pending = new Map<string, Resolver>();
let responder: ConfirmResponder | null = null;

/** 发起一次人工确认。无 responder → 默认拒绝；可传 timeoutMs（超时 = 拒绝）。 */
export function requestConfirm(
  message: string,
  opts?: { timeoutMs?: number }
): Promise<boolean> {
  if (!responder) {
    // 无响应方（未接线 / 非交互 / 测试）：默认拒绝
    console.error(`[confirm] 没有确认响应方，默认拒绝：${message.slice(0, 120)}`);
    return Promise.resolve(false);
  }

  // 闭包内模块级变量不会被 TS 窄化，先捕获非空引用
  const r = responder;
  const id = `c_${now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    bus.dispatch({ type: 'user-confirm', payload: { id, message, ts: now() } });
    r(id, message);

    if (opts?.timeoutMs) {
      setTimeout(() => {
        if (pending.delete(id)) resolve(false); // 超时 = 拒绝
      }, opts.timeoutMs);
    }
  });
}

/** 用户响应：resolve 对应的 pending Promise */
export function respondConfirm(id: string, ok: boolean): void {
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve(ok);
  }
}

/** 注册确认响应方（替换语义：单槽） */
export function registerConfirmResponder(fn: ConfirmResponder): void {
  responder = fn;
}

/** 清空确认响应方 */
export function unregisterConfirmResponder(): void {
  responder = null;
}
