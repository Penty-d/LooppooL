import { TaskPool } from '../../src/core/task-pool';
import type { Task, ExecutionResult } from '../../src/types';

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
};

function mkTask(id: string, over: Partial<Task> = {}): Task {
  return { id, kind: 'execute', model: 'a', description: 'd', prompt: 'p', ...over };
}

function mkResult(status: 'success' | 'failed'): ExecutionResult {
  return {
    taskId: 't',
    status,
    error: status === 'failed' ? 'boom' : undefined,
    output: status === 'success' ? 'ok' : undefined,
    metrics: {
      startTime: new Date(),
      endTime: new Date(),
      duration: 10,
      modelUsed: 'a',
    },
  };
}

export async function run(): Promise<number> {
  // 1. 失败两次后成功 → 总执行 3 次 + 退避耗时（1s + 2s）
  {
    let calls = 0;
    const executor: any = {
      execute: async () => {
        calls++;
        return calls < 3 ? mkResult('failed') : mkResult('success');
      },
    };
    const registry: any = { resolve: () => ({ id: 'a', concurrent: true }) };
    const pool = new TaskPool(executor, registry, 10, 2); // taskRetries=2 → 最多 3 次
    const start = Date.now();
    const res = await pool.executePlan({
      reasoning: 'r',
      createdAt: new Date(),
      stages: [{ id: 's', mode: 'serial', tasks: [mkTask('t')] }],
    });
    const elapsed = Date.now() - start;
    check('failed twice then success → success', res.get('t')?.status === 'success');
    check('executed 3 times', calls === 3);
    check(`backoff elapsed ≥ 3000ms (got ${elapsed}ms)`, elapsed >= 3000);
  }

  // 2. retryable:false → 即使 taskRetries=3 也只执行 1 次
  {
    let calls = 0;
    const executor: any = {
      execute: async () => {
        calls++;
        return mkResult('failed');
      },
    };
    const registry: any = { resolve: () => ({ id: 'a', concurrent: true }) };
    const pool = new TaskPool(executor, registry, 10, 3);
    await pool.executePlan({
      reasoning: 'r',
      createdAt: new Date(),
      stages: [{ id: 's', mode: 'serial', tasks: [mkTask('t', { retryable: false })] }],
    });
    check('retryable:false → exactly 1 attempt', calls === 1);
  }

  // 3. 并行阶段：重试只拖慢该任务，不阻塞其他任务
  {
    const callCounts: Record<string, number> = {};
    const executor: any = {
      execute: async (task: Task) => {
        const n = (callCounts[task.id] = (callCounts[task.id] ?? 0) + 1);
        if (task.id === 't-slow' && n < 3) return mkResult('failed');
        return mkResult('success');
      },
    };
    const registry: any = { resolve: () => ({ id: 'a', concurrent: true }) };
    const pool = new TaskPool(executor, registry, 10, 2);
    const start = Date.now();
    const res = await pool.executePlan({
      reasoning: 'r',
      createdAt: new Date(),
      stages: [
        {
          id: 'p',
          mode: 'parallel',
          tasks: [mkTask('t-slow'), mkTask('t-fast')],
        },
      ],
    });
    const elapsed = Date.now() - start;
    check('parallel slow task retried to success', res.get('t-slow')?.status === 'success');
    check('parallel fast task ok', res.get('t-fast')?.status === 'success');
    // 并行下最慢任务退避 1s+2s，但 fast 任务不用等 → 总耗时仍是 ~3s（受慢任务拖累）
    check('parallel completed', elapsed >= 3000);
  }

  console.log(`retry: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  return failures;
}
