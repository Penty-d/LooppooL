import React from 'react';
import { render } from 'ink';
import { createInterface } from 'readline';
import { LoopPool } from './core';
import { loadConfig, loadModelsConfig } from './config';
import { printFinalResult, logError } from './ui';
import { App } from './tui/App';
import { registerConfirmResponder, respondConfirm } from './confirm';
import type { ApprovalMode } from './types';

/**
 * 终端控制序列
 *
 * alternate screen buffer：切换到备用屏幕，让 TUI 占满整个终端
 *   像 vim / htop / lazygit 那样"吃掉"屏幕，退出后原终端内容恢复
 *
 * cursor hide：隐藏光标，TUI 自己管理"选中"指示
 */
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function enterFullscreen(): void {
  // 注意：不在这里开鼠标跟踪——输入态开鼠标会导致序列泄漏到文本框
  // 鼠标跟踪由 App 组件按 phase 切换（执行态开、输入态关）
  process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
}

function exitFullscreen(): void {
  // 退出时确保关掉鼠标跟踪（无论当前状态）
  process.stdout.write('\x1b[?1006l\x1b[?1000l' + SHOW_CURSOR + EXIT_ALT_SCREEN);
}

/**
 * 非 TTY 模式：从管道 stdin 读取整段输入作为需求。
 * 必须在 render 之前读完——否则 App 停在输入态，既没有可用的 stdin，
 * 又没有 keepAlive 清理路径，进程会永远挂住。
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // stdin 已经 EOF（如 `npm run dev < empty`）时不会再有 end 事件，直接返回空
    if (process.stdin.readableEnded) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', () => resolve(data.trim()));
  });
}

export async function main() {
  try {
    const config = loadConfig();
    const models = loadModelsConfig();

    // 解析 argv：--resume [requestId] / --approve / --no-approve / --budget <usd> / --project <key> / 需求
    const argv = process.argv.slice(2);
    const resumeIdx = argv.indexOf('--resume');
    const resuming = resumeIdx !== -1;

    const valueFlags = new Set(['--resume', '--budget', '--project']);
    // 取值 flag 的值占用的下标（避免被当成需求）
    const valueIdx = new Set<number>();
    argv.forEach((a, i) => {
      if (valueFlags.has(a) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        valueIdx.add(i + 1);
      }
    });

    // 计划审批覆盖：--approve=initial / --no-approve=none，后出现者优先（都出现时 --no-approve 更安全）
    const approveIdx = argv.indexOf('--approve');
    const noApproveIdx = argv.indexOf('--no-approve');
    let approvalOverride: ApprovalMode | undefined;
    if (noApproveIdx !== -1 && (approveIdx === -1 || noApproveIdx > approveIdx)) {
      approvalOverride = 'none';
    } else if (approveIdx !== -1) {
      approvalOverride = 'initial';
    }

    // --budget <usd>
    const budgetIdx = argv.indexOf('--budget');
    let budgetOverride: number | undefined;
    if (budgetIdx !== -1) {
      const raw = Number(argv[budgetIdx + 1]);
      if (Number.isFinite(raw) && raw > 0) {
        budgetOverride = raw;
      } else {
        logError('启动错误', new Error('--budget 需要正数（USD），如 --budget 0.5'));
        process.exit(1);
      }
    }

    // --project <key>
    const projectIdx = argv.indexOf('--project');
    let projectOverride: string | undefined;
    if (projectIdx !== -1) projectOverride = argv[projectIdx + 1];

    const loopPool = new LoopPool(config, models, {
      approvalMode: approvalOverride,
      budgetUSD: budgetOverride,
      projectKey: projectOverride,
    });

    const isTty = process.stdin.isTTY === true;

    // TTY：一启动就切到备用屏幕，整个交互都在全屏窗口里
    if (isTty) {
      enterFullscreen();
      const restore = () => exitFullscreen();
      process.on('exit', restore);
      process.on('SIGINT', () => { restore(); process.exit(0); });
      process.on('SIGTERM', () => { restore(); process.exit(0); });
    }

    // 非 TTY：注册确认响应方（打印消息 + 读一行 y/n；EOF → 拒绝）。
    // 注意：请求从管道 echo "..." | npm run dev 来时 stdin 已被 readStdin() 消费到 EOF，
    // 确认会立即自动拒绝——非交互自动化请配 approvalMode:none / dangerousShell:deny|allow 或 --no-approve。
    if (!isTty) {
      registerConfirmResponder((id, message) => {
        process.stderr.write(`\n[需要确认] ${message}\n(y/n): `);
        const rl = createInterface({ input: process.stdin, terminal: false });
        let settled = false;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          rl.close();
          respondConfirm(id, ok);
        };
        rl.once('line', (line) => done(/^y(?:es)?$/i.test(line.trim())));
        rl.once('close', () => done(false)); // EOF → 拒绝
        rl.once('error', () => done(false));
      });
    }

    let initialRequest = '';
    let resumeRequestId: string | null = null;

    if (resuming) {
      if (!loopPool.checkpointStore) {
        logError(
          '启动错误',
          new Error('--resume 需要 config.storage.persistHistory=true')
        );
        process.exit(1);
      }
      const maybe = argv[resumeIdx + 1];
      const explicitId = maybe && !maybe.startsWith('--') ? maybe : null;
      // 无显式 id 时自动选最近一次可恢复的 run
      const requestId =
        explicitId ?? loopPool.checkpointStore.listResumable()[0]?.requestId;
      if (!requestId) {
        logError('启动错误', new Error('没有可恢复的检查点'));
        process.exit(1);
      }
      const ckpt = loopPool.checkpointStore.load(requestId);
      if (!ckpt) {
        logError('启动错误', new Error(`检查点不存在或已损坏: ${requestId}`));
        process.exit(1);
      }
      if (ckpt.status === 'completed') {
        logError('启动错误', new Error(`任务已完成，无需恢复: ${requestId}`));
        process.exit(1);
      }
      resumeRequestId = requestId;
      initialRequest = ckpt.userRequest; // App 直接进 running 态，Header 显示原需求
    } else {
      // 需求 = 第一个既不是 flag 也不是 flag 值的参数
      // （修复：--budget 0.5 --project demo "需求" 时，0.5/demo 是 flag 值，不能当需求）
      initialRequest =
        argv.find((a, i) => !a.startsWith('--') && !valueIdx.has(i)) ?? '';
      if (!isTty && !initialRequest) {
        // 非 TTY：从管道 stdin 读需求，否则 App 会卡在输入态无法提交
        initialRequest = await readStdin();
        if (!initialRequest) {
          logError(
            '启动错误',
            new Error(
              '非 TTY 模式必须提供需求：`npm run dev "需求"` 或 `echo "需求" | npm run dev`'
            )
          );
          process.exit(1);
        }
      }
    }

    // keep-alive interval：阻止 Node 进程在 stdin 暂停或 promise resolve 后
    // 立即退出，让 TUI 能停留在总结面板等用户按 q
    const keepAlive = setInterval(() => {}, 1 << 30);

    const { unmount, waitUntilExit } = render(
      <App
        initialRequest={initialRequest}
        resumeRequestId={resumeRequestId}
        loopPool={loopPool}
        isTty={isTty}
        onDone={() => {
          if (!isTty) {
            setTimeout(() => {
              clearInterval(keepAlive);
              unmount();
              process.exit(0);
            }, 500);
          }
          // TTY 模式：不在这里退出。Ink 的 useApp().exit() 会触发 waitUntilExit resolve
        }}
      />,
      { exitOnCtrlC: false }
    );

    // 等 Ink 实例真正退出（由用户按 q 触发 exit()）才清理并结束进程
    waitUntilExit().then(() => {
      clearInterval(keepAlive);
      process.exit(0);
    });
  } catch (error) {
    logError('启动错误', error);
    process.exit(1);
  }
}

import { pathToFileURL } from 'url';

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}

// 导出核心类型和类
export * from './types';
export * from './core';
export * from './agents';
export * from './execution';
export * from './storage';
export { loadConfig, loadModelsConfig } from './config';
