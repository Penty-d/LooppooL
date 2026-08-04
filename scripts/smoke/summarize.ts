import { AgentEngine, applySummaryReplacement } from '../../src/execution/agent-engine';
import type { ModelMessage } from 'ai';
import type { Task, ResolvedModel } from '../../src/types';

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
};

function mkMsg(role: string, content: any): ModelMessage {
  return { role, content } as ModelMessage;
}

const model: ResolvedModel = {
  id: 'a',
  tier: 'low',
  provider: 'p',
  modelId: 'm',
  baseURL: 'https://x',
  apiKey: 'k',
  authMode: 'api-key',
  concurrent: true,
};
const task: Task = { id: 't', kind: 'execute', model: 'a', description: 'd', prompt: 'p' };

export async function run(): Promise<number> {
  // 1. applySummaryReplacement 纯函数：首条保留、index1 是 [工作摘要]、尾部配对完好
  const msgs: ModelMessage[] = [
    mkMsg('user', 'task'),
    mkMsg('assistant', [{ type: 'text', text: 'r1' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'bash', args: 'x' }]),
    mkMsg('tool', [{ type: 'tool-result', toolCallId: 'c1', toolName: 'bash', output: { type: 'text', value: 'OUT1' } }]),
    mkMsg('assistant', [{ type: 'text', text: 'r2' }, { type: 'tool-call', toolCallId: 'c2', toolName: 'bash', args: 'y' }]),
    mkMsg('tool', [{ type: 'tool-result', toolCallId: 'c2', toolName: 'bash', output: { type: 'text', value: 'OUT2' } }]),
    mkMsg('assistant', [{ type: 'text', text: 'FINAL' }]),
  ];
  const replaced = applySummaryReplacement(msgs, 3, '总结文本');
  check('first user message preserved', replaced[0] === msgs[0]);
  check('index1 is [工作摘要]', typeof replaced[1].content === 'string' && (replaced[1].content as string).startsWith('[工作摘要]'));
  check('summary text included', JSON.stringify(replaced).includes('总结文本'));
  check('trailing messages preserved (tool pairing intact)', replaced[2] === msgs[3] && replaced[3] === msgs[4] && replaced[4] === msgs[5]);
  check('total length 5', replaced.length === 5);

  // 2. compactIfNeeded 全路径：老对话大 tool 输出超预算 → 假摘要器 → 工作摘要替换
  const bigMsgs: ModelMessage[] = [
    mkMsg('user', 'task'),
    mkMsg('assistant', [{ type: 'text', text: 'r1' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'bash', args: 'x' }]),
    mkMsg('tool', [{ type: 'tool-result', toolCallId: 'c1', toolName: 'bash', output: { type: 'text', value: 'A'.repeat(20000) } }]),
    mkMsg('assistant', [{ type: 'text', text: 'r2' }, { type: 'tool-call', toolCallId: 'c2', toolName: 'bash', args: 'y' }]),
    mkMsg('tool', [{ type: 'tool-result', toolCallId: 'c2', toolName: 'bash', output: { type: 'text', value: 'B'.repeat(20000) } }]),
    mkMsg('assistant', [{ type: 'text', text: 'FINAL' }]),
  ];
  // 两个 tool 输出都很大：compactToolResults 截断旧的那个也压不进预算（保留的仍大），
  // 才逼出摘要路径（截断够用就优先截断，这是设计行为）
  const engine = new AgentEngine({ maxInputTokens: 200, summarizerOverride: async () => 'FAKE' }) as any;
  const out = await engine.compactIfNeeded(bigMsgs, task, model, 2000);
  check('compactIfNeeded returns non-null', Array.isArray(out));
  const str = JSON.stringify(out);
  check('summary inserted', str.includes('FAKE'));
  check('recent step preserved', str.includes('FINAL'));

  // 3. 摘要失败 → 兜底剥离，仍返回数组
  const engine2 = new AgentEngine({ maxInputTokens: 200, summarizerOverride: async () => null }) as any;
  const out2 = await engine2.compactIfNeeded(bigMsgs, task, model, 2000);
  check('summarizer fail → fallback returns array', Array.isArray(out2));

  // 4. 未超预算 → 不压缩
  const small = [mkMsg('user', 'hi')];
  const out3 = await engine.compactIfNeeded(small, task, model, 1_000_000);
  check('below budget → null', out3 === null);

  console.log(`summarize: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  return failures;
}
