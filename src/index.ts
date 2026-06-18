import * as readline from 'readline';
import { LoopPool } from './core';
import { loadConfig, loadModelsConfig } from './config';
import { printBanner, printRequest, printFinalResult, logError } from './ui';
import chalk from 'chalk';

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function main() {
  printBanner();

  try {
    const config = loadConfig();
    const models = loadModelsConfig();
    const loopPool = new LoopPool(config, models);

    const userRequest =
      process.argv[2] ||
      (await ask(chalk.gray('▸ ') + chalk.bold('请输入任务需求: ')));

    if (!userRequest) {
      logError('启动失败', '未提供任务需求');
      process.exit(1);
    }

    printRequest(userRequest);

    const result = await loopPool.execute(userRequest);

    if (result?.result) {
      printFinalResult(result.result);
    }
  } catch (error) {
    logError('运行错误', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// 导出核心类型和类
export * from './types';
export * from './core';
export * from './agents';
export * from './execution';
export { loadConfig, loadModelsConfig } from './config';
