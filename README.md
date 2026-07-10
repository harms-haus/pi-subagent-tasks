# pi-task-pools

Autonomous multi-task pool orchestrator for the pi-coding-agent — define a pool of dependent tasks, and the extension orchestrates them end-to-end in isolated git worktrees under multi-dimensional concurrency limits.

## What it does

`pi-task-pools` is a single pi-coding-agent extension that exposes **one tool** —
`run_tasks`. Calling it is a **blocking operation**: you hand it a pool of
ordered, dependent tasks, and the extension autonomously drives the entire pool
to completion before returning a summary. Internally it:

- **Spawns sub-agent processes** under named profiles, one or more per task.
- **Isolates each task in its own git worktree** off a shared pool branch.
- **Merges finished work serially** back into the pool branch — fast-forward when
  possible, otherwise a `merge-helper` agent resolves conflicts.
- **Enforces concurrency limits** across three independent pools
  (total / provider / model), all AND-gated.
- **Streams a live, tiered "board"** of task states inside the tool output
  (press `Ctrl+O` to expand the full board).

Each task is defined by a **single prompt** and an optional **compose tree** —
a nested JSON DSL (`agent` / `sequential` / `parallel` / `gateLoop` / `loop`)
that describes how the task's agents execute and how their results flow between
atoms.

It is the autonomous-orchestrator generalization of ad-hoc
`delegate_to_subagents`, kanban-style dependency tracking, workflow phases, and
wisp DAGs — generalized into a single fire-and-forget tool call.

## Installation

`pi-task-pools` is a [pi package](https://github.com/harms-haus/pi-task-pools).
Install it as a pi extension in your project:

```bash
pi install @harms-haus/pi-task-pools
```

This registers the extension and its `task-pools` skill (auto-discovered by the
agent). The `run_tasks` tool becomes available once the extension is loaded.

## Quick start

Define a pool with three dependent tasks. `dependsOn` is resolved against task
`id`s (or `title`s) at creation time — dependents branch from the pool HEAD
_after_ their parents merge, so they see the parents' code.

```jsonc
{
  "name": "release-feature",
  "tasks": [
    {
      "id": "plan",
      "title": "Write the implementation plan",
      "prompt": "Design the architecture for the new billing API endpoint.",
      "profile": "planner",
    },
    {
      "id": "implement",
      "title": "Implement the feature",
      "prompt": "Implement the billing API endpoint per the plan.",
      "profile": "coder",
      "dependsOn": ["plan"],
    },
    {
      "id": "test",
      "title": "Write and run tests",
      "prompt": "Write integration tests for the billing API endpoint and make them pass.",
      "profile": "coder",
      "dependsOn": ["implement"],
    },
  ],
  "limits": { "total": 4 },
}
```

`name` is slugified (kebab-case) into the **pool id**, the git branch
(`pi-task-pool/<slug>`), and the on-disk directory. The tool blocks until the
pool reaches a fixed point (all tasks done or failed), streaming the live board
throughout. When it finishes it returns a summary with branch paths and session
locations so you can finalize with plain `git`.

To resume an existing pool (e.g. after an abort or to retry failed tasks):

```json
{ "resume": "release-feature" }
```

> **The singular-prompt rule.** Every agent spawned under a task receives the
> task's `prompt` _verbatim_. Atoms carry no prompt of their own — only an
> optional `profile` (inherited from the task if omitted) and `title`. A
> reviewer or summarizer atom reads files in the shared worktree rather than
> receiving a separate instruction.

## Compose DSL

A task's `compose` field is a nested JSON tree of atoms. A bare task with no
`compose` is equivalent to `{ "type": "agent" }` using the task's profile.

| Atom         | Behavior                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`      | Runs one agent session. Resolves when the agent completes.                                                                                                                          |
| `sequential` | Runs child atoms one after another in the same worktree; each receives the prior atom's last message as context.                                                                    |
| `parallel`   | Starts all children concurrently (subject to limits) in the same worktree; done when all complete. Output is the concatenation of children's messages (each headed by its `title`). |
| `gateLoop`   | Runs `work`, then `review`; the reviewer emits a verdict via the `gate_verdict` tool. Approved → exit; rejected → resume `work` with feedback, up to `maxIterations` (default `3`). |
| `loop`       | Runs `atom` exactly `count` times sequentially in the same worktree; each iteration is a fresh session that sees prior file changes.                                                |

```jsonc
// gateLoop: code + review until approved
{
  "type": "gateLoop",
  "work": { "type": "agent", "profile": "coder" },
  "review": { "type": "agent", "profile": "code-reviewer" },
  "maxIterations": 3
}

// fan out research, then summarize
{
  "type": "sequential",
  "atoms": [
    {
      "type": "parallel",
      "atoms": [
        { "type": "agent", "profile": "researcher", "title": "module-a" },
        { "type": "agent", "profile": "researcher", "title": "module-b" }
      ]
    },
    { "type": "agent", "profile": "summarizer" }
  ]
}
```

The full DSL reference, inter-atom result-flow rules, worked examples, and the
retry/resume model are documented in the bundled skill (`task-pools`), which the
agent reads on demand.

## Concurrency limits

Three independent, AND-gated pools control how many agents run simultaneously.
An agent may start **iff every applicable pool has room**; an unset pool is
unlimited.

```jsonc
{
  "total": 4,
  "provider": { "anthropic": 3 },
  "model": { "anthropic/claude-sonnet-4-5": 2 },
}
```

- **`total`** (default `4`) — cap across the entire pool.
- **`provider[<provider>]`** — counts every session using that provider,
  regardless of model (e.g. `anthropic` counts Sonnet + Opus together).
- **`model["<provider>/<model>"]`** — cap on a specific provider/model pair.

A session using `anthropic/claude-sonnet-4-5` consumes one slot from `total`,
one from `provider.anthropic`, and one from `model["anthropic/claude-sonnet-4-5"]`.
The merge-helper agent consumes slots like any other agent.

When a running task has zero agents active and cannot start its next agent
because every applicable pool is full, it moves to **`parked`**. The scheduler
prioritizes parked tasks over ready ones so they reclaim the next freed slot.

**Upper-bound caps:** `limits.total` ≤ 32, `maxRetries` ≤ 10, loop `count` ≤ 100.

## On-disk layout

All pool state lives under `.pi/task-pools/<id>/` (primary source of truth,
durable and resumable):

```
.pi/task-pools/<id>/
├── state.json        # canonical pool state — read to inspect a pool
├── audit.jsonl       # append-only event log
├── sessions/         # native pi session files, flat-named post-run
├── worktrees/
│   ├── pool/         # pool worktree (branch: pi-task-pool/<slug>)
│   └── <taskId>/     # task worktree (deleted after merge)
└── artifacts/        # agents are told to write run artifacts here
```

`run_tasks` never merges the pool branch into your main branch — finalization is
the orchestrator agent's job using plain git:

```bash
git merge --ff-only pi-task-pool/release-feature
# or
gh pr create --head pi-task-pool/release-feature
```

Inspect a pool with the `read` tool: `state.json` for status, `audit.jsonl` for
the event timeline, and `sessions/*.jsonl` for individual agent transcripts.

## Profiles

Profiles are Markdown files with YAML frontmatter that define the provider,
model, system-prompt, tools, and other settings for spawned agents. They live in
**new directories, separate from the `agent-profiles/` dirs used by other pi
extensions**:

| Scope   | Directory                                    |
| ------- | -------------------------------------------- |
| Global  | `~/.pi/agent/profiles/`                      |
| Project | `.pi/profiles/` (overrides global same-name) |

The extension seeds one profile automatically on first run (never overwriting an
existing file): **`merge-helper`** for resolving merge conflicts. All other
profiles (workers, reviewers, planners) you create yourself.

> **Note:** The auto-seeded `merge-helper` profile has no `provider` or `model`
> set — you must add them before a merge conflict can be resolved. Edit
> `~/.pi/agent/profiles/merge-helper.md` (global) or create
> `.pi/profiles/merge-helper.md` (project override) with your preferred
> provider and model.

```markdown
---
name: code-reviewer
provider: anthropic
model: anthropic/claude-sonnet-4-5
thinkingLevel: medium
---

You are a thorough code reviewer. Review the changes in the worktree and call
`gate_verdict` with your final decision.
```

A task or atom referencing a missing profile is a hard error. Use the
`list_profiles` tool to discover existing profiles before referencing them.

## Development

```bash
npm install          # install dependencies
npm test             # run the test suite (vitest)
npm run test:watch   # run tests in watch mode
npm run test:coverage
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run lint:fix
npm run format        # prettier --write
npm run format:check  # prettier --check
```

The pre-commit hook (`simple-git-hooks`) runs `format:check`, `lint`, and
`typecheck` automatically.

## Architecture

The extension is organized into domain-focused modules under `src/`:

| Domain            | Modules                                                                                               | Responsibility                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry & lifecycle | `index.ts`                                                                                            | Factory registering `run_tasks` + `gate_verdict`; seeds `merge-helper`; hard-kills children on `session_shutdown`.                                        |
| Types & constants | `types.ts`, `constants.ts`                                                                            | Domain model (statuses, limits, compose IR, cursor, audit events) and tunable defaults.                                                                   |
| Tool surface      | `run-tasks.ts`, `gate-verdict.ts`                                                                     | The `run_tasks` tool (create/resume/abort paths, live-board loop) and the terminating `gate_verdict` tool.                                                |
| Scheduler         | `scheduler.ts`, `atoms.ts`, `cursor.ts`, `status.ts`, `dag.ts`, `gateloop.ts`, `retry.ts`, `pools.ts` | Dependency scheduling, compose-cursor advancement, status recompute, DAG resolution, gateLoop verdicts, two-level retry, and concurrency-pool accounting. |
| Agent execution   | `agent-runner.ts`, `spawner.ts`, `profiles.ts`, `sessions.ts`                                         | Profile resolution, subprocess spawning, JSON-event parsing, and session-file move/rename for resume.                                                     |
| Git & worktrees   | `git-op.ts`, `worktrees.ts`, `merge.ts`                                                               | Pool/task worktree creation, serial merge queue, and merge-helper conflict resolution.                                                                    |
| Persistence       | `state.ts`                                                                                            | `state.json` read/write, `audit.jsonl` append, resume reconciliation.                                                                                     |
| Rendering         | `render.ts`                                                                                           | Live tiered board (`renderResult`) and final summary.                                                                                                     |
| Utilities         | `utils.ts`, `defaults/`                                                                               | Helpers and the bundled `merge-helper.md` profile.                                                                                                        |

Comprehensive tests live in `src/__tests__/`, including an end-to-end
integration suite.

## License

[MIT](./LICENSE) — Copyright (c) 2026 harms-haus.
