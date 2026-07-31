import {
  requestConfirm,
  respondConfirm,
  registerConfirmResponder,
  unregisterConfirmResponder,
} from '../../src/confirm';
import { bus } from '../../src/events';

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
};

export async function run(): Promise<number> {
  // 1. 无 responder → 默认拒绝
  unregisterConfirmResponder();
  const noResp = await requestConfirm('x');
  check('no responder → false', noResp === false);

  // 2. responder 批准
  registerConfirmResponder((id) => respondConfirm(id, true));
  check('responder approve → true', (await requestConfirm('x')) === true);

  // 3. responder 拒绝
  registerConfirmResponder((id) => respondConfirm(id, false));
  check('responder reject → false', (await requestConfirm('x')) === false);

  // 4. user-confirm 事件被观测（审计通道）
  const seen: string[] = [];
  const listener = (p: any) => seen.push(p.message);
  bus.on('user-confirm' as any, listener);
  registerConfirmResponder((id) => respondConfirm(id, true));
  await requestConfirm('hello-confirm');
  bus.off('user-confirm' as any, listener);
  check('user-confirm event observed', seen.includes('hello-confirm'));

  // 5. 超时 → 拒绝
  registerConfirmResponder(() => {
    /* 不响应，等超时 */
  });
  const start = Date.now();
  const timedOut = await requestConfirm('x', { timeoutMs: 50 });
  check('timeout → false', timedOut === false);
  check('timeout elapsed ~50ms', Date.now() - start >= 40);

  unregisterConfirmResponder();
  console.log(`confirm: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  return failures;
}
