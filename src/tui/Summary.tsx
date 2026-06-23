import React from 'react';
import { Text, Box } from 'ink';
import stringWidth from 'string-width';

/**
 * 右栏：任务完成后的调度器总结面板
 *
 * 显示 finalResult.summary + outputs + metadata。
 * 这是调度器在 analyzeAndDecide 阶段写的完成摘要。
 *
 * 支持滚动：maxHeight 限制可视行数，scroll 是起始行偏移。
 * 当 maxHeight 为 undefined 时不裁剪（非 TTY 降级路径）。
 */
export function Summary({
  result,
  width,
  maxHeight,
  scroll,
}: {
  result: any;
  width: number;
  maxHeight?: number;
  scroll: number;
}) {
  if (!result) {
    return (
      <Box>
        <Text dimColor>（无总结信息）</Text>
      </Box>
    );
  }

  // 把所有内容渲染成行数组，便于滚动裁剪
  const lines: React.ReactNode[] = [];
  // 全局行计数器作 key，避免 slice 滚动后 key 重复/错位
  let lineKey = 0;
  const pushLine = (node: React.ReactNode) => {
    lines.push(<React.Fragment key={lineKey++}>{node}</React.Fragment>);
  };

  pushLine(
    <Box>
      <Text bold color="green">✓ 任务完成</Text>
    </Box>
  );

  pushLine(
    <Box>
      <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
    </Box>
  );

  if (result.summary) {
    pushLine(<Box><Text bold color="cyan">摘要</Text></Box>);
    for (const ln of wrapText(result.summary, width)) {
      pushLine(
        <Box>
          <Text>{ln}</Text>
        </Box>
      );
    }
  }

  if (result.outputs && Object.keys(result.outputs).length > 0) {
    pushLine(<Box><Text bold color="cyan">产物</Text></Box>);
    for (const [k, v] of Object.entries(result.outputs)) {
      const valStr = String(v);
      if (valStr.length <= 20) {
        pushLine(
          <Box marginLeft={1}>
            <Text dimColor>{k}: </Text>
            <Text>{valStr}</Text>
          </Box>
        );
      } else {
        // 长 value：key 单独一行，value 每个折行单独 pushLine
        // —— 之前用 flexDirection=column 的 Box 包多个 Text 作为单个 lines 元素，
        // 实际渲染 N 行，导致 slice 按 1 行算时溢出底部边框
        pushLine(
          <Box marginLeft={1}>
            <Text dimColor>{k}:</Text>
          </Box>
        );
        for (const ln of wrapText(valStr, width - 1)) {
          pushLine(
            <Box marginLeft={1}>
              <Text>{ln}</Text>
            </Box>
          );
        }
      }
    }
  }

  if (result.metadata) {
    pushLine(<Box><Text bold color="cyan">元数据</Text></Box>);
    for (const [k, v] of Object.entries(result.metadata)) {
      pushLine(
        <Box>
          <Text dimColor>{k}: </Text>
          <Text>{String(v)}</Text>
        </Box>
      );
    }
  }

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
 * 用 string-width 精确计算列宽（CJK / emoji 占 2 列，ASCII 占 1 列）。
 */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }
    let cur = '';
    let curWidth = 0;
    for (const ch of rawLine) {
      const w = stringWidth(ch);
      if (curWidth + w > width) {
        lines.push(cur);
        cur = ch;
        curWidth = w;
      } else {
        cur += ch;
        curWidth += w;
      }
    }
    if (cur.length > 0) lines.push(cur);
  }
  return lines;
}
