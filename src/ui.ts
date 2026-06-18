import chalk from 'chalk';
import ora, { Ora } from 'ora';

/**
 * 终端 UI 工具集 —— 统一颜色、图标、分组打印
 *
 * 设计原则：
 *   - 所有日志走这里，避免散落 console.log 各种风格不一
 *   - 使用语义化颜色：调度=cyan、执行=green、验收=magenta、错误=red、info=灰
 *   - 任务级日志带 [task-id] 前缀，并发时也能分辨
 */

const C = {
  brand: chalk.hex('#a78bfa'), // 紫
  orchestrator: chalk.cyan,
  execute: chalk.green,
  validate: chalk.magenta,
  agent: chalk.gray,
  toolCall: chalk.blue,
  toolResult: chalk.gray,
  thought: chalk.yellow,
  ok: chalk.greenBright,
  warn: chalk.yellow,
  err: chalk.red,
  dim: chalk.gray,
  bold: chalk.bold,
  num: chalk.bold.white,
};

const ICON = {
  brand: '✦',
  brain: '🧠',
  hammer: '🔨',
  check: '✔',
  cross: '✘',
  arrow: '→',
  curve: '↳',
  bubble: '💬',
  sparkle: '✨',
  warn: '⚠',
  pin: '▸',
};

/* ============================================================
 * 启动横幅 / 收尾摘要
 * ============================================================ */

export function printBanner(): void {
  const line = '─'.repeat(54);
  console.log();
  console.log(C.brand(`╭${line}╮`));
  console.log(
    C.brand('│  ') +
      C.bold(`${ICON.brand} LoopPool`) +
      C.dim('  multi-agent orchestration                ') +
      C.brand('│')
  );
  console.log(C.brand(`╰${line}╯`));
  console.log();
}

export function printRequest(request: string): void {
  console.log(C.dim(`${ICON.pin} 用户需求`));
  console.log('  ' + request);
  console.log();
}

/* ============================================================
 * 调度器 / 阶段 / 任务标题
 * ============================================================ */

export function logIteration(n: number, max: number): void {
  console.log();
  console.log(
    C.orchestrator(`╔══ 迭代 ${n}/${max} ════════════════════════════════`)
  );
}

export function logPlanning(): void {
  console.log(C.orchestrator(`${ICON.brain} 调度器规划中…`));
}

export function logPlanReady(stages: number, tasks: number): void {
  console.log(
    C.orchestrator(`${ICON.check} 计划生成: `) +
      C.num(`${stages}`) +
      C.dim(' 阶段 / ') +
      C.num(`${tasks}`) +
      C.dim(' 任务')
  );
}

export function logReasoning(text: string): void {
  if (!text) return;
  console.log(C.dim('  规划思路: ') + C.dim(text));
}

export function logStage(
  index: number,
  total: number,
  id: string,
  mode: 'parallel' | 'serial',
  taskCount: number
): void {
  const modeColor = mode === 'parallel' ? C.warn : C.dim;
  console.log();
  console.log(
    C.bold(`▸ Stage ${index}/${total}`) +
      C.dim(`  (${id})  `) +
      modeColor(`[${mode}]  `) +
      C.dim(`${taskCount} 任务`)
  );
}

export function logTaskStart(
  taskId: string,
  modelId: string,
  description: string,
  kind: 'execute' | 'validate'
): void {
  const tag = kind === 'execute' ? C.execute('●EXEC') : C.validate('●VLDT');
  console.log(
    `  ${tag} ${C.bold(`[${taskId}]`)} ${C.dim(`(${modelId})`)} ${description}`
  );
}

export function logTaskDone(
  taskId: string,
  ok: boolean,
  durationMs: number,
  modelUsed: string
): void {
  const dur = (durationMs / 1000).toFixed(2) + 's';
  if (ok) {
    console.log(
      `  ${C.ok(ICON.check)} ${C.bold(`[${taskId}]`)} ${C.dim(`完成 (${dur}, ${modelUsed})`)}`
    );
  } else {
    console.log(
      `  ${C.err(ICON.cross)} ${C.bold(`[${taskId}]`)} ${C.dim(`失败 (${dur})`)}`
    );
  }
}

export function logTaskError(taskId: string, msg: string): void {
  console.log(`  ${C.err(ICON.cross)} ${C.bold(`[${taskId}]`)} ${C.err(msg)}`);
}

export function logStageSummary(success: number, total: number): void {
  const ok = success === total;
  const icon = ok ? C.ok(ICON.check) : C.warn(ICON.warn);
  console.log(
    `  ${icon} 阶段完成: ${C.num(`${success}/${total}`)} ${C.dim(
      ok ? '全部成功' : `${total - success} 失败`
    )}`
  );
}

export function logCriticalAbort(): void {
  console.log(
    `  ${C.warn(ICON.warn)} ${C.warn('检测到关键失败，终止后续 Stage')}`
  );
}

/* ============================================================
 * Agent 工具调用日志（agent-engine 内部用）
 * ============================================================ */

export function logToolCall(taskId: string, toolName: string, briefArgs: string): void {
  console.log(
    `    ${C.dim(`[${taskId}]`)} ${C.toolCall(ICON.arrow + ' ' + toolName)}${C.dim(`(${briefArgs})`)}`
  );
}

export function logToolResult(taskId: string, brief: string): void {
  console.log(
    `    ${C.dim(`[${taskId}]`)} ${C.toolResult(ICON.curve + ' ' + brief)}`
  );
}

export function logAgentText(taskId: string, brief: string): void {
  console.log(
    `    ${C.dim(`[${taskId}]`)} ${C.thought(ICON.bubble + ' ' + brief)}`
  );
}

/* ============================================================
 * 决策 / 结果
 * ============================================================ */

export function logDecisionStart(): void {
  console.log();
  console.log(C.orchestrator(`${ICON.brain} 调度器分析与决策中…`));
}

export function logDecision(
  shouldContinue: boolean,
  qualityScore: number,
  reason: string
): void {
  const head = shouldContinue
    ? C.warn(`${ICON.warn} 需要继续优化`)
    : C.ok(`${ICON.check} 任务完成`);
  console.log(
    `${head}  ` + C.dim('质量评分: ') + scoreColor(qualityScore)(`${qualityScore}/100`)
  );
  console.log(C.dim('  理由: ') + reason);
}

function scoreColor(score: number) {
  if (score >= 90) return C.ok;
  if (score >= 80) return C.warn;
  return C.err;
}

export function printFinalSummary(opts: {
  iterations: number;
  totalTasks: number;
  qualityScore?: number;
  status: 'completed' | 'partial';
}): void {
  const line = '─'.repeat(54);
  const head =
    opts.status === 'completed'
      ? C.ok(`${ICON.sparkle} 任务完成 ${ICON.sparkle}`)
      : C.warn(`${ICON.warn} 部分完成（达到最大迭代次数）`);
  console.log();
  console.log(C.brand(`╭${line}╮`));
  console.log('  ' + head);
  console.log(
    '  ' +
      C.dim('迭代: ') +
      C.num(`${opts.iterations}`) +
      C.dim('   任务: ') +
      C.num(`${opts.totalTasks}`) +
      (opts.qualityScore !== undefined
        ? C.dim('   评分: ') + scoreColor(opts.qualityScore)(`${opts.qualityScore}/100`)
        : '')
  );
  console.log(C.brand(`╰${line}╯`));
  console.log();
}

export function printFinalResult(result: any): void {
  console.log(C.bold('最终结果'));
  console.log(C.dim('─'.repeat(54)));
  if (result?.summary) {
    console.log(C.bold('摘要: ') + result.summary);
    console.log();
  }
  if (result?.outputs && Object.keys(result.outputs).length > 0) {
    console.log(C.bold('产物:'));
    for (const [k, v] of Object.entries(result.outputs)) {
      console.log('  ' + C.dim(`${k}: `) + String(v));
    }
    console.log();
  }
}

/* ============================================================
 * 错误 / spinner
 * ============================================================ */

export function logError(prefix: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // message 可能多行（含摘要 + 完整原文路径），首行红字、其余缩进灰字
  const [first, ...rest] = msg.split('\n');
  console.log(`${C.err(ICON.cross)} ${C.bold(prefix)}: ${C.err(first)}`);
  for (const line of rest) {
    if (!line.trim()) continue;
    // "完整原文: path" 这一行特殊处理：把路径独立染色，引导用户去看
    const fileMatch = line.match(/^(完整原文|raw):\s*(.+)$/);
    if (fileMatch) {
      console.log(
        `   ${C.dim(fileMatch[1] + ':')} ${C.brand(fileMatch[2])}` +
          C.dim('  ← 打开此文件查看完整内容')
      );
    } else {
      console.log(`   ${C.dim(line)}`);
    }
  }
}

export function spinner(text: string): Ora {
  return ora({ text: C.dim(text), spinner: 'dots' });
}
