import { run as runConfirm } from './confirm';
import { run as runRetry } from './retry';
import { run as runDangerous } from './dangerous';

async function main() {
  let failures = 0;
  failures += await runConfirm();
  failures += await runRetry();
  failures += await runDangerous();

  console.log(
    failures === 0
      ? '\n===== ALL SMOKE TESTS PASS ====='
      : `\n===== ${failures} FAILURES =====`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
