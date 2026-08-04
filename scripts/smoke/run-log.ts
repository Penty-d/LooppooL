import { loadRunLog, appendRunLog } from '../../src/run-log';
import { rmSync } from 'fs';

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
};

export async function run(): Promise<number> {
  const key = `smoke_test_${Date.now()}`;
  try {
    check('no projectKey → []', loadRunLog().length === 0);
    check('missing project → []', loadRunLog('nonexistent_key_xyz').length === 0);

    for (let i = 0; i < 60; i++) appendRunLog(key, `entry-${i}`);
    const mems = loadRunLog(key);
    check('capped at 50', mems.length === 50);
    check('last entry present', mems[mems.length - 1] === 'entry-59');
    check('oldest dropped', !mems.includes('entry-0'));
  } finally {
    rmSync(`./data/run-logs/${key}.jsonl`, { force: true });
  }

  // 非法 projectKey 路径穿越 → 抛错
  let traversalOk = true;
  for (const bad of ['../x', 'a/b', '.hidden', '']) {
    try {
      appendRunLog(bad, 'x');
      traversalOk = false;
    } catch {
      /* 期望抛错 */
    }
  }
  check('invalid projectKey rejected', traversalOk);

  console.log(`run-log: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  return failures;
}
