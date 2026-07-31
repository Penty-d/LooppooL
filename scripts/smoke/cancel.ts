import { TaskPool } from '../../src/core/task-pool';
import type { Task, ExecutionResult } from '../../src/types';

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
};

function mkTask(id: string): Task {
  return { id, kind: 'execute', model: 'a', description: 'd', prompt: 'p' };
}

export async function run(): Promise<number> {
  const registry: any = { resolve: () => ({ id: 'a', concurrent: true }) };

  // 1. 取消运行中的任务：stub executor 永不 resolve，abort 时 reject
  let calls = 0;
  let startedResolve: () => void;
  const started = new Promise<void>((r) => { startedResolve = r; });

  const executor: any = {
    execute: async (task: Task, signal?: AbortSignal) => {
      calls++;
      startedResolve();
      return new Promise<ExecutionResult>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
  const pool = new TaskPool(executor, registry, 10, 2); // taskRetries=2 → 取消不应触发重试

  const planPromise = pool.executePlan({
    reasoning: 'r',
    createdAt: new Date(),
    stages: [{ id: 's', mode: 'parallel', tasks: [mkTask('t')] }],
  });

  await started;
  pool.cancelTask('t');

  const results = await Promise.race([
    planPromise,
    new Promise<Map<string, ExecutionResult>>((_, rej) =>
      setTimeout(() => rej(new Error('PLAN HUNG')), 3000)
    ),
  ]);
  check('plan resolves (no hang)', results instanceof Map);
  check('task marked failed', results.get('t')?.status === 'failed');
  check('executed exactly 1 attempt (no retry)', calls === 1);
  check('error mentions abort', (results.get('t')?.error ?? '').includes('aborted'));

  // 2. 暂停：新任务不启动，恢复后继续
  let taskRan = false;
  const executor2: any = {
    execute: async () => {
      taskRan = true;
      return {
        taskId: 't2',
        status: 'success',
        output: 'ok',
        metrics: { startTime: new Date(), endTime: new Date(), duration: 1, modelUsed: 'a' },
      } as ExecutionResult;
    },
  };
  const pool2 = new TaskPool(executor2, registry, 10, 0);
  pool2.pause();
  const planPromise2 = pool2.executePlan({
    reasoning: 'r',
    createdAt: new Date(),
    stages: [{ id: 's', mode: 'serial', tasks: [mkTask('t2')] }],
  });
  await new Promise((r) => setTimeout(r, 300));
  check('task not started while paused', !taskRan);
  pool2.resume();
  const results2 = await planPromise2;
  check('task runs after resume', results2.get('t2')?.status === 'success');

  console.log(`cancel: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  return failures;
}
