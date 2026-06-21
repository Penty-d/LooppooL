import React, { useState, useEffect, useRef } from 'react';
import { Text, Box, useApp, useStdout, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import { useTuiState, toggleTask, TuiState, TaskEntry } from './state';
import { TaskList } from './TaskList';
import { TaskDetail } from './TaskDetail';
import { Summary } from './Summary';
import { Footer } from './Footer';
import { printFinalResult, logError } from '../ui';
import type { LoopPool } from '../core';

type Phase = 'input' | 'running';

/**
 * 全屏 TUI 主组件
 *
 * Phase 'input'：显示输入框，用户输入需求
 * Phase 'running'：左右分栏显示执行过程
 *
 * 整个生命周期都在备用屏幕的全屏窗口里。
 */
export function App({
  initialRequest,
  loopPool,
  isTty,
  onDone,
}: {
  initialRequest: string;
  loopPool: LoopPool;
  isTty: boolean;
  onDone?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(initialRequest ? 'running' : 'input');
  const [request, setRequest] = useState(initialRequest);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();

  // 按 phase 切换鼠标跟踪：
  //   输入态关掉——避免鼠标序列泄漏到 TextInput 被当成普通字符
  //   执行态开启——让滚轮能滚动详情面板
  useEffect(() => {
    if (!isTty) return;
    if (phase === 'running') {
      process.stdout.write('\x1b[?1000h\x1b[?1006h');
    } else {
      process.stdout.write('\x1b[?1006l\x1b[?1000l');
    }
  }, [phase, isTty]);

  const state = useTuiState();
  const [localState, setLocalState] = useState<TuiState>(state);
  useEffect(() => setLocalState(state), [state]);

  const allTasks = collectAllTasks(state);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [detailScroll, setDetailScroll] = useState(0);
  // 完成后右栏默认显示调度器总结，按 Enter 切换到 task 详情浏览
  const [showSummary, setShowSummary] = useState(false);
  useEffect(() => {
    if (localState.finalResult) setShowSummary(true);
  }, [localState.finalResult]);

  // 选中项变化时重置滚动
  useEffect(() => {
    setDetailScroll(0);
  }, [selectedIdx, allTasks[selectedIdx]?.uid]);

  // 用 ref 存最新的 allTasks / selectedIdx / localState，
  // 让 stdin 监听只订阅一次（不随每次渲染重订阅），避免 cleanup 时 setRawMode(false)
  // 导致进程意外退出
  const allTasksRef = useRef(allTasks);
  const selectedIdxRef = useRef(selectedIdx);
  const localStateRef = useRef(localState);
  const onDoneRef = useRef(onDone);
  allTasksRef.current = allTasks;
  selectedIdxRef.current = selectedIdx;
  localStateRef.current = localState;
  onDoneRef.current = onDone;

  // 键盘交互（仅执行态需要）—— 只在 phase / isTty 变化时重订阅
  useEffect(() => {
    if (phase !== 'running') return;
    if (!isTty || !isRawModeSupported) return;

    const onData = (data: Buffer) => {
      const s = data.toString();
      // q / Ctrl+C 退出
      if (s === 'q' || s === '\x03') {
        exit();
        onDoneRef.current?.();
        return;
      }

      // 鼠标滚轮（SGR 1006）：\x1B[<64;y;xM = 滚轮上，\x1B[<65;y;xM = 滚轮下
      const wheelMatch = s.match(/^\x1B\[<(\d+);(\d+);(\d+)M/);
      if (wheelMatch) {
        const btn = parseInt(wheelMatch[1], 10);
        if (btn === 64) {
          setDetailScroll((i) => Math.max(0, i - 3));
        } else if (btn === 65) {
          setDetailScroll((i) => i + 3);
        }
        return;
      }

      const tasks = allTasksRef.current;
      if (tasks.length === 0) return;

      if (s === '\x1B[A') {
        setSelectedIdx((i) => Math.max(0, i - 1));
        setShowSummary(false);
      } else if (s === '\x1B[B') {
        setSelectedIdx((i) => Math.min(tasks.length - 1, i + 1));
        setShowSummary(false);
      } else if (s === '\r' || s === 'l' || s === 's') {
        if (localStateRef.current.finalResult) {
          setShowSummary((v) => !v);
        } else {
          const t = tasks[selectedIdxRef.current];
          if (t) setLocalState((prev) => toggleTask(prev, t.uid));
        }
      }
    };

    process.stdin.on('data', onData);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return () => {
      process.stdin.removeListener('data', onData);
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    };
  }, [phase, isTty, isRawModeSupported, exit]);

  // 启动 LoopPool
  useEffect(() => {
    if (phase !== 'running' || !request) return;
    loopPool
      .execute(request)
      .then((result) => {
        if (result?.result) printFinalResult(result.result);
        onDoneRef.current?.();
      })
      .catch((err) => {
        logError('运行错误', err);
        onDoneRef.current?.();
      });
  }, [phase, request, loopPool]);

  const cols = stdout.columns || 80;
  const rows = stdout.rows || 24;

  // ───────── 输入态 ─────────
  if (phase === 'input') {
    return (
      <Box flexDirection="column" width={cols} height={rows} paddingX={2} paddingY={1}>
        <Box borderStyle="single" width={cols - 4} paddingX={1} paddingY={1}>
          <Box flexDirection="column">
            <Text color="magenta" bold>✦ LoopPool</Text>
            <Text dimColor>  multi-agent orchestration</Text>
          </Box>
        </Box>

        <Box marginTop={2}>
          <Text color="cyan" bold>▸ 请输入任务需求</Text>
        </Box>

        <Box marginTop={1} borderStyle="single" paddingX={1}>
          <TextInput
            value={request}
            placeholder="例：创建 hello.txt 写入 hi"
            onChange={setRequest}
            onSubmit={(v) => {
              if (v.trim()) {
                setRequest(v.trim());
                setPhase('running');
              }
            }}
          />
        </Box>

        <Box marginTop={2}>
          <Text dimColor>回车提交 · Ctrl+C 退出</Text>
        </Box>
      </Box>
    );
  }

  // ───────── 执行态 ─────────
  const selectedTask = allTasks[selectedIdx];
  const finished = !!localState.finalSummary;

  // 非 TTY 降级：单栏流式
  if (!isTty) {
    return (
      <Box flexDirection="column" paddingBottom={1}>
        <Header request={request} fullWidth={cols} />
        <TaskList
          state={localState}
          tasks={allTasks}
          selectedIdx={selectedIdx}
          width={cols}
        />
        {selectedTask && (
          <Box marginTop={1} flexDirection="column">
            <TaskDetail task={selectedTask} width={cols} maxHeight={undefined} scroll={0} />
          </Box>
        )}
        {localState.finalResult && (
          <Box marginTop={1} flexDirection="column">
            <Summary result={localState.finalResult} width={cols} />
          </Box>
        )}
        <Footer
          finished={finished}
          isTty={false}
          selectedIdx={selectedIdx}
          taskCount={allTasks.length}
        />
      </Box>
    );
  }

  // TTY 全屏左右分栏
  const leftWidth = Math.floor(cols * 0.42);
  const rightWidth = cols - leftWidth - 3;
  const bodyHeight = rows - 6;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header request={request} fullWidth={cols} />

      <Box flexDirection="row" height={bodyHeight}>
        <Box width={leftWidth} borderStyle="single" flexDirection="column" paddingX={1}>
          <TaskList
            state={localState}
            tasks={allTasks}
            selectedIdx={selectedIdx}
            width={leftWidth - 2}
            maxHeight={bodyHeight - 2}
          />
        </Box>
        <Box width={1} />
        <Box width={rightWidth} borderStyle="single" flexDirection="column" paddingX={1}>
          {showSummary && localState.finalResult ? (
            <Summary result={localState.finalResult} width={rightWidth - 2} />
          ) : selectedTask ? (
            <TaskDetail task={selectedTask} width={rightWidth - 2} maxHeight={bodyHeight - 2} scroll={detailScroll} />
          ) : (
            <Text dimColor>（选择左侧任务查看详情）</Text>
          )}
        </Box>
      </Box>

      <Footer
        finished={finished}
        isTty={true}
        selectedIdx={selectedIdx}
        taskCount={allTasks.length}
        fullWidth={cols}
        iteration={localState.iterations[localState.iterations.length - 1]?.iteration}
        maxIterations={localState.iterations[localState.iterations.length - 1]?.maxIterations}
        score={localState.iterations[localState.iterations.length - 1]?.decision?.qualityScore ?? localState.finalSummary?.qualityScore}
      />
    </Box>
  );
}

function Header({ request, fullWidth }: { request: string; fullWidth: number }) {
  const title = ' ✦ LoopPool ';
  const requestText = request ? `  ${truncate(request, fullWidth - title.length - 4)}` : '';
  return (
    <Box borderStyle="single" width={fullWidth} justifyContent="space-between">
      <Text color="magenta" bold>{title}</Text>
      <Text dimColor>{requestText}</Text>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function collectAllTasks(state: TuiState): TaskEntry[] {
  const list: TaskEntry[] = [];
  for (const it of state.iterations) {
    for (const st of it.stages) {
      for (const t of st.tasks) {
        list.push(t);
      }
    }
  }
  return list;
}
