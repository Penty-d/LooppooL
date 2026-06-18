# LoopPool

> One LLM as the brain, many agents as the hands.

English · [中文](README.md)

---

## Why this is different

Most coding agents are **"one agent, all the work"**: you give it a prompt, it
picks a model, plans, codes, and verifies — alone, end to end.

LoopPool flips that — it splits **thinking** from **doing**:

- **One orchestrator (the brain)** breaks down the request, assigns each
  subtask to a model of the right tier, writes every agent's prompt itself,
  and decides what comes next after reading results.
- **Multiple agents (the hands)** each handle their own piece in isolation,
  in parallel when possible. They execute, they don't strategize.

Three things fall out of this design:

**1. Tier-aware model routing**
Hard tasks (architecture, final review) go to strong models, routine work to
mid-tier, boilerplate to cheap ones — the orchestrator picks per task. A
single run may use Claude Opus, Sonnet, and DeepSeek in parallel, each on the
work they fit best.

**2. Reconnaissance first**
When you say "optimize my project," the orchestrator **doesn't** dispatch
edits right away — it first sends an agent to survey the codebase, reads
that report itself, then decides what to actually change. Decision-making
stays with the orchestrator; it never gets bypassed by agents passing
documents to each other.

**3. Validation requires evidence**
Validate-task agents are required to run tools and read files in person
before scoring — their prompts forbid grading based solely on the previous
agent's self-report. This is the safeguard against agents flattering each
other into a pass.

## Project layout

```
src/
├── core/         orchestration loop, orchestrator, parallel task pool
├── execution/    agent engine + 5 tools (bash / read_file / write_file / glob / grep)
├── agents/       task executor
├── llm/          Anthropic-protocol client (orchestrator only)
├── config/       system settings and model registry (you fill in)
├── types/        shared types
├── ui.ts         colored terminal logging
└── index.ts      CLI entry
```

## Get running

```bash
npm install
cp src/config/models.example.json src/config/models.json
# edit models.json, fill in your API keys
npm run dev "<your request>"
```

Model config accepts Anthropic's official endpoint or any Anthropic-protocol
compatible gateway (DeepSeek, LiteLLM, etc.) — see `models.example.json`.

## ⚠️

The `bash` tool is **not** a real sandbox. Agents can read/write files
outside their workspace and access the network. Only run this on a trusted
model with your own dev machine. Don't deploy as SaaS, don't point it at
sensitive directories.

## License

[MIT](LICENSE)
