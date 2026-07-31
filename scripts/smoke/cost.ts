import { Orchestrator } from '../../src/core/orchestrator';

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
};

export async function run(): Promise<number> {
  const context = {
    accumulatedResults: new Map([['task-1', { metrics: { costUSD: 1.5 } }]]),
  };

  // 有预算
  const o1 = new Orchestrator({} as any, {} as any, { budgetUSD: 10 });
  const section1 = (o1 as any).costSection(context) as string;
  check('includes spent 1.5000', section1.includes('1.5000'));
  check('includes budget $10', section1.includes('预算 $10'));
  check('includes remaining $8.5000', section1.includes('剩余 $8.5000'));

  // 无预算（0）→ 不含预算文案
  const o2 = new Orchestrator({} as any, {} as any, { budgetUSD: 0 });
  const section2 = (o2 as any).costSection(context) as string;
  check('no budget → no budget text', !section2.includes('预算 $'));

  // 无成本数据 → 提示
  const o3 = new Orchestrator({} as any, {} as any, {});
  const section3 = (o3 as any).costSection({ accumulatedResults: new Map() }) as string;
  check('no cost data handled', section3.includes('无成本数据'));

  console.log(`cost: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  return failures;
}
