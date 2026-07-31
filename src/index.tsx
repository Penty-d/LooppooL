import React from 'react';
import { render } from 'ink';
import { LoopPool } from './core';
import { loadConfig, loadModelsConfig } from './config';
import { printFinalResult, logError } from './ui';
import { App } from './tui/App';

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
    const loopPool = new LoopPool(config, models);

    const isTty = process.stdin.isTTY === true;

    // TTY：一启动就切到备用屏幕，整个交互都在全屏窗口里
    if (isTty) {
      enterFullscreen();
      const restore = () => exitFullscreen();
      process.on('exit', restore);
      process.on('SIGINT', () => { restore(); process.exit(0); });
      process.on('SIGTERM', () => { restore(); process.exit(0); });
    }

    // 解析 argv：--resume [requestId] 走恢复路径；否则 argv[0] 是需求
    const argv = process.argv.slice(2);
    const resumeIdx = argv.indexOf('--resume');
    const resuming = resumeIdx !== -1;

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
      initialRequest = argv[0] || '';
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
