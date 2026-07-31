import React, { useState, useEffect, useRef } from 'react';
import { Text, Box, useApp, useStdout, useStdin, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useTuiState, toggleTask, TuiState, TaskEntry } from './state';
import { TaskList } from './TaskList';
import { TaskDetail } from './TaskDetail';
import { Summary } from './Summary';
import { Footer } from './Footer';
import { ConfirmModal } from './ConfirmModal';
import { printFinalResult, logError } from '../ui';
import {
  registerConfirmResponder,
  unregisterConfirmResponder,
  respondConfirm,
} from '../confirm';
import { PlanRejectedError } from '../errors';
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
  resumeRequestId,
  loopPool,
  isTty,
  onDone,
}: {
  initialRequest: string;
  /** 非空表示本次是断点恢复：直接进 running 态并调用 loopPool.resume(id) */
  resumeRequestId?: string | null;
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

  // ── 人工确认（计划审批 / 危险命令）──
  const confirmQueueRef = useRef<{ id: string; message: string }[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<{ id: string; message: string } | null>(null);
  const [confirmScroll, setConfirmScroll] = useState(0);
  // 让 onData 闭包读到最新 pendingConfirm（ref 同步模式，同 allTasksRef）
  const pendingConfirmRef = useRef<typeof pendingConfirm>(null);
  pendingConfirmRef.current = pendingConfirm;
  // Esc 防抖：裸 \x1B 可能是箭头键的前缀，等一小段时间看是否有后续字节
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 注册确认响应方（TTY 专属；非 TTY 由 index.tsx 注册，单槽替换）。
  // 声明在 run-start effect 之前，保证确认不会"未接线"。
  useEffect(() => {
    if (!isTty) return;
    const showNext = () => {
      const q = confirmQueueRef.current;
      setPendingConfirm(q.length > 0 ? q[0] : null);
      setConfirmScroll(0);
    };
    registerConfirmResponder((id, message) => {
      confirmQueueRef.current.push({ id, message });
      showNext();
    });
    return () => unregisterConfirmResponder();
  }, [isTty]);

  // 键盘交互（仅执行态需要）—— 只在 phase / isTty 变化时重订阅
  useEffect(() => {
    if (phase !== 'running') return;
    if (!isTty || !isRawModeSupported) return;

    const onData = (data: Buffer) => {
      const s = data.toString();

      // ── 确认态拦截：Enter=批准，n/x=拒绝，Esc=拒绝（50ms 防抖区分箭头键）──
      const curConfirm = pendingConfirmRef.current;
      if (curConfirm) {
        const resolveNext = (ok: boolean) => {
          if (escTimerRef.current) {
            clearTimeout(escTimerRef.current);
            escTimerRef.current = null;
          }
          const next = confirmQueueRef.current.shift();
          if (next) respondConfirm(next.id, ok);
          const q = confirmQueueRef.current;
          setPendingConfirm(q.length > 0 ? q[0] : null);
          setConfirmScroll(0);
        };

        if (s === '\r' || s === '\n') {
          resolveNext(true);
          return;
        }
        if (s === 'n' || s === 'x') {
          resolveNext(false);
          return;
        }
        if (s === '\x1B') {
          // 裸 Esc：等 50ms 看是否有后续字节；有则取消（箭头键序列）
          if (escTimerRef.current) clearTimeout(escTimerRef.current);
          escTimerRef.current = setTimeout(() => {
            escTimerRef.current = null;
            resolveNext(false);
          }, 50);
          return;
        }
        if (s.startsWith('\x1B[')) {
          // 箭头键/其他转义序列：取消 Esc 防抖并忽略
          if (escTimerRef.current) {
            clearTimeout(escTimerRef.current);
            escTimerRef.current = null;
          }
          return;
        }
        // 确认态下其他按键忽略（q 也被吞掉，必须先解决确认）
        return;
      }

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
        if (pendingConfirmRef.current) {
          // 确认态：滚确认弹窗
          setConfirmScroll((i) => (btn === 64 ? Math.max(0, i - 3) : i + 3));
        } else if (btn === 64) {
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

  // 启动 LoopPool（全新 run 或断点恢复）
  useEffect(() => {
    if (phase !== 'running' || !request) return;
    const promise = resumeRequestId
      ? loopPool.resume(resumeRequestId)
      : loopPool.execute(request);
    promise
      .then((result) => {
        if (result?.result) printFinalResult(result.result);
        onDoneRef.current?.();
      })
      .catch((err) => {
        if (err instanceof PlanRejectedError) {
          logError('计划已拒绝', err);
        } else {
          logError('运行错误', err);
        }
        onDoneRef.current?.();
      });
  }, [phase, request, loopPool, resumeRequestId]);

  const cols = stdout.columns || 80;
  const rows = stdout.rows || 24;

  // 全局 Ctrl+C 退出（输入态 / 执行态都生效）
  // 输入态 ink-text-input 用 useInput 拦截了 Ctrl+C 不处理，且 Ink 的 exitOnCtrlC=false，
  // 所以必须自己监听一份。执行态我们手写 stdin 监听也处理 Ctrl+C，两层兜底。
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      onDoneRef.current?.();
    }
  }, { isActive: isRawModeSupported === true });

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

  // 确认弹窗：整屏替换主界面（确认期间 run 被 requestConfirm 阻塞，无任务事件涌入，安全）
  if (isTty && pendingConfirm) {
    return (
      <ConfirmModal
        message={pendingConfirm.message}
        width={cols}
        height={rows}
        scroll={confirmScroll}
        queued={confirmQueueRef.current.length}
      />
    );
  }

  // 非 TTY 降级：单栏流式
  if (!isTty) {
    return (
      <Box flexDirection="column" paddingBottom={1}>
        <Header request={request} fullWidth={cols} />
        <TaskList
          state={localState}
          tasks={allTasks}
          selectedIdx={selectedIdx}
          selectedUid={selectedTask?.uid}
          width={cols}
        />
        {selectedTask && (
          <Box marginTop={1} flexDirection="column">
            <TaskDetail task={selectedTask} width={cols} maxHeight={undefined} scroll={0} />
          </Box>
        )}
        {localState.finalResult && (
          <Box marginTop={1} flexDirection="column">
            <Summary result={localState.finalResult} width={cols} scroll={0} />
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
            selectedUid={allTasks[selectedIdx]?.uid}
            width={leftWidth - 2}
            maxHeight={bodyHeight - 2}
          />
        </Box>
        <Box width={1} />
        <Box width={rightWidth} borderStyle="single" flexDirection="column" paddingX={1}>
          {showSummary && localState.finalResult ? (
            <Summary result={localState.finalResult} width={rightWidth - 2} maxHeight={bodyHeight - 2} scroll={detailScroll} />
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
