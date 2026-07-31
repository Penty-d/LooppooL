import { mkdirSync, appendFileSync } from 'fs';
import { resolve as pathResolve } from 'path';
import { bus, ALL_EVENT_TYPES, type UiEvent } from './events';

/**
 * NDJSON 请求日志
 *
 * 订阅事件总线，把一次 run 的全部事件按行写入 .looppool-logs/<requestId>/events.ndjson，
 * 每行 `{ ts, type, ...payload }`。调试长 run 时用 jq / grep 按 type 过滤即可
 * 重建完整调用链（plan → stage → task → tool-call → decision → final）。
 *
 * 观测层绝不能让 run 崩溃：写盘失败静默忽略。
 */
export class RequestLog {
  private filePath?: string;
  private listeners: Array<{ type: UiEvent['type']; listener: (payload: any) => void }> = [];
  private active = false;

  /** 开始记录一次 run 的事件流；重复调用会先 stop 旧的 */
  start(requestId: string, dirPath?: string): void {
    if (this.active) this.stop();

    const dir = pathResolve(dirPath ?? `./.looppool-logs/${requestId}`);
    try {
      mkdirSync(dir, { recursive: true });
      this.filePath = pathResolve(dir, 'events.ndjson');
    } catch {
      this.filePath = undefined; // 建目录失败 → 不记录，不崩溃
      return;
    }

    this.active = true;
    for (const type of ALL_EVENT_TYPES) {
      const listener = (payload: any) => this.append(type, payload);
      bus.on(type, listener);
      this.listeners.push({ type, listener });
    }
  }

  /** 停止记录并退订全部事件 */
  stop(): void {
    for (const { type, listener } of this.listeners) {
      bus.off(type, listener);
    }
    this.listeners = [];
    this.active = false;
  }

  private append(type: string, payload: any): void {
    if (!this.filePath) return;
    try {
      appendFileSync(
        this.filePath,
        JSON.stringify({ ts: Date.now(), type, payload }) + '\n',
        'utf-8'
      );
    } catch {
      // 观测不能 crash run
    }
  }
}

export const requestLog = new RequestLog();
