import { generateText, stepCountIs, ModelMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { mkdirSync } from 'fs';
import { resolve as pathResolve } from 'path';
import { Task, ExecutionResult } from '../types';
import { ResolvedModel } from './model-registry';
import { createTools } from './tools';
import { logToolCall, logToolResult, logAgentText, logContextCompaction } from '../ui';

/**
 * Agent 执行引擎（基于 Vercel AI SDK）
 *
 * 替代了原来的 Claude CLI 子进程方案。每个任务跑一个独立的 tool loop：
 *   1. 用 model 的 baseURL/apiKey/authMode 临时构造 anthropic provider，互不污染
 *   2. generateText + 自带工具集（bash / read_file / write_file / glob / grep）
 *   3. stopWhen: stepCountIs(maxSteps) 控制循环上限，模型不再调工具时自然终止
 *   4. 工具操作受限在 workspace 目录内（safePath 校验越界）
 */
export class AgentEngine {
  private workspace: string;
  private maxSteps: number;
  private timeoutDefault: number;
  private maxInputTokens: number;

  constructor(opts: {
    workspace?: string;
    maxSteps?: number;
    timeoutDefault?: number;
    /**
     * 单步发送给模型的最大 input token 估算上限。
     * 超过则在 prepareStep 中压缩 messages（裁剪老 tool_result）。
     * 缺省 200_000，匹配 Claude 系列 200k context window；
     * 注意：若实际跑 128k context 的模型（如 DeepSeek），可能在压缩之前就被服务端拒掉，
     * 那时请显式调小这个值。
     */
    maxInputTokens?: number;
  } = {}) {
    // 缺省给所有任务一个共享 workspace；调用方也可在 task.input.workspace 覆盖
    this.workspace = pathResolve(opts.workspace ?? './.looppool-workspace');
    this.maxSteps = opts.maxSteps ?? 30;
    this.timeoutDefault = opts.timeoutDefault ?? 1_800_000;
    this.maxInputTokens = opts.maxInputTokens ?? 200_000;
    mkdirSync(this.workspace, { recursive: true });
  }

  async run(task: Task, model: ResolvedModel): Promise<ExecutionResult> {
    const startTime = new Date();
    // 工作目录决策（优先级从高到低）：
    //   1. task.workdir —— 调度器显式指定（侦察/优化现有项目时必填）
    //   2. validate 任务复用被验收任务的 workdir（在 task-executor.prepareTask 里已处理）
    //   3. 默认隔离 workspace（从零创建的场景，sandbox）
    const taskWorkspace = task.workdir
      ? pathResolve(task.workdir)
      : pathResolve(this.workspace, task.id);
    // 注意：调度器指定的 workdir 可能不存在（路径错误或项目未创建），
    // 这里不自动创建——让 agent 的工具调用报错暴露问题给调度器，
    // 而不是悄悄建一个空目录让 agent 以为项目在那里。
    // 默认隔离 workspace 才创建（agent 要在里面写文件）。
    if (!task.workdir) {
      mkdirSync(taskWorkspace, { recursive: true });
    }

    try {
      const provider = this.buildProvider(model);
      const tools = createTools({ workspace: taskWorkspace });

      const messages: ModelMessage[] = [
        { role: 'user', content: task.prompt },
      ];

      const { text, steps, finishReason, usage } = await generateText({
        model: provider(model.modelId),
        system: this.systemPrompt(taskWorkspace, task),
        messages,
        tools,
        stopWhen: stepCountIs(this.maxSteps),
        abortSignal: AbortSignal.timeout(task.timeout ?? this.timeoutDefault),
        onStepFinish: (step) => this.logStep(task.id, step),
        prepareStep: ({ messages }) => {
          const compacted = this.compactIfNeeded(messages, task.id);
          return compacted ? { messages: compacted } : {};
        },
      });

      const endTime = new Date();

      return {
        taskId: task.id,
        status: 'success',
        output: text || '(模型未输出最终总结)',
        metrics: {
          startTime,
          endTime,
          duration: endTime.getTime() - startTime.getTime(),
          modelUsed: model.modelId,
          tier: model.tier,
          tokensUsed:
            (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || undefined,
          // 把 step 数 / 终止原因放进 suggestions，便于上游 orchestrator 观察
          suggestions: [
            `finishReason=${finishReason}`,
            `steps=${steps.length}`,
            `workspace=${taskWorkspace}`,
          ],
        },
      };
    } catch (error: any) {
      const endTime = new Date();
      return {
        taskId: task.id,
        status: 'failed',
        error: error?.message ?? String(error),
        metrics: {
          startTime,
          endTime,
          duration: endTime.getTime() - startTime.getTime(),
          modelUsed: model.modelId,
          tier: model.tier,
        },
      };
    }
  }

  /**
   * 用本次任务的 model 配置构造一个临时 anthropic provider，零全局污染
   *
   * baseURL 必须带 /v1 后缀（@ai-sdk/anthropic 默认是 https://api.anthropic.com/v1）。
   * 用户在 models.json 配的 baseURL 不带 /v1，这里补上。
   */
  private buildProvider(model: ResolvedModel) {
    const baseURL = this.normalizeBaseURL(model.baseURL);
    const opts: Parameters<typeof createAnthropic>[0] = { baseURL };
    if (model.authMode === 'bearer') {
      opts.authToken = model.apiKey;
    } else {
      opts.apiKey = model.apiKey;
    }
    // 自定义 fetch：兼容方舟等第三方 anthropic 网关的响应瑕疵
    //   方舟 glm-5.2 返回 thinking block 时缺 signature 字段，
    //   @ai-sdk/anthropic 严格校验会抛 TypeValidationError。
    //   这里拦截响应给 thinking block 补一个占位 signature。
    opts.fetch = patchThinkingSignature;
    return createAnthropic(opts);
  }

  private normalizeBaseURL(url: string): string {
    const trimmed = url.replace(/\/+$/, '');
    return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }

  /**
   * 系统提示词：按 task.kind 给两套不同纪律
   *
   * - execute: 干活的 agent —— 调查 → 计划 → 动手 → 自验 → 总结
   * - validate: 验收的 agent —— 必须用工具实际查证，禁止仅凭 output 文本判分
   *
   * 共同基底：工具使用纪律、输出格式、错误处理、不允许假装。
   */
  private systemPrompt(workspace: string, task: Task): string {
    const isWin = process.platform === 'win32';
    const envInfo = isWin
      ? `运行环境：Windows + PowerShell。bash 工具实际调用 PowerShell——命令必须用 PowerShell 语法（Get-Content 而非 cat、Get-ChildItem 而非 ls -la、Select-String 而非 grep、$env:VAR 而非 $VAR）。路径分隔符 \\ 和 / 都可。`
      : `运行环境：Linux/macOS + bash。bash 工具调用 /bin/sh——使用标准 Unix 命令（ls -la / cat / grep / find）。`;

    const base = `你是一名运行在受控 sandbox 中的 coding agent。

工作目录（绝对路径）：${workspace}
${envInfo}

所有文件操作和命令执行都必须使用工具完成，绝对不要在文本里假装写文件、假装运行命令。
工具：bash（执行 shell，语法见上）、read_file（读取文件）、write_file（覆盖写入文件）、glob（按模式找文件）、grep（按正则搜内容）。

通用纪律：
1. **workdir 是硬边界**：你的所有文件操作必须在 workdir 内。一旦工具返回 [ACCESS_DENIED]，**立即停下来**——
   - 不要换个写法重试（绝对路径、../、cd ..、Get-Content C:\\xxx 等都会被拒）
   - 不要假装"试试看"——所有越界尝试都会失败
   - 直接在最终回复里说"任务需要 workdir 之外的访问权限"并停止，让调度器决定怎么办
   - 即使 bash 表面上能 cd 到外面，也禁止——这是纪律不是技术限制
2. **先调查再动手**：改文件前先 read_file / glob / grep 看清现状，禁止凭空编造路径和代码结构。
3. **写文件 = 覆盖整个文件**：write_file 会替换整个内容，部分修改也必须先 read_file 拼好完整内容再写。
4. **批量并行调用**：多个独立的读取 / 搜索可以一次发起多个 tool call，不要串行排队。
   **read_file 默认传数组一次读多个相关文件**——如 read_file({path:["a.ts","b.ts","c.ts"]})，
   不要一个一个读浪费时间往返。
5. **遇错三步**：① 看 stderr 找原因；② 提一个最具体的修复假设；③ 用一条最小命令验证假设。同一个错误最多重试 2 次，再失败就停下说明。命令报"找不到 cmdlet"通常是 shell 语法用错了——切换到当前 shell 的等价命令。**但 [ACCESS_DENIED] 错误不适用此规则，零重试直接停。**
6. **不要假装成功**：完不成就直说"无法完成 + 原因 + 已经尝试过什么"。
7. **简洁、就事论事**：不寒暄、不为自己辩护、不重复贴大段代码、不解释你"接下来要做什么"——直接做。`;

    if (task.kind === 'validate') {
      return `${base}

==========================================
本次任务类型：**验收（validate）**
==========================================
你正在审查另一个 agent 产出的成果。**你当前的 workspace 就是被验收任务的工作目录**——产物文件直接在这里，用 read_file / glob / bash 就能看到，不需要跨目录。

前置任务的 output 文本已注入到用户消息里，但**那段文本只是参考，不是事实**——前一个 agent 完全可能撒谎或自我误判。

验收硬性要求：
1. **必须用工具实际查证**：用 read_file 读产物文件、用 bash 跑测试 / 编译 / 运行命令、用 glob 确认文件存在。**禁止仅凭前置任务 output 文本就下结论**。
2. **逐条对照验收标准**：用户给的每条 criteria 都要单独验证，明确写出"我用了什么工具、看到了什么、是否通过"。
3. **找问题，不是找借口**：默认带着怀疑读代码——它是否真的能跑？测试覆盖了边界吗？路径是否如声明那样？
4. **criteria 里给的命令本身可能有错**：如果某条命令跑不通，先判断是命令本身问题还是产物问题，分别处理；不要因为命令坏就把产物判 fail。

输出格式（最终一段文字）：
- **检查清单**：逐条列 criteria 的验证过程和结论（pass / fail）
- **整体评分**：0-100 整数 + 一句话理由（评分必须基于实际验证结果，不是基于前置任务的自述）
- **关键问题**（如有）：影响验收通过的具体问题，每条带文件路径和行号
- **建议**（可选）：如何修复

不要用 read_file 之外的方式"听信"前置任务的 output。`;
    }

    return `${base}

==========================================
本次任务类型：**执行（execute）**
==========================================
推荐工作流：
1. **理解任务**：用一两句话陈述你对任务的理解（不要写"接下来我将..."这种废话，直接陈述目标）。
2. **必要时调查**：如果任务涉及修改已有代码，先 glob / read_file 看相关文件；新建项目则跳过。
3. **动手**：用 write_file 创建/修改文件，用 bash 跑命令。
4. **自验**：写完代码必须用 bash 实际运行一次（python xxx.py / node xxx.js / npm test 等）确认产物可用。**没自验过的代码不算完成。**
5. **总结**：用下面的格式做最后一段文字回复。

完成标准（同时满足才算完成）：
- 所有应产出的文件都已 write_file 落盘
- 至少一次 bash 验证产物可运行（脚本能执行 / 测试能通过 / 编译无错）
- 给出最终总结

最终回复格式：
- **做了什么**：1-3 句话
- **产物**：列出每个文件的相对/绝对路径
- **验证**：你跑了什么命令、得到什么输出（贴关键行即可）
- **已知限制**（可选）：什么没做、什么需要后续处理`;
  }

  // ============================================================
  // 上下文（messages）压缩
  // ============================================================

  /**
   * 粗略 token 估算：字符数 / 3.5（中英混合的经验值，非精确）
   *
   * 不引入 tokenizer 依赖；Anthropic 真实 tokenizer 内部不公开，估算只需够预警即可。
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }

  /**
   * 估算单条 message 的 token：把所有内容序列化后估算
   */
  private estimateMessageTokens(msg: ModelMessage): number {
    if (typeof msg.content === 'string') {
      return this.estimateTokens(msg.content);
    }
    if (Array.isArray(msg.content)) {
      let total = 0;
      for (const part of msg.content) {
        // 文本类直接算
        if ('text' in part && typeof (part as any).text === 'string') {
          total += this.estimateTokens((part as any).text);
        } else if ((part as any).type === 'tool-result') {
          const out = (part as any).output;
          if (out?.type === 'text' && typeof out.value === 'string') {
            total += this.estimateTokens(out.value);
          } else {
            total += this.estimateTokens(JSON.stringify(out));
          }
        } else {
          // tool-call 等其他 part：序列化估算
          total += this.estimateTokens(JSON.stringify(part));
        }
      }
      return total;
    }
    return this.estimateTokens(JSON.stringify(msg.content));
  }

  /**
   * 在 prepareStep 中按需压缩 messages
   *
   * 策略（保守）：
   *   1) 估算总 token，未超阈值返回 null（不改）
   *   2) 保留：第一条 user 消息（原始任务）+ 最后 KEEP_RECENT 步内的所有消息
   *   3) 压缩对象：中间的 role='tool' 消息里的每个 tool-result.output —— 替换为占位文本
   *      tool-call（assistant 里的）保留：模型仍能看到"我之前调用过什么"
   *   4) 反复检查总长，若仍超阈值，就再扩大压缩范围（缩小 KEEP_RECENT）
   *
   * 注意：不能丢消息（会破坏 tool_use ↔ tool_result 配对），只能改内容。
   */
  private compactIfNeeded(
    messages: ModelMessage[],
    taskId: string
  ): ModelMessage[] | null {
    const total = messages.reduce(
      (sum, m) => sum + this.estimateMessageTokens(m),
      0
    );
    if (total <= this.maxInputTokens) return null;

    // 逐步缩小"保留近 N 步"窗口直到达标，最少保留 1 步
    for (let keepRecent = 4; keepRecent >= 1; keepRecent--) {
      const compacted = this.compactToolResults(messages, keepRecent);
      const newTotal = compacted.reduce(
        (sum, m) => sum + this.estimateMessageTokens(m),
        0
      );
      if (newTotal <= this.maxInputTokens) {
        logContextCompaction(taskId, total, newTotal, keepRecent);
        return compacted;
      }
    }

    // 最激进的也压不下来：返回最激进的版本，让 SDK 自己决定（可能直接 413/超限报错）
    const fallback = this.compactToolResults(messages, 1);
    const newTotal = fallback.reduce(
      (sum, m) => sum + this.estimateMessageTokens(m),
      0
    );
    logContextCompaction(taskId, total, newTotal, 1);
    return fallback;
  }

  /**
   * 把"老的" tool-result 输出替换为占位文本，保留 tool-call 部分。
   *
   * 实现：把 messages 看成线性序列，定位每对 tool-call ↔ tool-result。
   * 最后 keepRecentSteps 个 (assistant+tool) 对保留原样，更早的 tool 消息里
   * 每个 tool-result.output 替换为简短占位。
   *
   * 不删消息条目本身——破坏 tool_use/tool_result 配对会让 Anthropic API 直接拒绝。
   */
  private compactToolResults(
    messages: ModelMessage[],
    keepRecentSteps: number
  ): ModelMessage[] {
    // 找出所有 tool 消息的索引
    const toolMsgIdx: number[] = [];
    messages.forEach((m, i) => {
      if (m.role === 'tool') toolMsgIdx.push(i);
    });

    // 最后 keepRecentSteps 个 tool 消息保留原样
    const keepFrom = Math.max(0, toolMsgIdx.length - keepRecentSteps);
    const toCompactIdx = new Set(toolMsgIdx.slice(0, keepFrom));

    return messages.map((m, i) => {
      if (!toCompactIdx.has(i) || m.role !== 'tool') return m;
      // 替换该 tool 消息中每个 tool-result 的 output
      const newContent = (m.content as any[]).map((part) => {
        if (part?.type !== 'tool-result') return part;
        const origLen = this.estimateMessageTokens({
          role: 'user',
          content: [part],
        } as any);
        return {
          ...part,
          output: {
            type: 'text',
            value: `[truncated by LoopPool context compaction: original output ~${origLen} tokens]`,
          },
        };
      });
      return { ...m, content: newContent } as ModelMessage;
    });
  }

  // ============================================================
  // 步骤日志
  // ============================================================

  /**
   * 实时打印每个推理步骤——让你看到 agent 工作过程，而不是黑盒等结束
   *
   * 每步可能包含：
   *   - text:        模型说的话（思考 / 总结 / 决定下一步）
   *   - toolCalls:   本步发起的工具调用（参数）
   *   - toolResults: 上一步工具的执行结果
   * 输出按 task.id 加前缀，并发时不会混
   */
  private logStep(taskId: string, step: any): void {
    // 配对工具调用与结果：调用 → 结果 一起打，便于阅读
    const calls = step.toolCalls ?? [];
    const results = step.toolResults ?? [];
    const resultById = new Map<string, any>();
    for (const r of results) resultById.set(r.toolCallId, r);

    for (const call of calls) {
      logToolCall(taskId, call.toolName, this.briefArgs(call.input));
      const r = resultById.get(call.toolCallId);
      if (r) {
        const out = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
        logToolResult(taskId, this.brief(out, 200));
      }
    }

    if (step.text && step.text.trim()) {
      logAgentText(taskId, this.brief(step.text, 300));
    }
  }


  private brief(s: string, max = 120): string {
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
  }

  private briefArgs(input: any): string {
    if (!input) return '';
    try {
      return this.brief(JSON.stringify(input), 80);
    } catch {
      return '<unserializable>';
    }
  }
}

/**
 * 自定义 fetch 包装器：给 thinking content block 补 signature 字段
 *
 * 背景：@ai-sdk/anthropic 严格校验 Anthropic 协议，要求 thinking block 必须带
 * signature 字段（extended thinking 协议）。但方舟（火山引擎）等第三方网关
 * 返回 thinking block 时不带 signature，导致 SDK 抛 TypeValidationError。
 *
 * 这里拦截 /v1/messages 响应，给所有缺 signature 的 thinking block 补一个
 * 占位值，让 SDK 校验通过。占位 signature 不会被用于实际验证（第三方网关
 * 不做 signature 校验），纯粹是满足 schema。
 */
async function patchThinkingSignature(
  url: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(url as any, init as any);
  // 只处理 messages API 的 JSON 响应
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return res;

  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data && Array.isArray(data.content)) {
      let patched = false;
      for (const block of data.content) {
        if (block && block.type === 'thinking' && block.signature === undefined) {
          block.signature = 'patched-by-looppool';
          patched = true;
        }
      }
      if (patched) {
        return new Response(JSON.stringify(data), {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
    }
  } catch {
    // JSON 解析失败，原样返回
  }
  // 没改动，重建一个等价 Response（text 已被消费）
  return new Response(text, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * 自定义 fetch 包装器：给方舟等第三方网关的 thinking block 补 signature 字段
 *
 * 背景：@ai-sdk/anthropic 严格要求 thinking content block 带 signature 字段
 * （Anthropic extended thinking 协议）。方舟 glm-5.2 返回 thinking 但没 signature，
 * 导致 SDK 校验失败、抛 Invalid JSON response。
 *
 * 实现：拦截 /v1/messages 响应，解析 JSON，给缺 signature 的 thinking block
 * 补一个占位值，再重新序列化返回给 SDK。
 */
