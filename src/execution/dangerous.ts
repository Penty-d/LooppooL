/**
 * 危险 shell 命令检测
 *
 * 只拦「系统破坏性」命令（格式化磁盘、关机、删系统目录、dd 直写块设备等）。
 * **不**一刀切拦 rm -rf —— agent 在自己的 workdir 里清理产物（rm -rf dist 等）是正常操作，
 * workdir 硬边界已经把 agent 限制在项目目录内。
 */

export type Platform = 'win' | 'posix';

export interface DangerousPattern {
  id: string;
  label: string;
  platform: Platform | 'both';
  regex: RegExp;
}

export const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // ── 磁盘 / 分区 ──
  { id: 'mkfs', platform: 'both', label: '格式化文件系统 (mkfs)', regex: /\bmkfs(?:\.\w+)?\b.*?\/dev\/\S+/i },
  { id: 'format-drive', platform: 'win', label: '格式化磁盘 (format C:)', regex: /\bformat\s+[a-z]:\s*/i },
  { id: 'format-volume', platform: 'win', label: '格式化卷 (Format-Volume)', regex: /\bformat-volume\b/i },
  { id: 'diskpart', platform: 'win', label: '磁盘分区工具 (diskpart)', regex: /\bdiskpart\b/i },
  { id: 'clear-disk', platform: 'win', label: '清除磁盘 (Clear-Disk)', regex: /\bclear-disk\b/i },
  { id: 'initialize-disk', platform: 'win', label: '初始化磁盘 (Initialize-Disk)', regex: /\binitialize-disk\b/i },
  { id: 'fdisk', platform: 'posix', label: '分区工具 (fdisk)', regex: /\bfdisk\b.*?\/dev\//i },
  { id: 'parted', platform: 'posix', label: '分区工具 (parted)', regex: /\bparted\b.*?\/dev\//i },
  { id: 'wipefs', platform: 'posix', label: '清除分区表 (wipefs)', regex: /\bwipefs\b/i },
  // dd 直写块设备
  { id: 'dd-block', platform: 'both', label: 'dd 直写块设备', regex: /\bdd\b(?=[^;\n]*\bof=\/dev\/)(?=[^;\n]*\bif=)/i },

  // ── 关机 / 重启 ──
  { id: 'shutdown', platform: 'both', label: '关机/重启', regex: /\b(?:shutdown|poweroff|reboot|halt|restart-computer|stop-computer)\b/i },
  { id: 'init-shutdown', platform: 'posix', label: 'init 0/6 关机重启', regex: /\binit\s+[06]\b/ },
  { id: 'systemctl-power', platform: 'posix', label: 'systemctl 关机重启', regex: /\bsystemctl\s+(?:halt|poweroff|reboot)\b/i },

  // ── 注册表删除 ──
  { id: 'reg-delete', platform: 'win', label: '删除注册表', regex: /(?:reg\s+delete|remove-item[^\n]*(?:HKLM:|HKCU:|HKCR:|HKU:|HKCC:))/i },

  // ── 系统目录删除（不是 blanket rm -rf，只拦系统根 / 系统目录）──
  { id: 'rm-root', platform: 'posix', label: '删除根目录 (rm -rf /)', regex: /\brm\s+-[a-z]*r[a-z]*\s+\//i },
  { id: 'rm-system-dir', platform: 'posix', label: '删除系统目录', regex: /\brm\s+-[a-z]*r[a-z]*\s+\/(?:bin|etc|usr|var|lib|boot|sbin|sys|proc|dev|root)\b/i },
  { id: 'del-system-dir', platform: 'win', label: '删除系统目录', regex: /\b(?:remove-item|del|rd|rmdir)\b[^\n]*(?:[a-z]:\\(?:Windows|Program Files|ProgramData|System32|Users))\b/i },
  { id: 'del-drive-root', platform: 'win', label: '删除磁盘根目录', regex: /\b(?:remove-item|del|rd|rmdir)\b[^\n]*\b[a-z]:\\?(?=\s|["']|$)/i },

  // ── 其他 ──
  { id: 'chmod-root', platform: 'posix', label: '递归改根目录权限', regex: /\bchmod\s+-R\s+[0-7]{3,4}\s+\//i },
];

/** 检测命令是否命中危险模式。返回命中的 pattern（用于展示命中规则）。 */
export function isDangerousCommand(
  command: string,
  platform: Platform = process.platform === 'win32' ? 'win' : 'posix'
): { dangerous: boolean; pattern?: DangerousPattern } {
  for (const p of DANGEROUS_PATTERNS) {
    if (p.platform !== 'both' && p.platform !== platform) continue;
    p.regex.lastIndex = 0;
    if (p.regex.test(command)) {
      return { dangerous: true, pattern: p };
    }
  }
  return { dangerous: false };
}
