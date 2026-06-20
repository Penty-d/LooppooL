import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
  stat,
} from 'fs/promises';
import { resolve as pathResolve, relative, dirname, isAbsolute } from 'path';
import { glob as globCb } from 'glob';

const execAsync = promisify(exec);

/**
 * 工具运行上下文：所有工具受限在 workspace 目录内
 */
export interface ToolContext {
  workspace: string;
  bashTimeout?: number;
  maxOutputBytes?: number;
}

const DEFAULT_BASH_TIMEOUT = 60_000;
const DEFAULT_MAX_OUTPUT = 100_000; // ~100KB，避免一次回灌把 context 撑爆

/**
 * 把可能越界的路径拍回 workspace 内
 */
function safePath(ctx: ToolContext, target: string): string {
  const abs = isAbsolute(target) ? target : pathResolve(ctx.workspace, target);
  const rel = relative(ctx.workspace, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `路径越界：${target}（必须在 workspace ${ctx.workspace} 内）`
    );
  }
  return abs;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${head}\n\n[... 输出被截断，省略 ${text.length - max} 字符 ...]`;
}

/**
 * 构建工具集
 *
 * 每个工具都绑定到给定 workspace。模型调用工具时会被路径校验拦住越界访问。
 * 工具返回值统一为字符串，便于模型阅读。
 */
export function createTools(ctx: ToolContext) {
  const maxOut = ctx.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const bashTimeout = ctx.bashTimeout ?? DEFAULT_BASH_TIMEOUT;

  // 检测当前 shell 环境，让模型知道用什么语法
  const isWin = process.platform === 'win32';
  const shellName = isWin ? 'PowerShell' : 'bash/sh';
  const shellExe = isWin ? 'powershell.exe' : '/bin/sh';
  const shellHints = isWin
    ? '当前是 Windows PowerShell。注意：ls 不支持 -la（用 Get-ChildItem 或 dir）；cat 用 Get-Content；grep 用 Select-String；路径用反斜杠或正斜杠均可；管道和变量用 $ 前缀。'
    : '当前是 Linux/macOS bash。可用标准 Unix 命令：ls -la、cat、grep、find 等。';

  return {
    bash: tool({
      description:
        `在 workspace 目录下执行 shell 命令。${shellHints} ` +
        '返回 stdout + stderr。命令超时或非零退出码会作为错误返回，不会抛异常。' +
        '如果某条命令因 shell 语法不符报错，换用当前 shell 兼容的写法重试，不要坚持错误的语法。',
      inputSchema: z.object({
        command: z.string().describe('要执行的 shell 命令（必须符合当前 shell 语法）'),
        cwd: z
          .string()
          .optional()
          .describe('相对 workspace 的子目录；缺省使用 workspace 根'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`超时毫秒数，缺省 ${bashTimeout}`),
      }),
      execute: async ({ command, cwd, timeout_ms }) => {
        const targetCwd = cwd ? safePath(ctx, cwd) : ctx.workspace;
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: targetCwd,
            timeout: timeout_ms ?? bashTimeout,
            maxBuffer: 10 * 1024 * 1024,
            shell: shellExe,
            windowsHide: true,
          });
          const out = [stdout, stderr ? `STDERR:\n${stderr}` : '']
            .filter(Boolean)
            .join('\n');
          return truncate(out || '(no output)', maxOut);
        } catch (err: any) {
          // exec 在非零退出 / 超时都会 throw，把 stdout/stderr 都拼出来交给模型分析
          const parts = [
            `exit_code: ${err.code ?? 'unknown'}`,
            err.killed ? `killed: true (likely timeout)` : '',
            err.stdout ? `stdout:\n${err.stdout}` : '',
            err.stderr ? `stderr:\n${err.stderr}` : '',
            err.message ? `message: ${err.message}` : '',
          ].filter(Boolean);
          return truncate(parts.join('\n'), maxOut);
        }
      },
    }),

    read_file: tool({
      description:
        '读取 workspace 内的文本文件。支持一次读多个文件（传 path 数组），' +
        '也支持可选行范围（对单个文件有效；多文件时读全部）。' +
        '每个文件内容带文件名头，超长截断。',
      inputSchema: z.object({
        path: z
          .union([z.string(), z.array(z.string())])
          .describe('相对 workspace 的文件路径，可传单个字符串或数组（一次读多个）'),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('从第几行开始读，1 起；缺省 1（仅对单文件有效）'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('最多读多少行；缺省 2000（仅对单文件有效）'),
      }),
      execute: async ({ path, offset = 1, limit = 2000 }) => {
        const paths = Array.isArray(path) ? path : [path];
        const parts: string[] = [];
        for (const p of paths) {
          try {
            const abs = safePath(ctx, p);
            const content = await fsReadFile(abs, 'utf-8');
            if (paths.length === 1) {
              // 单文件：支持 offset/limit
              const lines = content.split('\n');
              const start = Math.max(0, offset - 1);
              const slice = lines.slice(start, start + limit);
              const numbered = slice
                .map((line, i) => `${start + i + 1}: ${line}`)
                .join('\n');
              parts.push(`# ${p} (lines ${start + 1}-${start + slice.length} of ${lines.length})\n${numbered}`);
            } else {
              // 多文件：每个只显示带行号的完整内容（不截行，整体受 maxOut 限制）
              const lines = content.split('\n');
              const numbered = lines
                .map((line, i) => `${i + 1}: ${line}`)
                .join('\n');
              parts.push(`# ${p} (${lines.length} lines)\n${numbered}`);
            }
          } catch (err: any) {
            parts.push(`# ${p}\n[读取失败: ${err.message}]`);
          }
        }
        const joined = paths.length > 1
          ? parts.join('\n\n' + '═'.repeat(40) + '\n\n')
          : parts[0];
        return truncate(joined || '(empty)', maxOut);
      },
    }),

    write_file: tool({
      description:
        '把内容完整写入 workspace 内的一个文件。父目录会自动创建。' +
        '会覆盖已有文件——若是部分修改请先 read_file 再 write_file。',
      inputSchema: z.object({
        path: z.string().describe('相对 workspace 的文件路径'),
        content: z.string().describe('文件完整内容'),
      }),
      execute: async ({ path, content }) => {
        const abs = safePath(ctx, path);
        await mkdir(dirname(abs), { recursive: true });
        await fsWriteFile(abs, content, 'utf-8');
        const s = await stat(abs);
        return `wrote ${path} (${s.size} bytes)`;
      },
    }),

    glob: tool({
      description:
        '按 glob 模式查找 workspace 内的文件，返回相对路径列表。' +
        '常用于在不知道具体文件名时定位代码。',
      inputSchema: z.object({
        pattern: z
          .string()
          .describe('glob 模式，如 "src/**/*.ts" 或 "**/*.test.{ts,tsx}"'),
        ignore: z
          .array(z.string())
          .optional()
          .describe('要排除的 glob 列表'),
      }),
      execute: async ({ pattern, ignore }) => {
        const matches = await globCb(pattern, {
          cwd: ctx.workspace,
          ignore: ['node_modules/**', 'dist/**', '.git/**', ...(ignore ?? [])],
          nodir: true,
          dot: false,
        });
        if (matches.length === 0) return '(no matches)';
        return truncate(matches.join('\n'), maxOut);
      },
    }),

    grep: tool({
      description:
        '在 workspace 内按正则搜索文件内容，返回命中行（含文件路径和行号）。' +
        '用于查找符号定义、关键词出现位置等。',
      inputSchema: z.object({
        pattern: z.string().describe('JavaScript 正则表达式（不含两端 / 分隔符）'),
        include: z
          .string()
          .optional()
          .describe('限定搜索的文件 glob，如 "src/**/*.ts"'),
        flags: z
          .string()
          .optional()
          .describe('正则 flags，缺省 "g"，常用 "gi" 忽略大小写'),
      }),
      execute: async ({ pattern, include, flags = 'g' }) => {
        const files = await globCb(include ?? '**/*', {
          cwd: ctx.workspace,
          ignore: ['node_modules/**', 'dist/**', '.git/**'],
          nodir: true,
          dot: false,
        });
        const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
        const hits: string[] = [];
        for (const rel of files) {
          const abs = pathResolve(ctx.workspace, rel);
          let text: string;
          try {
            text = await fsReadFile(abs, 'utf-8');
          } catch {
            continue; // 二进制文件等
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i])) {
              hits.push(`${rel}:${i + 1}: ${lines[i]}`);
              if (hits.length >= 500) break;
            }
          }
          if (hits.length >= 500) break;
        }
        if (hits.length === 0) return '(no matches)';
        return truncate(hits.join('\n'), maxOut);
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof createTools>;
