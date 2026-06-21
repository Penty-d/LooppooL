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

    // 从命令行参数预填需求（可选），否则 App 内部用输入框收集
    const initialRequest = process.argv[2] || '';

    // keep-alive interval：阻止 Node 进程在 stdin 暂停或 promise resolve 后
    // 立即退出，让 TUI 能停留在总结面板等用户按 q
    const keepAlive = setInterval(() => {}, 1 << 30);

    const { unmount, waitUntilExit } = render(
      <App
        initialRequest={initialRequest}
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
export { loadConfig, loadModelsConfig } from './config';
