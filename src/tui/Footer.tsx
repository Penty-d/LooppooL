import React from 'react';
import { Text, Box } from 'ink';

/**
 * 底栏：操作提示 + 状态
 */
export function Footer({
  finished,
  isTty,
  selectedIdx,
  taskCount,
  fullWidth,
  iteration,
  maxIterations,
  score,
}: {
  finished: boolean;
  isTty: boolean;
  selectedTaskId?: string;
  taskCount: number;
  selectedIdx: number;
  fullWidth?: number;
  iteration?: number;
  maxIterations?: number;
  score?: number;
}) {
  if (!isTty) {
    return (
      <Box>
        <Text dimColor>只读模式（stdin 非 TTY）· 执行结束后进程自动退出</Text>
      </Box>
    );
  }

  const left = finished
    ? '执行已结束 · 按 q 退出'
    : `↑↓ 切任务 (${selectedIdx + 1}/${taskCount || 1}) · 滚轮看详情 · Enter 展开 · q 退出`;

  const rightParts: string[] = [];
  if (iteration && maxIterations) rightParts.push(`迭代 ${iteration}/${maxIterations}`);
  rightParts.push(`任务 ${taskCount}`);
  if (score !== undefined) rightParts.push(`评分 ${score}`);
  const right = rightParts.join(' · ');

  return (
    <Box borderStyle="single" width={fullWidth} justifyContent="space-between">
      <Text dimColor> {left} </Text>
      <Text dimColor> {right} </Text>
    </Box>
  );
}
