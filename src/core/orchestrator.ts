import {
  AnthropicClient,
} from '../llm';
import {
  Context,
  ExecutionPlan,
  ExecutionResult,
  Decision,
} from '../types';
import { ModelRegistry } from '../execution/model-registry';
import { jsonrepair } from 'jsonrepair';
import {
  logPlanning,
  logPlanReady,
  logReasoning,
  logDecisionStart,
  logDecision,
} from '../ui';
import { dumpRawLog, summarize } from '../log-store';

/**
 * 调度器（Orchestrator）—— 系统的唯一「大脑」
 *
 * 与执行器的根本区别：
 *   - 调度器直连 Anthropic API（手写 fetch），要的是**结构化 JSON**（计划/决策）
 *   - 执行器走 AgentEngine（Vercel AI SDK + 工具集），要的是**真正干活** + 富文本结果
 *
 * 调度器的职责：
 *   1) 理解用户需求，分解为子任务
 *   2) 为每个任务判断难度，选择 tier（high/medium/low）
 *   3) 为每个任务**现场编写 prompt**（用户不需要自己写）
 *   4) 识别可并行（互不关联）/ 必须串行（有依赖）的任务
 *   5) 分析执行结果并决策是否继续迭代
 */
export class Orchestrator {
  private client: AnthropicClient;
  private registry: ModelRegistry;

  constructor(client: AnthropicClient, registry: ModelRegistry) {
    this.client = client;
    this.registry = registry;
  }

  /** 生成初始执行计划 */
  async generatePlan(context: Context): Promise<ExecutionPlan> {
    logPlanning();

    const text = await this.client.complete(
      this.systemPrompt(),
      this.buildPlanningPrompt(context)
    );

    // DEBUG：无论解析成功与否，都把原始输出落盘，方便排查"空 plan / 一直迭代"
    const debugDump = dumpRawLog(context.requestId, `plan-raw-iter${context.history.length + 1}`, text);

    const plan = this.parsePlan(text, context.requestId);
    logPlanReady(plan.stages.length, this.countTasks(plan));
    logReasoning(plan.reasoning);
    return plan;
  }

  /** 分析结果并决策 */
  async analyzeAndDecide(
    context: Context,
    plan: ExecutionPlan,
    results: Map<string, ExecutionResult>
  ): Promise<Decision> {
    logDecisionStart();

    const text = await this.client.complete(
      this.systemPrompt(),
      this.buildAnalysisPrompt(context, plan, results)
    );

    // DEBUG：决策原始输出也落盘
    const debugDump = dumpRawLog(context.requestId, `decision-raw-iter${context.history.length + 1}`, text);

    const decision = this.parseDecision(text, context.requestId);
    logDecision(decision.shouldContinue, decision.qualityScore, decision.reason);
    return decision;
  }

  // ---------------- prompts ----------------

  private systemPrompt(): string {
    return `你是一个多模型协同系统的"大脑"——只规划与决策，永远不亲自执行。

执行单元是「任务」。每个任务交给一个执行 agent，agent 拥有 bash / read_file / write_file / glob / grep 工具，能在受控 workspace 里真实读写文件、运行命令。

你的四项职责：
  1) 把用户需求拆解成可独立执行的任务。
  2) 为每个任务挑模型（execute 看难度选 tier，validate 通常选 high tier）。
  3) **为每个任务亲自写完整 prompt**——这是你最重要的输出，决定 agent 干得好不好。
  4) 看到执行结果后判断"够好了"还是"再来一轮"，给出依据。

==========================================
**侦察优先**原则（处理"需要先了解才能动手"的需求）
==========================================
当用户的需求**依赖你不知道的事实**时——例如"优化我的项目"、"重构 X 模块"、"修复 bug"、"继续开发"——你**不知道项目长什么样**，不能直接计划具体修改。

正确做法：
  · **第一轮：只派侦察任务**。让 agent 用 read_file / glob / grep / bash 探索项目，并把关键事实**作为 output 文本返回给你**——文件树、技术栈、模块依赖、潜在问题、TODO 注释等。
  · **第二轮（在 analysis 阶段）：基于 agent 的 output 文本你自己做出具体决策**，写 newPlan 派出真正的修改任务。
  · **绝不要**让侦察 agent 把分析写到 audit.md 之类的文档里，然后让下一个 agent "读那个文档"——这样**你（调度器）什么都没看到**，等于把决策权完全交了出去。
  · 侦察 agent 的 prompt 必须明确要求："把发现以**结构化文本**形式写到最终回复里（按目录树、关键文件清单、问题列表组织），**不要**写到任何文件，**不要**做任何修改"。

什么需求适合"一轮直达"（不需要侦察）：
  · 从零创建（"创建 helloworld"、"写个加法函数"）—— 没有现存项目可看
  · 用户已经精确指定了文件/位置/做法 —— 没有不确定性

什么需求**必须侦察优先**：
  · 含有"我的项目"、"现有代码"、"重构"、"优化"、"审计"、"修复" —— 你需要先看
  · 用户描述模糊，多种解读可能性 —— 先派 agent 调查清楚再说

==========================================

任务类型只有两种：
  - execute  ：实际产出代码/文件/答案；侦察任务也属于这类（产出是结构化分析文本）
  - validate ：审查某个 execute 任务的产出，给出评分和问题清单

==========================================
**workdir（工作目录）—— 每个 task 的文件访问边界**
==========================================
agent 的所有文件操作（read_file / write_file / glob / grep / bash cwd）都被限制在 workdir 内，
无法访问 workdir 之外的任何路径。所以你必须在每个 task 上填对 workdir：

  · **从零创建**（"创建 helloworld"、"写个加法函数"）→ workdir 留空，系统给隔离 sandbox
  · **侦察/优化/重构现有项目**（"优化我的项目"、"重构 X 模块"）→ workdir 必须填项目根目录的**绝对路径**
    （从用户需求里提取，如 "D:\\\\Projects\\\\user"；如果需求里没明确路径，第一轮先派 agent 用 bash 探索
     常见位置如当前目录、~、D:\\\\ 等，把找到的绝对路径写到 output 里，下一轮再据此填 workdir）
  · **validate 任务** → workdir 留空，系统自动复用被验收任务的 workdir

**关键**：workdir 必须是真实存在的目录。如果你臆造一个不存在的路径，agent 会立刻报错"目录不存在"并停止，
浪费一轮迭代。不确定路径时先侦察，别猜。

为 execute 任务写 prompt 时必须包含（缺一不可）：
  · **目标**：一句话说清要产出什么
  · **产物位置**：相对 workdir 的路径（如 "src/add.ts"），不要写绝对路径——绝对路径由 workdir 决定
  · **完成判定**：怎样才算完成（"能 python 跑通输出 X" / "npm test 全过" / "至少 N 个测试用例"）
  · **质量约束**（按需）：代码风格、安全要求、性能预期
  · 不要在 prompt 里说"接下来你要..."这种引导词，直接陈述要求

为 validate 任务写 prompt 时必须包含：
  · **审查对象**：通过 input.targetTaskId 指向被验收任务（系统会自动把那个任务的 output 拼进 prompt 末尾，但你要提醒 agent："那段 output 只是参考，必须用工具实际验证产物"）
  · **input.criteria 数组**：列出明确、可机器验证的检查点（如"hello.py 文件存在"、"运行 python hello.py 输出包含 Hello"）—— 越具体越好
  · **取证要求**：在 prompt 里要求 agent 用 read_file / bash 实际跑一遍，**禁止只读 output 文本就打分**

挑模型原则：
  · 难/关键/最终验收 → tier=high
  · 常规实现 / 写测试 → tier=medium
  · 简单格式化 / 改名 / 样板 → tier=low
  · 同一 tier 多个模型时尽量分散到不同模型，提高并行度
  · 只能使用清单中存在的 id

输出始终是合法 JSON，不带任何 Markdown 代码围栏，不带额外文字。`;
  }

  /** 渲染可用模型清单，注入规划/决策 prompt */
  private catalogText(): string {
    const catalog = this.registry.catalog();
    return JSON.stringify(catalog, null, 2);
  }

  private buildPlanningPrompt(context: Context): string {
    return `请为以下用户需求生成执行计划。

可用模型清单（只能从中挑选，把模型条目的 id 填进任务的 "model" 字段）：
${this.catalogText()}

==========================================
并行 vs 串行：用三步判断，不要凭感觉
==========================================
对每对任务 A、B 问自己：
  Q1) B 的执行需要 A 已经产出的文件 / 数据 / 状态吗？  → 是：必须串行
  Q2) A、B 会同时写同一个文件 / 改同一份代码吗？        → 是：必须串行
  Q3) B 的 prompt 里需要引用 A 的输出吗？               → 是：必须串行（典型：validate 引用 execute）
全部回答"否"才能放进同一个 parallel 阶段。

阶段之间永远顺序执行，所以遇到依赖直接拆到下一阶段就好。
不要把一个本质不可分割的大任务硬拆进 parallel 来"看起来更并行"。
并行任务尽量分散到不同模型 id（concurrent=false 的模型同一时刻只能跑一个）。

**stage.mode 必须如实反映 tasks 实际情况**：
  · 只有 1 个 task 的阶段 → mode 必须是 "serial"，禁止写 "parallel"（一个任务无所谓并行）
  · ≥ 2 个 task 且彼此独立 → mode = "parallel"
  · ≥ 2 个 task 且有依赖 → mode = "serial"
  · reasoning 里的描述必须与 stages 实际结构完全一致：写"并行"前先确认那个阶段真的有多个独立任务；写"串行"前先确认确实存在依赖
  · 不要在 reasoning 里描述未在 stages 中实现的拆分（例如计划要拆成两个测试任务但最后合并成一个时，reasoning 必须更新，不能保留旧的"并行测试"叙述）

==========================================
为每个任务写 prompt 的检查清单
==========================================
execute 任务的 prompt 必须包含：
  ☐ 一句话目标
  ☐ 产物文件路径（明确到具体路径，不要"在合适位置"这种话）
  ☐ 完成判定标准（"能跑出 X" / "测试覆盖 Y" 之类，agent 据此知道何时停下）
  ☐ 关键质量约束（如适用）

validate 任务的 prompt 必须包含：
  ☐ "请审查 task-N 的产物"明确指认对象
  ☐ 提醒：output 文本只是参考，必须用 read_file / bash 等工具实际验证
  ☐ 评分依据要基于实际验证证据，不是基于前置任务的自述

==========================================
输出 JSON 结构
==========================================
{
  "reasoning": "你的规划思路（为什么这样拆、为什么这样并行/串行）",
  "stages": [
    {
      "id": "stage-1",
      "mode": "parallel",
      "tasks": [
        {
          "id": "task-1",
          "kind": "execute",
          "model": "清单中某个模型 id",
          "description": "简短描述（用于日志，10 字以内）",
          "workdir": "绝对路径（侦察/优化现有项目时必填；从零创建留空）",
          "prompt": "完整指令——目标、产物相对路径、完成判定全写进来"
        }
      ]
    },
    {
      "id": "stage-2",
      "mode": "serial",
      "tasks": [
        {
          "id": "task-2",
          "kind": "validate",
          "model": "通常选 tier 高的 id",
          "description": "验收 task-1",
          "prompt": "请审查 task-1 的产物。前一个任务的 output 已附在末尾，但只是参考——必须用 read_file 读实际文件、用 bash 运行命令实际验证。逐条对照 criteria 给出 pass/fail 和证据。",
          "input": {
            "targetTaskId": "task-1",
            "criteria": [
              "明确、可机器验证的检查点 1",
              "明确、可机器验证的检查点 2"
            ]
          }
        }
      ]
    }
  ]
}
${
  context.history.length > 0
    ? `\n==========================================\n历史执行记录（之前的尝试）—— 请据此改进\n==========================================\n${JSON.stringify(
        this.summarizeHistory(context.history),
        null,
        2
      )}\n要点：\n  · 之前失败的具体原因别再犯\n  · 已经验证有效的部分不要推倒重做，只补缺漏\n  · 如果之前评分卡在某几条，本次要专门修这几条\n`
    : ''
}
==========================================
用户需求
==========================================
${context.userRequest}

只输出 JSON，不要任何 Markdown 围栏或解释文字。`;
  }

  private buildAnalysisPrompt(
    context: Context,
    plan: ExecutionPlan,
    results: Map<string, ExecutionResult>
  ): string {
    const resultsArray = Array.from(results.entries()).map(([id, result]) => ({
      taskId: id,
      status: result.status,
      output: result.output,
      error: result.error,
      model: result.metrics.model,
      modelUsed: result.metrics.modelUsed,
    }));

    return `请分析执行结果并决策是否继续迭代。

==========================================
可用模型清单（newPlan 里 task.model 必须从中挑选 id，禁止使用清单外的任何模型 id）
==========================================
${this.catalogText()}

==========================================
原始需求
==========================================
${context.userRequest}

==========================================
本轮执行计划
==========================================
${JSON.stringify(plan, null, 2)}

==========================================
本轮执行结果
==========================================
${JSON.stringify(resultsArray, null, 2)}

==========================================
判断流程（逐条过，不要跳）
==========================================

**第 0 步：本轮是不是「侦察轮」？**
如果本轮的任务都是"调查/审计/收集信息"性质（agent 没动手改代码，只是返回了对项目状态的分析文本），那么**永远不要把侦察轮判为完成**——侦察的目的是给你提供事实依据，让你下一轮做真正的修改。
此时：
  · shouldContinue = true
  · 仔细阅读 agent output 中的项目分析（文件列表、模块、问题、建议）
  · 在 **newPlan** 里基于这些事实设计真正的修改任务（具体到哪些文件做什么改动）
  · qualityScore 给侦察质量打分（agent 的 output 是否包含足够事实让你能做下轮决策）
  · reason 要说"本轮是侦察轮，已收集到 X、Y、Z，下一轮将基于此实施 A、B、C"

只有不是侦察轮才走下面常规流程：

1) **execute 任务都成功了吗？**（status === 'success'）
   有失败 → shouldContinue=true，newPlan 里只重做失败的那部分

2) **validate 任务真的做了实际验证吗？**
   看 validate 任务的 output：是否提到具体的 read_file / bash 调用、具体的文件内容、命令的实际输出？
   如果只是空泛地说"已通过"而没有证据 → 视为验收无效，shouldContinue=true，新计划里换一个更严格的 validate prompt

3) **达成原始需求了吗？**
   不是看"任务都跑完了"，是看"用户最初要的东西到手了"。
   - 用户要"创建 helloworld" → 真有那个文件、能跑出输出，才算到手
   - 用户要"重构模块 X" → X 真的被改且能编译/测试通过，才算到手

4) **质量是否值得停**（用 0-100 评分）：
   ≥ 90：完成度高、有实证、可直接交付 → shouldContinue=false
   80-89：基本可用但有小瑕疵、或验收证据不够强 → 看用户需求严苛程度自行判断
   < 80：有明显缺漏 → shouldContinue=true，newPlan 修

==========================================
关于 newPlan 的强提醒
==========================================
shouldContinue=true 时，**newPlan 必须基于本轮 results 的具体内容**——你已经看到 agent 的 output 了，新计划就该用那些事实。
不要在 newPlan 里再写"先调查 X 再修 Y"——你**现在**就有调查结果，**现在**就该写修 Y 的具体任务（含文件路径、改什么、判定标准）。
新计划写完后会被**直接执行**，不会再调用一次 generatePlan，所以你写多细就执行多细。

==========================================
输出 JSON 结构
==========================================
{
  "shouldContinue": boolean,
  "reason": "用 1-3 句话说清依据，必须引用具体证据（哪个任务的什么 output 让你这么判断）",
  "qualityScore": 0-100 整数,
  "newPlan": { "reasoning": "...", "stages": [...] },
  "finalResult": {
    "summary": "完成摘要",
    "outputs": { "key": "value 形式列出关键产物，例如文件路径、运行命令、验证结果" },
    "metadata": {
      "totalIterations": ${context.history.length + 1},
      "totalTasks": ${results.size},
      "totalTime": 0
    }
  }
}

shouldContinue=true 时给 newPlan（finalResult 留空或省略）；
shouldContinue=false 时给 finalResult（newPlan 省略）。
只输出 JSON，不要 Markdown 围栏。`;
  }

  // ---------------- parsing ----------------

  private extractJson(text: string): string {
    // 去掉可能的 ```json ... ``` 围栏
    // 用贪婪匹配找最后一个 ```，避免被 JSON 内容中嵌套的代码围栏截断
    const fenced = text.match(/```(?:json)?\s*([\s\S]*)```/);
    if (fenced) return fenced[1].trim();

    const match = text.match(/\{[\s\S]*\}/);
    return match ? match[0] : text;
  }

  /**
   * 容错 JSON 解析
   *
   * LLM 输出 JSON 时常见瑕疵：
   *   1) Windows 路径反斜杠不转义（D:\Projects\user）
   *   2) 中文长文本里不转义内嵌双引号
   *   3) 尾随逗号
   *
   * jsonrepair 能处理大部分，但唯独 \uXXX 不完整时会当成坏 Unicode 转义报错。
   * 所以先单独把"非 4 位 hex 的 \u"转义掉，再交给 jsonrepair。
   */
  private safeParse(text: string, requestId: string, kind: 'plan' | 'decision'): any {
    const extracted = this.extractJson(text);
    // 1. 标准 parse
    try {
      return JSON.parse(extracted);
    } catch {
      // pass
    }
    // 2. 修掉 \u 后非 4 位 hex 的情况
    //    模型在 Windows 路径里写 D:\Projects\user，\u 被当成坏 Unicode 转义
    //    jsonrepair 唯一处理不了的就是这个。直接把 \u 换成 /u（路径仍有效）
    const fixedUnicode = extracted.replace(/\\u(?![0-9a-fA-F]{4})/g, '/u');
    // 3. jsonrepair 兜底（未转义引号、反斜杠、尾随逗号等）
    try {
      return JSON.parse(jsonrepair(fixedUnicode));
    } catch (repairErr) {
      const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
      const dump = dumpRawLog(requestId, `${kind}-parse-fail`, text);
      throw new Error(
        `${kind === 'plan' ? '计划' : '决策'}解析失败: ${msg}\n摘要: ${summarize(text, 160)}\n完整原文: ${dump.relativePath}`
      );
    }
  }

  private parsePlan(output: string, requestId: string): ExecutionPlan {
    const parsed = this.safeParse(output, requestId, 'plan');
    return {
      reasoning: parsed.reasoning,
      stages: this.normalizeStages(parsed.stages),
      estimatedTime: parsed.estimatedTime,
      createdAt: new Date(),
    };
  }

  /**
   * 规范化阶段：单任务阶段强制 mode='serial'
   *
   * 即使 prompt 已规定，模型偶尔仍会把单任务阶段标成 parallel。
   * 这是事实层面的矛盾（一个任务无所谓并行），程序层面统一兜底，
   * 避免日志输出"并行执行 1 个任务"这种自相矛盾的描述。
   */
  private normalizeStages(stages: any[]): any[] {
    if (!Array.isArray(stages)) return stages;
    return stages.map((s) => {
      if (s?.tasks?.length === 1 && s.mode === 'parallel') {
        return { ...s, mode: 'serial' };
      }
      return s;
    });
  }

  private parseDecision(output: string, requestId: string): Decision {
    const parsed = this.safeParse(output, requestId, 'decision');
    return {
      shouldContinue: parsed.shouldContinue,
      reason: parsed.reason,
      qualityScore: parsed.qualityScore,
      newPlan: parsed.newPlan,
      finalResult: parsed.finalResult,
    };
  }

  // ---------------- helpers ----------------

  private countTasks(plan: ExecutionPlan): number {
    return plan.stages.reduce((sum, stage) => sum + stage.tasks.length, 0);
  }

  private summarizeHistory(history: any[]): any[] {
    return history.map((record, index) => ({
      iteration: index + 1,
      reasoning: record.plan?.reasoning,
      tasksCount: record.results?.size || 0,
      decision: {
        shouldContinue: record.decision?.shouldContinue,
        reason: record.decision?.reason,
        qualityScore: record.decision?.qualityScore,
      },
    }));
  }
}
