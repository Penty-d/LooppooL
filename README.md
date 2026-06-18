# LoopPool

> 让一个 LLM 当大脑，多个 agent 当手脚。

[English](README.en.md) · 中文

---

## 它和别的 agent 项目有什么不一样

市面上的 coding agent 大多是 **"一个 agent 干所有事"**：你说一句，它从头干到尾，挑模型、做计划、写代码、验证全揽下。

LoopPool 反过来——把"想"和"做"拆开：

- **一个调度器（大脑）** 拆解需求、为每个子任务挑合适等级的模型、亲自写每个 agent 的 prompt、看完结果决定下一步。
- **多个 agent（手脚）** 各管一摊，互不干扰，能并行就并行。它们只负责干活，不思考全局。

这样带来三个特别之处：

**1. 模型分级**
难任务（架构设计、最终验收）用强模型，常规任务用中档，样板代码用便宜模型——调度器自动挑。一次任务可能同时调用 Claude Opus、Sonnet、DeepSeek，按性价比分工。

**2. 侦察优先**
当你说"优化我的项目"时，调度器**不会**直接派人去改——它先派一个 agent 调查项目现状，自己看完调查结果再决定具体改什么。决策权始终在调度器手里，不会被 agent 之间互相传文档架空。

**3. 验收必须取证**
质量验收任务的 agent 被强制要求"必须用工具实际跑过、读过文件"才能打分，prompt 里禁止它仅凭前置任务的自述就放行——这是为了防止两个 agent 互相吹捧。

## 项目结构

```
src/
├── core/         调度循环、调度器、并发任务池
├── execution/    Agent 引擎与 5 个工具（bash / 读文件 / 写文件 / glob / grep）
├── agents/       任务执行器
├── llm/          调度器专用的 Anthropic 协议客户端
├── config/       系统参数与模型库（你自己填）
├── types/        公共类型
├── ui.ts         彩色终端日志
└── index.ts      CLI 入口
```

## 跑起来

```bash
npm install
cp src/config/models.example.json src/config/models.json
# 编辑 models.json，填入你的 API key
npm run dev "<你的需求>"
```

模型配置支持 Anthropic 官方端点和任何 Anthropic 协议兼容网关（DeepSeek、LiteLLM 等），见 `models.example.json`。

## ⚠️

`bash` 工具不是真沙盒，agent 能读写 workspace 之外的文件、能联网。请只在你信任模型 + 自己的开发机上跑，不要部署成 SaaS、不要处理敏感目录。

## License

[MIT](LICENSE)
