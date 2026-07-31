<p align="center">
  <h1 align="center">🌀 LoopPool</h1>
  <p align="center">
    <strong>One model thinks. A fleet of agents does.</strong><br/>
    Multi-agent orchestration that separates <em>planning</em> from <em>doing</em> — and prices each task by how hard it actually is.
  </p>
  <p align="center">
    <a href="https://github.com/Penty-d/LooppooL/actions/workflows/ci.yml"><img src="https://github.com/Penty-d/LooppooL/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"/></a>
  </p>
  <p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>
</p>

---

## Why LoopPool?

Most coding agents are a **"one agent does everything" monolith**: you say the word, and a single model plans, codes, tests, and ships — wearing every hat in one context window.

LoopPool inverts that. It splits **thinking** from **doing**:

- 🧠 **One orchestrator — the brain.** It decomposes your request, picks the right model for each sub-task, *hand-writes every agent's prompt*, reads every result, and decides what happens next.
- 🛠️ **Many agents — the hands.** Each runs one scoped task with real tools — `bash`, `read_file`, `write_file`, `glob`, `grep` — and never worries about the big picture.

The result is a **model-tiered, crash-proof, budget-aware, human-auditable** pipeline.

---

## Highlights

| | |
|---|---|
| 🎯 **Model tiering done right** | Hard problems go to the strong model; boilerplate goes to the cheap one. One request can fan out across Opus, Sonnet, and a budget model *simultaneously*, priced per-million-token. |
| 🔍 **Reconnaissance-first** | Ask LoopPool to "optimize my project" and it won't touch a file until a recon agent has surveyed the codebase and the brain has *actually read* the findings. |
| 🧾 **Evidence-based acceptance** | Validation agents are forbidden from trusting another agent's word. They must run the code and read the files before scoring. |
| 💾 **Crash-proof** | Every completed iteration is checkpointed. `--resume` picks up exactly where a crash left off — no restarting from zero. |
| 👁️ **Human in the loop** | Approve plans before they burn 20 iterations of tokens. Pause the pool, or cancel a single stuck task, mid-run. |
| 🛡️ **Guardrailed** | Agents are jailed to a `workdir`; system-destructive shell commands are gated behind confirmation; context never balloons (auto-summarization). |
| 💰 **Budget-aware** | Set `--budget $X` and the orchestrator sees live cost, downgrades tiers, and stops when you're over. |
| 🔎 **Fully observable** | A live split-pane TUI plus a per-run NDJSON event log with token & cost per task. |

---

## How it works

```
    You
     │  "optimize my project"
     ▼
  🧠 ORCHESTRATOR      plan → pick models → hand-write prompts → analyze → decide
     │
     ▼
  ⚙️ TASK POOL         serial / parallel stages · per-model concurrency · auto-retry
     │
     ▼
  🛠️ AGENTS            bash · read_file · write_file · glob · grep
     │                 (all file access jailed to the workdir)
     ▼
  🔎 RESULTS ────────► orchestrator reads → "done?" → approve / continue / stop
```

An iteration loop — **plan → execute → analyze → decide → repeat** — runs until the orchestrator is satisfied (or your budget runs out). Reconnaissance requests automatically get a survey round first; everything else flows straight through.

---

## Quick start

```bash
npm install
cp src/config/models.example.json src/config/models.json   # then fill in your API keys
npm run dev "create a hello-world script and run it"
```

The TUI shows you the plan, every live tool call, and the final summary. Press `q` to quit, `p` to pause, `c` to cancel a task.

### CLI reference

| Flag | Meaning |
|------|---------|
| `--resume [requestId]` | resume an interrupted run from its last checkpoint |
| `--approve` / `--no-approve` | require / skip human approval of the first plan |
| `--budget <usd>` | hard cost ceiling — the run stops when exceeded |
| `--project <key>` | keep a per-project run log under `data/run-logs/` |

---

## Configuration

Two files under `src/config/`:

- **`models.json`** — your model roster: the **orchestrator** model plus a **tiered catalog** (`high` / `medium` / `low`) and providers. Anything that speaks the Anthropic protocol works — official Anthropic, DeepSeek, Volcengine Ark, LiteLLM…
- **`config.json`** — system knobs: max iterations, task timeout, plan-approval mode, dangerous-shell policy, per-model context windows, task retries, budget.

`models.json` holds real API keys and is gitignored; a fresh checkout falls back to the example automatically.

---

## Architecture

```
src/
├── core/              the orchestration loop, scheduler, task pool
├── execution/         the agent engine + 5 tools (bash / read / write / glob / grep)
├── agents/            the task executor
├── llm/               Anthropic-protocol client that drives the orchestrator
├── config/            system params + your model roster
├── tui/               the full-screen terminal UI
├── types/             shared types
├── storage.ts         checkpoint / resume
├── observability.ts   NDJSON request log
└── run-log.ts         per-project run log
```

Tests: `npm test` runs `tsc --noEmit` + a **60-check offline smoke suite** (no API keys, no network) — the same suite CI runs on every PR.

---

## Comparison

| | LoopPool | Typical single-agent |
|---|---|---|
| Planning | dedicated brain, hand-written per-task prompts | same model does everything |
| Models | tiered — strong for hard, cheap for easy | one model |
| Recovery | checkpoint/resume + per-task retry | restart from scratch |
| Human control | plan approval, cancel, pause, budget | stop-or-go |
| Safety | workdir jail + dangerous-command gate | whatever the agent feels like |

---

## ⚠️ Safety

The `bash` tool is **not a real sandbox**. Agents operate inside a `workdir` boundary for file tools, and system-destructive commands are gated, but a determined agent could still reach outside its workdir. Run LoopPool only with models you trust, on your own machine — don't deploy it as a public SaaS or point it at sensitive directories.

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, commit style, labels, and what CI expects.

## License

[MIT](LICENSE)
