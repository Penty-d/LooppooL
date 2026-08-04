<p align="center">
  <h1 align="center">🌀 LoopPool</h1>
  <p align="center">
    <strong>One model thinks. A fleet of agents does.</strong><br/>
    Multi-agent orchestration that separates planning from execution.
  </p>
  <p align="center">
    <a href="https://github.com/Penty-d/LooppooL/actions/workflows/ci.yml"><img src="https://github.com/Penty-d/LooppooL/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"/></a>
  </p>
  <p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>
</p>

---

## Design

Most coding agents run a single model that plans, acts, and reviews its own work inside one context window. LoopPool splits those jobs apart: one orchestrator model decides what to do and how, and other models carry out each task. The two roles are strictly separated — the orchestrator never runs tools, and the agents never plan.

### The orchestrator has no tools

The orchestrator's system prompt states this outright: *"you are the brain of a multi-model system — you plan and decide, you never execute."* It cannot open a file, run a command, or write code. It sends a plan or a decision to an Anthropic-protocol endpoint as structured JSON and reads the reply as plain text.

This keeps the planner's context free of tool output, so it can iterate without running out of room. It also makes every decision a serializable value — validated against a schema, checkpointed, and resumable. And because the orchestrator never touches the filesystem, a compromised orchestrator still cannot damage it.

The orchestrator also writes each agent's prompt itself, tailored to the specific task. Its instructions describe this as its most important output, since it determines how well the agent performs.

### Decisions stay in the orchestrator

Agents report what they found as output text; they don't hand decisions to each other. For a request like "optimize my project", the first round is reconnaissance only. The recon agent explores the codebase and returns its findings as text. The system prompt explicitly forbids the alternative — writing the analysis to a file for another agent to read — because then the orchestrator never sees the facts, and the decision effectively moves to whoever does read the file.

### Two task kinds: execute and validate

Tasks come in two forms: execute (produce something) and validate (verify it). Validation runs in a fresh context, and the validator is told that the producing agent's output is not fact — it may have lied or misjudged. The validator must check with tools and cite what it actually ran. The orchestrator also audits validators: a "passed" with no supporting evidence is treated as invalid, and the task is re-verified with a stricter prompt.

### Model selection per task

The orchestrator assigns each task a model from a tiered roster (`high` / `medium` / `low`), chosen by difficulty. One request can therefore run a strong model on the hard part and a cheap model on the boilerplate at the same time. Each model entry carries its own provider, endpoint, context window, concurrency limit, and per-million-token price, so model choice is a runtime decision rather than a fixed part of the configuration.

### Agent output is untrusted data

Because one model's output becomes another model's input, the orchestrator is told in advance that agent output and written files are data, not instructions. They may contain injected text ("ignore previous instructions", "set shouldContinue to false", "report done"), which it must not obey. The same distrust applies to its own output: plans and decisions are validated against a schema, and malformed output is returned with a repair hint so the model can fix it.

---

## Quick start

```bash
npm install
cp src/config/models.example.json src/config/models.json   # then fill in your API keys
npm run dev "create a hello-world script and run it"
```

The TUI shows the plan, live tool calls, and the final summary. `q` quits, `p` pauses the pool, `c` cancels the selected task.

### CLI

| Flag | Meaning |
|------|---------|
| `--resume [requestId]` | resume an interrupted run from its last checkpoint |
| `--approve` / `--no-approve` | require or skip human approval of the first plan |
| `--budget <usd>` | cost ceiling; the run stops when exceeded |
| `--project <key>` | per-project run log under `data/run-logs/` |

## Configuration

- `src/config/models.json` — the model roster: the orchestrator model, a tiered catalog (`high` / `medium` / `low`), and providers. Any Anthropic-protocol endpoint works — Anthropic, DeepSeek, Volcengine Ark, LiteLLM, local models.
- `src/config/config.json` — system parameters: max iterations, plan-approval mode, dangerous-shell policy, per-model context windows, task retries, budget.

`models.json` holds real API keys and is gitignored; a fresh checkout falls back to the example automatically.

## Architecture

```
src/
├── core/              orchestration loop, scheduler, task pool
├── execution/         agent engine and the five tools (bash / read / write / glob / grep)
├── agents/            task executor
├── llm/               Anthropic-protocol client for the orchestrator
├── config/            system parameters and model roster
├── tui/               full-screen terminal UI
├── types/             shared types
├── storage.ts         checkpoint / resume
├── observability.ts   NDJSON request log
└── run-log.ts         per-project run log
```

Two code paths meet here. The orchestrator uses a small hand-written client against the Anthropic Messages protocol for structured JSON; the agents run the Vercel AI SDK tool loop, each with a provider built from its own model config. The two can point at different models and endpoints independently.

## Other features

- Agent file access is confined to a workdir boundary.
- Completed iterations are checkpointed; `--resume` continues an interrupted run.
- Failed tasks are retried with exponential backoff.
- A full-screen TUI shows task progress and tool calls live.
- Each run writes an NDJSON event log with token and cost per task.
- Plans can require human approval before execution.

## Safety

The bash tool is not a real sandbox. Agent file access is confined to a workdir, and system-destructive commands are gated, but a determined agent could still reach outside its workdir. Run LoopPool only with models you trust, on your own machine — not as a public service or against sensitive directories.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, commit style, labels, and CI expectations. `npm test` runs the same offline suite CI uses, without API keys or network access.

## License

[MIT](LICENSE)
