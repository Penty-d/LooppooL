<p align="center">
  <h1 align="center">🌀 LoopPool</h1>
  <p align="center">
    <strong>一个模型负责思考，一群 agent 负责动手。</strong><br/>
    多智能体编排——把「规划」和「执行」分开，并按任务的实际难度定价。
  </p>
  <p align="center">
    <a href="https://github.com/Penty-d/LooppooL/actions/workflows/ci.yml"><img src="https://github.com/Penty-d/LooppooL/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"/></a>
  </p>
  <p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>
</p>

---

## 为什么是 LoopPool？

市面上的 coding agent 大多是 **「一个 agent 干所有事」的单体**：你说一句，它从头干到尾，挑模型、做计划、写代码、测试、上线全揽下——所有角色挤在一个上下文窗口里。

LoopPool 反过来——把「想」和「做」拆开：

- 🧠 **一个调度器（大脑）**。拆解你的需求、为每个子任务挑合适的模型、**亲手为每个 agent 写 prompt**、看完每个结果、决定下一步。
- 🛠️ **多个 agent（手脚）**。每个只负责一个独立任务，带着真实工具干活——`bash` / `read_file` / `write_file` / `glob` / `grep`——不用操心全局。

结果是一条 **模型分级、崩溃可续、预算可控、全程可审计** 的流水线。

---

## 亮点

| | |
|---|---|
| 🎯 **模型分级** | 难任务交给强模型，样板代码交给便宜模型。一次请求可以同时动用 Opus、Sonnet 和一个廉价模型，按每百万 token 分别计价。 |
| 🔍 **侦察优先** | 你对它说"优化我的项目"，它**不会**直接动手——先派侦察 agent 摸清代码库，大脑**亲眼看完**调查结果，再做具体改动。 |
| 🧾 **验收必须取证** | 验收 agent 被禁止只听信另一个 agent 的自述。评分之前，必须真的跑代码、读文件。 |
| 💾 **崩溃可续** | 每个完成的迭代都会落盘检查点。`--resume` 从崩溃处精确续跑——不用从头再来。 |
| 👁️ **人在环** | 计划执行前先给你过目，免得烧掉 20 轮迭代的 token。运行中可以暂停整个任务池，或取消某个卡住的任务。 |
| 🛡️ **有护栏** | agent 的文件操作被限制在 `workdir` 内；系统破坏性命令要过人工确认；上下文不会无限膨胀（自动总结）。 |
| 💰 **预算感知** | 设 `--budget $X`，调度器能实时看到成本、自动降档，超预算即停。 |
| 🔎 **全程可观测** | 全屏分栏 TUI，加上每个 run 的 NDJSON 事件日志（含每个任务的 token 与成本）。 |

---

## 工作原理

```
    You
     │  "优化我的项目"
     ▼
  🧠 调度器            规划 → 挑模型 → 手写 prompt → 分析结果 → 决策
     │
     ▼
  ⚙️ 任务池            串行 / 并行阶段 · 按模型并发 · 自动重试
     │
     ▼
  🛠️ agent            bash · read_file · write_file · glob · grep
     │                 （所有文件访问都被限制在 workdir 内）
     ▼
  🔎 结果 ────────► 调度器查看 → "够好了吗?" → 批准 / 继续 / 停止
```

一条迭代循环——**规划 → 执行 → 分析 → 决策 → 重复**——一直跑到调度器满意（或预算耗尽）。侦察类需求会自动先派一轮调查；其余需求直接进入执行。

---

## 快速开始

```bash
npm install
cp src/config/models.example.json src/config/models.json   # 然后填入你的 API key
npm run dev "创建一个 helloworld 脚本并运行它"
```

TUI 会展示计划、每一步实时的工具调用，以及最终总结。`q` 退出、`p` 暂停、`c` 取消任务。

### CLI 参考

| 参数 | 含义 |
|------|------|
| `--resume [requestId]` | 从最近一次检查点续跑被打断的 run |
| `--approve` / `--no-approve` | 首个计划是否需要人工批准 / 跳过 |
| `--budget <usd>` | 成本硬上限——超支即停 |
| `--project <key>` | 为项目保留一份运行日志，存在 `data/run-logs/` |

---

## 配置

两个文件都在 `src/config/` 下：

- **`models.json`** — 你的模型清单：**调度器**模型 + **分级目录**（`high` / `medium` / `low`）+ 供应商。任何兼容 Anthropic 协议的端点都能用——官方 Anthropic、DeepSeek、火山方舟、LiteLLM……
- **`config.json`** — 系统参数：最大迭代次数、任务超时、计划审批模式、危险 shell 策略、每模型上下文窗口、任务重试、预算。

`models.json` 含真实 API key，已被 gitignore；全新 checkout 会自动回退到 example。

---

## 目录结构

```
src/
├── core/              编排主循环、调度器、任务池
├── execution/         agent 引擎 + 5 个工具（bash / 读写 / glob / grep）
├── agents/            任务执行器
├── llm/               驱动调度器的 Anthropic 协议客户端
├── config/            系统参数 + 你的模型清单
├── tui/               全屏终端 UI
├── types/             公共类型
├── storage.ts         检查点 / 续跑
├── observability.ts   NDJSON 请求日志
└── run-log.ts         按项目归档的运行日志
```

测试：`npm test` 跑 `tsc --noEmit` + **60 项离线 smoke 测试**（不需要 API key、不联网）——CI 在每个 PR 上跑的就是同一套。

---

## 对比

| | LoopPool | 典型单 agent |
|---|---|---|
| 规划 | 专用大脑，为每个任务手写 prompt | 同一个模型全包 |
| 模型 | 分级——难的上强模型、容易的上便宜模型 | 一个模型 |
| 恢复 | 检查点/续跑 + 任务级重试 | 从头重来 |
| 人工控制 | 计划审批、取消、暂停、预算 | 要么停要么继续 |
| 安全 | workdir 边界 + 危险命令闸门 | 看模型心情 |

---

## ⚠️ 安全

`bash` 工具**不是真沙盒**。agent 的文件工具被 `workdir` 边界限制、系统破坏性命令会被闸门拦住，但一个有决心的 agent 仍可能越过 workdir。请只在你信任模型 + 自己的开发机上跑，不要部署成公共 SaaS、不要指向敏感目录。

---

## 参与贡献

欢迎 PR。分支命名、commit 规范、label 和 CI 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
