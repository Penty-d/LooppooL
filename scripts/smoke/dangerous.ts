import { isDangerousCommand } from '../../src/execution/dangerous';

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
};

export async function run(): Promise<number> {
  const cases: [string, 'win' | 'posix', boolean][] = [
    // ── 危险（应命中）──
    ['rm -rf /', 'posix', true],
    ['rm -rf /etc', 'posix', true],
    ['mkfs.ext4 /dev/sda1', 'posix', true],
    ['dd if=/dev/zero of=/dev/sda', 'posix', true],
    ['fdisk /dev/sda', 'posix', true],
    ['sudo poweroff', 'posix', true],
    ['init 0', 'posix', true],
    ['systemctl reboot', 'posix', true],
    ['shutdown /s', 'win', true],
    ['diskpart', 'win', true],
    ['reg delete HKLM\\Software\\X', 'win', true],
    ['Remove-Item -Path C:\\ -Recurse -Force', 'win', true],
    ['Remove-Item -Path "C:\\Windows\\System32" -Recurse', 'win', true],
    // ── 安全（不应命中）──
    ['rm -rf dist', 'posix', false],
    ['rm -rf src/old', 'posix', false],
    ['npm install', 'posix', false],
    ['git status', 'posix', false],
    ['python script.py', 'posix', false],
    ['Get-ChildItem C:\\Windows', 'win', false],
    ['Remove-Item .\\tmp\\old -Recurse', 'win', false],
  ];

  for (const [cmd, platform, expect] of cases) {
    const hit = isDangerousCommand(cmd, platform);
    check(`${platform}: "${cmd}" → ${expect ? 'dangerous' : 'safe'}`, hit.dangerous === expect);
  }

  console.log(`dangerous: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  return failures;
}
