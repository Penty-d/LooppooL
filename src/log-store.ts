import { mkdirSync, writeFileSync } from 'fs';
import { resolve as pathResolve, relative } from 'path';

/**
 * 大块原始输出落盘
 *
 * 调度器解析失败、Agent 异常等场景下，原始模型输出可能上千行 JSON / 错误栈。
 * 直接打到终端会把界面冲乱。这里统一写入 .looppool-logs/<requestId>/<key>.txt，
 * 控制台只显示文件路径 + 摘要，需要细看时用户自己打开文件。
 */
const ROOT = pathResolve('./.looppool-logs');

export function dumpRawLog(
  requestId: string,
  key: string,
  content: string
): { absolutePath: string; relativePath: string } {
  const dir = pathResolve(ROOT, requestId);
  mkdirSync(dir, { recursive: true });
  const safeKey = key.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const filePath = pathResolve(dir, `${safeKey}-${Date.now()}.txt`);
  writeFileSync(filePath, content, 'utf-8');
  return {
    absolutePath: filePath,
    relativePath: relative(process.cwd(), filePath),
  };
}

/**
 * 取一段长字符串的开头作为摘要（截断到 max 字符 + 省略号）
 */
export function summarize(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max) + '…';
}
