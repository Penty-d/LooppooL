import { run as runConfirm } from './confirm';
import { run as runRetry } from './retry';
import { run as runDangerous } from './dangerous';
import { run as runSummarize } from './summarize';
import { run as runRunLog } from './run-log';
import { run as runCost } from './cost';
import { run as runCancel } from './cancel';

async function main() {
  let failures = 0;
  failures += await runConfirm();
  failures += await runRetry();
  failures += await runDangerous();
  failures += await runSummarize();
  failures += await runRunLog();
  failures += await runCost();
  failures += await runCancel();

  console.log(
    failures === 0
      ? '\n===== ALL SMOKE TESTS PASS ====='
      : `\n===== ${failures} FAILURES =====`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
