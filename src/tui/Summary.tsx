import React from 'react';
import { Text, Box } from 'ink';

/**
 * 右栏：任务完成后的调度器总结面板
 *
 * 显示 finalResult.summary + outputs + metadata。
 * 这是调度器在 analyzeAndDecide 阶段写的完成摘要。
 */
export function Summary({ result, width }: { result: any; width: number }) {
  if (!result) {
    return (
      <Box>
        <Text dimColor>（无总结信息）</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="green">✓ 任务完成</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
      </Box>

      {result.summary && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">摘要</Text>
          <Text>{result.summary}</Text>
        </Box>
      )}

      {result.outputs && Object.keys(result.outputs).length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">产物</Text>
          {Object.entries(result.outputs).map(([k, v]) => (
            <Box key={k}>
              <Text dimColor>{k}: </Text>
              <Text>{truncate(String(v), width - k.length - 3)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {result.metadata && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">元数据</Text>
          {Object.entries(result.metadata).map(([k, v]) => (
            <Box key={k}>
              <Text dimColor>{k}: </Text>
              <Text>{String(v)}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>按 ↑↓ 浏览任务详情 · Enter/s 回到此总结 · q 退出</Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
