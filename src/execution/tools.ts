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
import { resolve as pathResolve, relative, dirname, basename, isAbsolute } from 'path';
import { glob as globCb } from 'glob';
import { realpathSync } from 'fs';

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
 * 把可能越界的路径拍回 workspace 内。
 *
 * 除规范化检查外，通过 realpathSync 解析符号链接真实路径，
 * 防止通过 symlink 逃逸出 workdir。目标文件尚不存在时（如 write_file
 * 创建新文件）捕获 ENOENT，改为对父目录做 realpath 校验。
 */
function safePath(ctx: ToolContext, target: string): string {
  const abs = isAbsolute(target) ? target : pathResolve(ctx.workspace, target);

  // 解析符号链接真实路径，防止 symlink 逃逸
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // 目标文件尚不存在（write_file 场景），对父目录做 realpath 校验
      const parent = dirname(abs);
      try {
        const realParent = realpathSync(parent);
        real = pathResolve(realParent, basename(abs));
      } catch {
        // 父目录也不存在，回退到规范化路径校验
        real = abs;
      }
    } else {
      // 其他错误（权限等），回退到规范化路径
      real = abs;
    }
  }

  const rel = relative(ctx.workspace, real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `[ACCESS_DENIED] 路径 "${target}" 不在工作目录内，**这是硬性边界，禁止尝试任何其他写法绕过**。\n` +
      `你的 workdir：${ctx.workspace}\n` +
      `如果你认为需要访问外部路径，请在最终回复里明确说明"任务需要 workdir 之外的访问权限"并停止——` +
      `不要用绝对路径、相对路径 ../、绕道 bash cd 等方式重试，所有尝试都会被拒绝。`
    );
  }
  return real;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${head}\n\n[... 输出被截断，省略 ${text.length - max} 字符 ...]`;
}

/**
 * 把工具调用参数规范化
 *
 * 某些第三方网关（方舟 / 火山 / 部分 LiteLLM 配置）把 OpenAI function-call
 * 协议直接转给 Anthropic SDK，导致 tool input 变成奇形怪状，常见几种：
 *
 *   1) input = { raw_arguments: "{\"path\":\"...\",\"content\":\"...\"}" }
 *      —— OpenAI 协议里 arguments 是字符串，被原样塞进了 Anthropic 的 input
 *   2) input = { arguments: "..." }
 *   3) input = "{\"path\":\"...\",\"content\":\"...\"}"
 *      —— 整个 input 是 JSON 字符串
 *
 * 这个函数尝试把这些情况解开成 { path, content, ... } 的常规形态。
 * expectedKeys 用来判断"是否已经是常规形态"——如果 input 直接含这些 key 就不动。
 */
function normalizeToolInput(input: any, expectedKeys: string[]): any {
  if (input == null) return {};

  // 已经是常规形态：直接含期望的 key
  if (typeof input === 'object' && expectedKeys.some((k) => k in input)) {
    return input;
  }

  // 整个 input 是 JSON 字符串
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }

  // input 是 { raw_arguments: "..." } 或 { arguments: "..." }
  if (typeof input === 'object') {
    for (const wrapKey of ['raw_arguments', 'arguments', 'input']) {
      const wrapped = (input as any)[wrapKey];
      if (typeof wrapped === 'string') {
        try {
          return JSON.parse(wrapped);
        } catch {
          // 解析失败，继续试其他 wrap key
        }
      } else if (wrapped && typeof wrapped === 'object') {
        return wrapped;
      }
    }
  }

  return input;
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
      execute: async (input: any) => {
        const { command, cwd, timeout_ms } = normalizeToolInput(input, ['command']);
        if (typeof command !== 'string') {
          throw new Error(`bash 参数无效：期望 { command: string }，收到 ${JSON.stringify(input).slice(0, 200)}`);
        }
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
        '读取 workspace 内的文本文件。**默认就传数组一次读多个相关文件**（如 ["a.ts","b.ts","c.ts"]），' +
        '减少往返次数——只有明确只读一个文件时才传单字符串。' +
        '单个文件支持可选行范围（offset/limit）；多文件时读全部内容。' +
        '每个文件内容带文件名头，整体超长截断。',
      inputSchema: z.object({
        path: z
          .array(z.string())
          .describe('要读取的文件路径数组（相对 workspace），如 ["src/index.ts","README.md"]。即使只读一个也用数组 ["a.ts"]'),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('从第几行开始读，1 起；缺省 1（仅单文件时有效）'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('最多读多少行；缺省 2000（仅单文件时有效）'),
      }),
      execute: async (input: any) => {
        const { path, offset = 1, limit = 2000 } = normalizeToolInput(input, ['path']);
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
      execute: async (input: any) => {
        // 容错：某些第三方网关（如方舟）会把 OpenAI 风格的 tool call 转给 Anthropic SDK，
        // 导致 input 变成 { raw_arguments: "<json-string>" } 而不是直接 { path, content }。
        // 检测并解开这种情况。
        const args = normalizeToolInput(input, ['path', 'content']);
        const { path, content } = args;
        if (typeof path !== 'string' || typeof content !== 'string') {
          throw new Error(
            `write_file 参数无效：期望 { path, content } 都是字符串，` +
            `实际收到 ${JSON.stringify(input).slice(0, 200)}`
          );
        }
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
      execute: async (input: any) => {
        const { pattern, ignore } = normalizeToolInput(input, ['pattern']);
        if (typeof pattern !== 'string') {
          throw new Error(`glob 参数无效：期望 { pattern: string }，收到 ${JSON.stringify(input).slice(0, 200)}`);
        }
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
      execute: async (input: any) => {
        const { pattern, include, flags = 'g' } = normalizeToolInput(input, ['pattern']);
        if (typeof pattern !== 'string') {
          throw new Error(`grep 参数无效：期望 { pattern: string }，收到 ${JSON.stringify(input).slice(0, 200)}`);
        }
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
