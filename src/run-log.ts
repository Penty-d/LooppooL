import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve as pathResolve, join as pathJoin } from 'path';

/**
 * 跨 run 项目运行日志
 *
 * 每次 run 结束时把一条摘要追加到 data/run-logs/<projectKey>.jsonl（data/ 已 gitignore），
 * 按项目归档，封顶 50 条。这是可观测性的一部分（F2 events.ndjson 的粗粒度、项目级视图），
 * 不是调度器的"记忆"——日志只写给人类/排查看，不注入规划 prompt。
 */

const ROOT = pathResolve('./data/run-logs');
const MAX_ENTRIES = 50;

function logPath(projectKey: string): string {
  // projectKey 可能来自 CLI argv，拒绝路径穿越
  if (
    !projectKey ||
    /[\\/]/.test(projectKey) ||
    projectKey.includes('..') ||
    projectKey.startsWith('.')
  ) {
    throw new Error(`非法 projectKey: ${JSON.stringify(projectKey)}`);
  }
  return pathJoin(ROOT, `${projectKey}.jsonl`);
}

/** 读取某项目的运行日志条目（最近 MAX_ENTRIES 条）；文件不存在返回 [] */
export function loadRunLog(projectKey?: string): string[] {
  if (!projectKey) return [];
  try {
    const text = readFileSync(logPath(projectKey), 'utf-8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** 追加一条运行日志（封顶 MAX_ENTRIES 条，最旧的丢弃） */
export function appendRunLog(projectKey: string, entry: string): void {
  const next = [...loadRunLog(projectKey), entry].slice(-MAX_ENTRIES);
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(
    logPath(projectKey),
    next.join('\n') + (next.length ? '\n' : ''),
    'utf-8'
  );
}
