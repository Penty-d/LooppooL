import React from 'react';
import { Text, Box } from 'ink';
import type { TaskEntry } from './state';

/**
 * 右栏：选中 task 的详情
 *
 * 显示：
 *   - 顶部 task 元信息（id / model / 状态 / 耗时）
 *   - 工具调用时间线：每个 tool-call + 对应 tool-result 配对
 *   - agent 思考文本
 *   - 上下文压缩事件
 *
 * 支持滚动：maxHeight 限制可视行数，scroll 是起始行偏移。
 * 当 maxHeight 为 undefined 时不裁剪（非 TTY 降级路径）。
 */
export function TaskDetail({
  task,
  width,
  maxHeight,
  scroll,
}: {
  task: TaskEntry;
  width: number;
  maxHeight?: number;
  scroll: number;
}) {
  const statusText = task.ok === undefined
    ? '运行中'
    : task.ok
    ? '✓ 成功'
    : '✗ 失败';
  const statusColor = task.ok === undefined ? 'yellow' : task.ok ? 'green' : 'red';
  const dur = task.durationMs ? `${(task.durationMs / 1000).toFixed(1)}s` : '...';
  const toolCount = task.events.filter((e) => e.kind === 'tool-call').length;

  // 把所有内容渲染成行数组，便于滚动裁剪
  const lines: React.ReactNode[] = [];
  // 全局行计数器作 key，避免 slice 滚动后 key 重复/错位
  let lineKey = 0;
  const pushLine = (node: React.ReactNode) => {
    lines.push(<React.Fragment key={lineKey++}>{node}</React.Fragment>);
  };

  // 元信息
  pushLine(
    <Box>
      <Text bold color="cyan">{task.taskId}</Text>
      <Text dimColor> ({task.modelId}) </Text>
      <Text color={statusColor} bold>{statusText}</Text>
      <Text dimColor> · {dur} · {toolCount} tools</Text>
    </Box>
  );
  pushLine(
    <Box>
      <Text dimColor>{task.kind === 'execute' ? 'EXEC' : 'VALIDATE'}: </Text>
      <Text>{task.description}</Text>
    </Box>
  );
  pushLine(
    <Box>
      <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
    </Box>
  );

  // 时间线
  if (task.events.length === 0) {
    pushLine(<Text dimColor>（暂无工具调用，等待 agent 行动…）</Text>);
  }
  task.events.forEach((ev, i) => {
    if (ev.kind === 'tool-call') {
      pushLine(
        <Box>
          <Text color="blue">→ </Text>
          <Text color="blue" bold>{ev.toolName}</Text>
          <Text dimColor>{truncate(`(${ev.briefArgs})`, width - (ev.toolName?.length ?? 4) - 4)}</Text>
        </Box>
      );
    } else if (ev.kind === 'tool-result') {
      pushLine(
        <Box marginLeft={2}>
          <Text dimColor>↳ {truncate(ev.brief || '', width - 4)}</Text>
        </Box>
      );
    } else if (ev.kind === 'agent-text') {
      pushLine(
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow" bold>💬 agent:</Text>
          <Text color="yellow">  {truncate(ev.brief || '', width - 2)}</Text>
        </Box>
      );
    } else if (ev.kind === 'context-compaction') {
      pushLine(
        <Box>
          <Text color="yellowBright">⚠ context {ev.beforeTokens}→{ev.afterTokens} tokens (kept {ev.keptSteps} steps)</Text>
        </Box>
      );
    }
  });

  // 滚动裁剪
  let visible = lines;
  if (maxHeight !== undefined) {
    const start = Math.max(0, Math.min(scroll, Math.max(0, lines.length - maxHeight)));
    visible = lines.slice(start, start + maxHeight);
  }

  return <Box flexDirection="column">{visible}</Box>;
}

function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
