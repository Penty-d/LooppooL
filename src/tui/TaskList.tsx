import React from 'react';
import { Text, Box } from 'ink';
import type { TuiState, TaskEntry } from './state';

/**
 * 左栏：任务列表
 *
 * 结构：迭代 → Stage → Task
 * 选中 task 高亮反白。
 *
 * 滚动：当内容超过 maxHeight 时，自动跟随选中项——
 * 选中项不在可视区时滚动到能看见的位置。
 */
export function TaskList({
  state,
  tasks,
  selectedIdx,
  width,
  maxHeight,
}: {
  state: TuiState;
  tasks: TaskEntry[];
  selectedIdx: number;
  width: number;
  maxHeight?: number;
}) {
  const lines: React.ReactNode[] = [];
  // 记录每个 task 行在 lines 中的位置，用于滚动跟随
  const taskLinePositions: { uid: string; lineIdx: number }[] = [];
  // 全局行计数器，用作 React key——保证每个行元素 key 唯一且稳定，
  // 不会因 slice 滚动导致 key 重复/错位（之前的语义 key 如 stage-1
  // 在不同迭代里会重名，滚动后 React 复用错实例）
  let lineKey = 0;
  const pushLine = (node: React.ReactNode) => {
    lines.push(<React.Fragment key={lineKey++}>{node}</React.Fragment>);
  };

  for (const it of state.iterations) {
    pushLine(
      <Box>
        <Text color="cyan" bold>
          ● 迭代 {it.iteration}/{it.maxIterations}
        </Text>
        {it.decision && (
          <Text dimColor>
            {' '}
            <Text color={scoreColor(it.decision.qualityScore)}>
              {it.decision.qualityScore}
            </Text>
          </Text>
        )}
      </Box>
    );

    if (it.reasoning) {
      pushLine(
        <Box marginLeft={1}>
          <Text dimColor>{truncate(it.reasoning, width - 2)}</Text>
        </Box>
      );
    }

    for (const st of it.stages) {
      pushLine(
        <Box marginLeft={1}>
          <Text bold color={st.summary && st.summary.success < st.summary.total ? 'red' : 'green'}>
            {st.summary ? '✓' : '○'}
          </Text>
          <Text dimColor> Stage {st.index}/{st.total} </Text>
          <Text color={st.mode === 'parallel' ? 'yellow' : 'gray'}>[{st.mode}]</Text>
        </Box>
      );

      st.tasks.forEach((t) => {
        const idx = tasks.findIndex((x) => x.uid === t.uid);
        const isSelected = idx === selectedIdx;
        const tag = t.kind === 'execute' ? 'E' : 'V';
        const statusIcon = t.ok === undefined ? '○' : t.ok ? '✓' : '✗';
        const dur = t.durationMs ? `${(t.durationMs / 1000).toFixed(1)}s` : '...';
        const toolCount = t.events.filter((e) => e.kind === 'tool-call').length;

        const marker = isSelected ? '▸' : ' ';
        const desc = truncate(t.description, Math.max(5, width - 26));
        const line = `${marker} ${statusIcon} ${tag} ${truncate(t.taskId, 10)} ${desc} ${toolCount}t ${dur}`;

        taskLinePositions.push({ uid: t.uid, lineIdx: lines.length });
        pushLine(
          <Box marginLeft={1}>
            <Text
              color={isSelected ? 'black' : undefined}
              backgroundColor={isSelected ? 'cyan' : undefined}
            >
              {line}
            </Text>
          </Box>
        );
      });
    }
  }

  if (lines.length === 0) {
    return (
      <Box>
        <Text dimColor>等待调度器规划…</Text>
      </Box>
    );
  }

  // 滚动：让选中项在可视区内
  if (maxHeight !== undefined && lines.length > maxHeight) {
    const selectedUid = tasks[selectedIdx]?.uid;
    const selectedPos = taskLinePositions.find((p) => p.uid === selectedUid);
    let start = 0;
    if (selectedPos) {
      // 选中项尽量放在可视区中间偏上
      const desiredStart = selectedPos.lineIdx - Math.floor(maxHeight * 0.3);
      start = Math.max(0, Math.min(desiredStart, lines.length - maxHeight));
    }
    const visible = lines.slice(start, start + maxHeight);
    return (
      <Box flexDirection="column">
        {visible}
        <Text dimColor> [{start + 1}-{Math.min(start + maxHeight, lines.length)}/${lines.length}]</Text>
      </Box>
    );
  }

  return <Box flexDirection="column">{lines}</Box>;
}

function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function scoreColor(score: number): 'green' | 'yellow' | 'red' {
  if (score >= 90) return 'green';
  if (score >= 80) return 'yellow';
  return 'red';
}
