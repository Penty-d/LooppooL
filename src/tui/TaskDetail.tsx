import React from 'react';
import { Text, Box } from 'ink';
import stringWidth from 'string-width';
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
 *
 * 关键：所有长文本预先按 width 折行成多个独立元素，
 * 让 lines 数组元素数等于屏幕行数——这样 slice/maxHeight 才能
 * 按真实屏幕行裁剪，不会出现内容溢出覆盖底部边框。
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

  const lines: React.ReactNode[] = [];
  let lineKey = 0;
  const pushLine = (node: React.ReactNode) => {
    lines.push(<React.Fragment key={lineKey++}>{node}</React.Fragment>);
  };

  // 元信息（一般不超 width，但 description 可能很长）
  pushLine(
    <Box>
      <Text bold color="cyan">{task.taskId}</Text>
      <Text dimColor> ({task.modelId}) </Text>
      <Text color={statusColor} bold>{statusText}</Text>
      <Text dimColor> · {dur} · {toolCount} tools</Text>
    </Box>
  );

  // task.description 长时折行
  const kindLabel = task.kind === 'execute' ? 'EXEC' : 'VALIDATE';
  const descLines = wrapText(`${kindLabel}: ${task.description}`, width);
  for (const ln of descLines) {
    pushLine(<Box><Text dimColor>{ln}</Text></Box>);
  }

  pushLine(
    <Box>
      <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
    </Box>
  );

  // 时间线
  if (task.events.length === 0) {
    pushLine(<Box><Text dimColor>（暂无工具调用，等待 agent 行动…）</Text></Box>);
  }
  task.events.forEach((ev) => {
    if (ev.kind === 'tool-call') {
      // 第一行：→ toolName(args 头部)
      // 长 args 折成多行显示
      const argsText = `(${ev.briefArgs ?? ''})`;
      const headPrefix = `→ ${ev.toolName ?? ''}`;
      const firstLineRoom = Math.max(10, width - headPrefix.length);
      const argsWrapped = wrapText(argsText, firstLineRoom);
      // 第一行：toolName + 第一段 args
      pushLine(
        <Box>
          <Text color="blue">→ </Text>
          <Text color="blue" bold>{ev.toolName}</Text>
          <Text dimColor>{argsWrapped[0] ?? ''}</Text>
        </Box>
      );
      // 后续 args 行
      for (let i = 1; i < argsWrapped.length; i++) {
        pushLine(
          <Box marginLeft={2}>
            <Text dimColor>{argsWrapped[i]}</Text>
          </Box>
        );
      }
    } else if (ev.kind === 'tool-result') {
      const text = `↳ ${ev.brief ?? ''}`;
      const wrapped = wrapText(text, Math.max(10, width - 2));
      for (let i = 0; i < wrapped.length; i++) {
        pushLine(
          <Box marginLeft={2}>
            <Text dimColor>{wrapped[i]}</Text>
          </Box>
        );
      }
    } else if (ev.kind === 'agent-text') {
      pushLine(
        <Box>
          <Text color="yellow" bold>💬 agent:</Text>
        </Box>
      );
      const wrapped = wrapText(ev.brief || '', Math.max(10, width - 2));
      for (const ln of wrapped) {
        pushLine(
          <Box marginLeft={2}>
            <Text color="yellow">{ln}</Text>
          </Box>
        );
      }
    } else if (ev.kind === 'context-compaction') {
      const text = `⚠ context ${ev.beforeTokens}→${ev.afterTokens} tokens (kept ${ev.keptSteps} steps)`;
      const wrapped = wrapText(text, width);
      for (const ln of wrapped) {
        pushLine(<Box><Text color="yellowBright">{ln}</Text></Box>);
      }
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

/**
 * 按真实列宽把长文本折成多行
 *
 * 用 string-width 精确计算列宽（CJK / emoji 占 2 列，ASCII 占 1 列），
 * 按列宽切而不是按字符数切——既不溢出边框，也不浪费横向空间。
 */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      out.push('');
      continue;
    }
    let cur = '';
    let curWidth = 0;
    for (const ch of rawLine) {
      const w = stringWidth(ch);
      if (curWidth + w > width) {
        out.push(cur);
        cur = ch;
        curWidth = w;
      } else {
        cur += ch;
        curWidth += w;
      }
    }
    if (cur.length > 0) out.push(cur);
  }
  return out;
}
