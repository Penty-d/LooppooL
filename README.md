# LoopPool

> **AI-driven multi-agent orchestration with reconnaissance-first planning**
> 一个调度器（大脑）协调多个 coding agent（手脚）共同完成任务的多模型编排系统。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-blue.svg)](https://www.typescriptlang.org/)

---

## 它是什么

LoopPool 不是又一个 coding agent。它是一个**调度多个 coding agent 协作**的系统：

- **调度器（Orchestrator）**——负责拆解需求、挑模型、写 prompt、判断结果质量、决定是否再迭代。
- **Agent**——每个任务交给一个独立 agent 跑。
- **侦察优先**——遇到"优化我的项目""重构 X"这类需要先了解现状的需求，调度器会先派侦察 agent 收集信息，**自己看到事实后再做修改决策**——而不是把决策权外包出去。

```
┌──────────────────────────────────────────────────────────┐
│  用户需求                                                  │
│      ↓                                                    │
│  ┌────────────┐    生成执行计划（含任务、模型选择、prompt）   │
│  │  调度器     │ ──────────────────────────────────────►   │
│  │ (Anthropic │                                            │
│  │  协议端点)  │ ◄────── 收 agent output 文本，做决策 ─────  │
│  └────────────┘                                            │
│      ↓                                                    │
│  ┌─────────┬─────────┬─────────┐                          │
│  │ Agent A │ Agent B │ Agent C │  ← 不同 tier、不同模型     │
│  │ (high)  │ (medium)│ (low)   │  ← 按并发能力动态调度       │
│  └─────────┴─────────┴─────────┘                          │
│  每个 agent 在独立 workspace 跑 tool loop（Vercel AI SDK） │
│      ↓                                                    │
│  迭代循环：质量不达标继续优化，达标返回最终结果              │
└──────────────────────────────────────────────────────────┘
```

## 核心特性

- **多模型分级**：高难任务用强模型（如 Claude Opus），常规用 Sonnet，样板用 DeepSeek 等廉价模型，调度器为每个任务自动挑选
- **真正的工具调用**：agent 不是只生成代码字符串，而是调用 `write_file` 落盘、`bash` 跑测试，每步实时回显
- **侦察优先**：识别"需要先知道现状"的需求，先派 agent 调查，调度器读到事实后再下达具体修改任务
- **并行 / 串行混合调度**：互不依赖的任务并行跑，受每个模型的并发上限约束
- **质量门禁**：可配置 validate 任务，强制 agent 用工具实际验证产物（不是只读前置 output 文本）
- **自动迭代**：质量不达标自动重新规划并执行下一轮，最多 N 轮
- **上下文压缩**：单步 input token 超阈值时自动裁剪老 tool_result，保证长任务不爆 context
- **协议兼容**：底层用 Anthropic Messages API，通过自定义 baseURL 可对接任何兼容网关（DeepSeek、本地模型、LiteLLM 等）

## 快速开始

### 前置要求

- Node.js 18+
- 至少一个 Anthropic 兼容的 LLM 端点（官方 Anthropic、DeepSeek 的 anthropic 兼容端点、或自建网关）

### 安装

```bash
git clone <your-repo-url> looppool
cd looppool
npm install
```

### 配置

复制模型配置模板并填入你的 key：

```bash
cp src/config/models.example.json src/config/models.json
```

编辑 `src/config/models.json`：

```json
{
  "orchestrator": {
    "baseURL": "https://api.anthropic.com",
    "apiKey": "sk-ant-your-key-here",
    "authMode": "api-key",
    "modelId": "claude-opus-4-...",
    "maxTokens": 8192
  },
  "models": [
    { "id": "opus",   "tier": "high",   "provider": "claude", "modelId": "claude-opus-4-...",   "concurrent": true },
    { "id": "sonnet", "tier": "medium", "provider": "claude", "modelId": "claude-sonnet-4-...", "concurrent": true },
    { "id": "ds",     "tier": "low",    "provider": "ds",     "modelId": "deepseek-chat",       "concurrent": true }
  ],
  "providers": {
    "claude": {
      "baseURL": "https://api.anthropic.com",
      "apiKey": "sk-ant-...",
      "authMode": "api-key"
    },
    "ds": {
      "baseURL": "https://api.deepseek.com/anthropic",
      "apiKey": "sk-...",
      "authMode": "api-key"
    }
  }
}
```

字段说明：

- **orchestrator**：调度器自身用的模型（建议 high tier）
- **models[]**：可用模型清单，调度器为每个任务从中挑选
  - `tier`: `high` / `medium` / `low`，调度器据此匹配难度
  - `concurrent`: `false` 时该模型同一时刻只能跑一个任务（不阻塞其他模型）
- **providers[]**：端点 + 鉴权
  - `authMode: "api-key"` 走 `x-api-key` header（Anthropic 原生）
  - `authMode: "bearer"` 走 `Authorization: Bearer`（多数兼容网关）

### 运行

```bash
# 命令行参数传需求
npm run dev "创建一个 TypeScript 函数 add(a, b)，返回两个数的和"

# 或交互式输入
npm run dev
> 请输入任务需求: ...

# 编译 + 跑产物
npm run build
npm start
```

## 使用建议

**适合的任务**：
- 单个明确目标（"创建 X、写测试、跑通"）
- 需要先了解现有代码再修改（"重构 X 模块"——会触发侦察轮）
- 需要多角色协作的项目（如 "搭后端 + 写测试 + 验收"）

**不太适合**：
- 长程开放式探索（agent 没有跨任务的长记忆）
- 与人交互式协作（系统跑完一轮才返回，不支持中途追问）
- 需要 GUI / 浏览器操作的任务

## 项目结构

```
src/
├── core/                  # LoopPool 主循环、调度器、任务池
│   ├── looppool.ts       # 顶层入口，迭代控制
│   ├── orchestrator.ts   # 调度器（规划 + 决策）
│   └── task-pool.ts      # 任务调度（并发 / 串行）
├── execution/            # Agent 执行层
│   ├── agent-engine.ts   # Vercel AI SDK + tool loop + 上下文压缩
│   ├── tools.ts          # 5 个工具：bash / read_file / write_file / glob / grep
│   └── model-registry.ts # 模型清单解析
├── agents/
│   └── task-executor.ts  # 任务执行器（含 validate 任务的 prompt 注入）
├── llm/
│   └── anthropic-client.ts  # 调度器专用：手写 fetch /v1/messages
├── config/
│   ├── config.json       # 系统参数（迭代上限、超时、并发）
│   └── models.json       # 模型库（gitignore，自己创建）
├── ui.ts                 # 终端美化日志
├── log-store.ts          # 大块原始输出落盘
├── types/index.ts        # 公共类型
└── index.ts              # CLI 入口
```

## ⚠️ 安全警告

**`bash` 工具不是真 sandbox。** Agent 调用 `bash` 时，命令直接由 Node 子进程执行，工作目录被设为 workspace，但**子进程能 `cd ..` 突破、能读写任意文件、能访问网络、能继承父进程的环境变量（包括你的 API Key）**。

也就是说：
- Agent **理论上能**读取 `~/.ssh/`、`~/.aws/credentials`、`%USERPROFILE%\.claude\settings.json` 等敏感文件
- Agent **理论上能**通过 `curl` / `Invoke-WebRequest` 把数据外发到任意服务器
- 路径越界保护（`safePath`）只对 `read_file` / `write_file` 生效，**对 `bash` 命令内的路径不生效**

**当前方案适合**：在你信任的模型 + 受控环境（个人开发机的项目目录）下运行。

**不适合**：
- 跑不可信来源的需求（恶意 prompt 可诱导 agent 做恶意操作）
- 多租户 SaaS 部署
- 处理含敏感数据的目录

如果你需要真隔离，建议把整个 `npm run dev` 包到 Docker 容器里跑，workspace 用 volume 挂载——但项目本身没内置 Docker 支持。

## 配置项参考

`src/config/config.json`：

```json
{
  "system": {
    "maxIterations": 5,        // 最多迭代轮数（达标提前结束）
    "taskTimeout": 1800000,    // 单任务超时 30 分钟
    "globalParallelLimit": 10, // 全局最大并发任务数
    "validationThreshold": 80  // 不再使用，保留兼容
  }
}
```

`AgentEngine` 构造选项（在 `src/agents/task-executor.ts` 里实例化）：

- `maxSteps`：单任务 tool loop 最大步数（默认 30）
- `maxInputTokens`：单步 input token 软上限（默认 200_000，超过自动压缩老 tool_result）
- `workspace`：所有任务共享的根目录（默认 `./.looppool-workspace`，每任务一个子目录）

## 路线图

- [ ] TUI 界面（ink + React 重写终端 UI）
- [ ] 工具扩展：HTTP fetch / SQL 查询 / 浏览器操作
- [ ] Web 后端 + 浏览器前端，可视化任务树
- [ ] Docker sandbox 内置支持
- [ ] Agent 之间的消息传递（不只是共享 workspace 文件）
- [ ] 可恢复的任务持久化

## 致谢

- [Vercel AI SDK](https://ai-sdk.dev) —— tool loop / 多 provider / `prepareStep` 上下文压缩
- [Anthropic Messages API](https://docs.anthropic.com/) —— 协议规范

## License

[MIT](LICENSE) © 2026 Penty-d
