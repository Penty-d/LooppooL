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
// 启用鼠标跟踪（1000=基本按钮，1006=SGR 格式，让滚轮发 \x1B[<64;...M / \x1B[<65;...M）
const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1006l';

function enterFullscreen(): void {
  process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR + ENABLE_MOUSE);
}

function exitFullscreen(): void {
  process.stdout.write(DISABLE_MOUSE + SHOW_CURSOR + EXIT_ALT_SCREEN);
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

    const { unmount } = render(
      <App
        initialRequest={initialRequest}
        loopPool={loopPool}
        isTty={isTty}
        onDone={() => {
          if (!isTty) {
            setTimeout(() => {
              unmount();
              process.exit(0);
            }, 500);
          }
        }}
      />
    );
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
