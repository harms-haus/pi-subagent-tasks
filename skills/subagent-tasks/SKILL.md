---
name: subagent-tasks
description: >-
  Orchestrate a pool of dependent tasks that run autonomously in isolated git
  worktrees under multi-dimensional concurrency limits, with a live board. Use
  for multi-step, multi-task work with dependencies that should run unattended.
  Replaces ad-hoc delegate_to_subagents / kanban / workflow patterns.
---

# pi-subagent-tasks — `run_tasks` Skill

This skill teaches how to use **pi-subagent-tasks**, a pi-coding-agent extension
that provides `run_tasks` for orchestrating a pool of dependent tasks and
`get_task_history` for retrieving their agent responses. Tasks run in isolated
Git worktrees, merge serially back into a shared pool branch, and are subject to
multi-dimensional concurrency
limits. A live streaming board (Ctrl+O to expand) shows real-time progress.

Read this entire file before using `run_tasks`.

## When to use `run_tasks`

Use `run_tasks` when your work involves **multiple coordinated steps with
dependencies between them**, each step needing its own isolated worktree and the
ability to run autonomously without your supervision. Good fits:

- **Multi-phase feature branches**: plan → spec → implement → test → document,
  where each phase depends on the prior one and runs in its own environment.
- **Fan-out research**: three agents each investigate a different module in
  parallel, then a summarizer combines their findings.
- **Review-fix loops**: an agent writes code, a reviewer checks it, the writer
  revises based on feedback, repeat until approved.
- **Iterative generation**: run the same atom N times in sequence, each seeing
  prior file changes.

`run_tasks` replaces ad-hoc patterns built from `delegate_to_subagents`,
kanban-style dependency tracking, workflow phases, and wisp DAGs — it
generalizes all of them into a single blocking tool call.

Do **not** use `run_tasks` for a single independent agent call — use
`delegate_to_subagents` for that. Do not use it when you need interactive mid-run
control — `run_tasks` is fire-and-forget (abort = hard kill, resume from disk).

## Profiles

Profiles define the provider, model, system-prompt, tools, and other settings
for agents spawned under a task. They are Markdown files with YAML
frontmatter.

### Profile locations

Profiles live in two directories, which are **separate from the
`agent-profiles/` directories** used by other pi extensions (pi-subagents,
pi-wisp):

| Scope   | Directory                                   |
| ------- | ------------------------------------------- |
| Global  | `~/.pi/agent/profiles/`                     |
| Project | `.pi/profiles/` (overrides global profiles) |

Project overrides take precedence over global profiles of the same name.

### Discovering and creating profiles

Use the **`list_profiles` tool** to see what profiles already exist before
creating new ones. A task or atom that references a missing profile is a
**hard error** — `run_tasks` fails immediately with a clear message listing
available profiles.

### Auto-seeded profile

The extension seeds one profile automatically on first run (never overwrites
an existing file):

- **`merge-helper`** — resolves git merge conflicts in the pool worktree.
  Installed at `~/.pi/agent/profiles/merge-helper.md`. The auto-seeded profile
  has no `provider` or `model` set — you must add them (via project or global
  override) before a merge conflict can be resolved. All other profiles
  (workers, reviewers, planners) you must create yourself — see
  [Profile format](#profile-format) below.

### Profile format

Profiles are Markdown files with YAML frontmatter. The frontmatter keys are:

| Key                  | Required | Description                                           |
| -------------------- | -------- | ----------------------------------------------------- |
| `provider`           | yes      | API provider (e.g. `anthropic`, `openai`)             |
| `model`              | yes      | Model identifier (e.g. `anthropic/claude-sonnet-4-5`) |
| `thinkingLevel`      | no       | `low`, `medium`, or `high` (tool default)             |
| `tools`              | no       | List of tool names to enable                          |
| `appendSystemPrompt` | no       | Appended to the base system prompt                    |

The **body** of the Markdown file (after the frontmatter) becomes the agent's
system prompt — the `systemPrompt` frontmatter key is **not** used; the body
always takes precedence. Example — a code reviewer profile at
`~/.pi/agent/profiles/code-reviewer.md` or `.pi/profiles/code-reviewer.md`:

```markdown
---
provider: anthropic
model: anthropic/claude-sonnet-4-5
thinkingLevel: medium
---

You are a thorough code reviewer. Review the changes in the worktree,
check for correctness, style, and edge cases. Call `gate_verdict` with your
final decision.
```

Additional frontmatter keys (all optional): `noTools`, `excludeTools`,
`noExtensions`, `extensions`, `noSkills`, `suggestedSkills`, `loadSkills`,
`noContextFiles`, `apiKey` (global only), `extraArgs`. See the pi agent
documentation for their semantics.

### Profile inheritance

When a task's `profile` or an atom's `profile` field is omitted, the atom
inherits its **task's `profile`**. The task-level `profile` is required
unless every atom in its compose tree specifies one.

## `run_tasks` Parameters

### Create a new pool

<!-- prettier-ignore-start -->
```jsonc
{
  "name": "release-feature", // required → slugified to pool id + branch
  "worktree": true, // optional; default true. false → all tasks use caller cwd
  "tasks": [
    // required, static (fixed at creation)
    {
      "id": "plan", // optional; auto-assigned t-<N> if omitted
      "title": "Write the implementation plan", // optional human label
      "prompt": "Design an architecture...", // REQUIRED — the singular task prompt (§5.1)
      "profile": "planner", // default profile for this task's atoms
      "dependsOn": [], // optional; ids or titles resolved at creation
      "compose": { "type": "agent" } // optional; omit → single {type:"agent"}
    }
  ],
  "limits": {
    // optional (see limits model)
    "total": 4,
    "provider": { "anthropic": 3 },
    "model": { "anthropic/claude-sonnet-4-5": 2 }
  },
  "maxRetries": 2 // optional, default 2
}
```
<!-- prettier-ignore-end -->

- `name` is slugified (kebab-case) to become the **pool id**, the git branch
  (`pi-subagent-task/<slug>`), and the on-disk directory name.
- `worktree` defaults to `true`. Set it to `false` for shared-cwd execution:
  no git repository is required, no branches/worktrees are created, and no
  merge/finalization step occurs. All agents see the caller's current directory,
  so use this for read-only research/planning or disjoint outputs—not concurrent
  edits to the same files.
- `dependsOn` is resolved against task `id`s and `title`s at creation. An
  unresolved reference is a hard error.
- If a pool id already exists on disk and no `resume` is given, `run_tasks`
  errors and suggests using `resume`.

### Resume an existing pool

```json
{ "resume": "release-feature" }
```

See [Retry, failure, and resume behavior](#retry-failure-and-resume-behavior)
for full details.

## Compose DSL (atom kinds)

Every task has exactly one **compose tree** — a nested JSON structure that
defines how the task's agents execute. A task with no `compose` field is
equivalent to `{ "type": "agent" }` using the task's profile.

Every atom carries **no prompt of its own** — only an optional `profile`
(inherits from task if omitted) and an optional `title` (used in parallel headers
and the TUI board).

### `agent` — single agent session

```json
{ "type": "agent", "profile": "coder", "title": "implement" }
```

The simplest atom. Runs one agent with the task's prompt. Resolves when the
agent completes.

### `sequential` — ordered pipeline

```json
{
  "type": "sequential",
  "atoms": [
    { "type": "agent", "profile": "test-writer" },
    { "type": "agent", "profile": "coder" }
  ]
}
```

Runs child atoms one after another in the **same worktree**. Each atom receives
the prior atom's last message as context (see "Inter-atom result flow" below).
The task is done when the last child completes.

### `parallel` — concurrent siblings

```json
{
  "type": "parallel",
  "atoms": [
    { "type": "agent", "profile": "research-1", "title": "module-a" },
    { "type": "agent", "profile": "research-2", "title": "module-b" },
    { "type": "agent", "profile": "research-3", "title": "module-c" }
  ]
}
```

Starts all child atoms concurrently (subject to concurrency limits). All share
the **same worktree** — see the parallel-atom caveat below. The parallel node
completes when all children complete. Its **output** (to the next sequential
sibling) is the concatenation of each child's last message, prefixed by the
atom's `title` (or profile name / index as fallback).

### `gateLoop` — work-then-review loop

```json
{
  "type": "gateLoop",
  "work": { "type": "agent", "profile": "coder" },
  "review": { "type": "agent", "profile": "code-reviewer" },
  "maxIterations": 3
}
```

1. Runs the `work` agent (supports session resume on retry).
2. Runs the `review` agent in the same worktree (so it can `git diff` / read
   files). The reviewer emits a verdict by calling the **`gate_verdict`**
   tool (`{ approved: boolean, feedback: string }`). This tool is
   **internally registered by the extension** and automatically available to
   all spawned agents; the reviewer profile's system-prompt instructs calling
   it as the final step.
3. If `approved === true` → loop exits; the work atom's final last message
   flows downstream.
4. If `approved === false` → prepend feedback to the work agent's prompt and
   loop back to step 1 (resuming the prior work session).
5. If `maxIterations` is reached without approval → task failure (triggers
   the retry/failure path). `maxIterations` defaults to **3** if omitted.

### `loop` — fixed-iteration repeat

```json
{
  "type": "loop",
  "atom": { "type": "agent", "profile": "variant-gen" },
  "count": 3
}
```

Runs the child atom exactly `count` times in the **same worktree**, sequentially.
Each iteration is a fresh agent session that sees prior iterations' file changes
and receives the prior iteration's last message as context.

### Worked examples

**TDD (tests-first, then code):**

A single task whose compose tree is a `sequential` of two `gateLoop` atoms:
the first iterates on test writing, the second on implementation.

```json
{
  "name": "tdd-feature",
  "tasks": [
    {
      "id": "tdd-cycle",
      "title": "TDD: tests then code",
      "prompt": "Implement the user-auth feature using TDD. Write tests first, then make them pass.",
      "profile": "coder",
      "compose": {
        "type": "sequential",
        "atoms": [
          {
            "type": "gateLoop",
            "work": { "type": "agent", "profile": "test-writer" },
            "review": { "type": "agent", "profile": "code-reviewer" },
            "maxIterations": 3
          },
          {
            "type": "gateLoop",
            "work": { "type": "agent", "profile": "coder" },
            "review": { "type": "agent", "profile": "code-reviewer" },
            "maxIterations": 3
          }
        ]
      }
    }
  ],
  "limits": {
    "total": 4
  }
}
```

Tests first: the `test-writer` agent writes tests; `code-reviewer` approves
or rejects them with feedback. Once approved, the `coder` agent implements
until the reviewer approves. Both atoms use gateLoop's iterative refinement
inside the same task worktree.

Notice that `work` and `review` are **atom objects**
(`{"type":"agent","profile":"..."}`), not profile-name shorthands.
Each inherits the task's prompt and the preceding atom's flow context
(§[Inter-atom result flow](#inter-atom-result-flow-context-chaining)).

---

**Fan-out research then summarize:**

This pattern can be structured **either** way depending on intent:

1. **Single task** — a `sequential` whose children are a `parallel` of
   researchers followed by a summarizer atom. All agents share **one task
   prompt**. This is appropriate when you want a unified research brief and
   the summarizer should synthesize under the same instruction. The summarizer
   atom receives the concatenated research outputs as flow context
   (§[Inter-atom result flow](#inter-atom-result-flow-context-chaining))
   plus the shared prompt.

2. **Separate tasks** — a research task and a summary task with
   `dependsOn: ["research"]`. Each task has its **own prompt**, appropriate
   when research and summary are distinct work products. The summary task's
   worktree sees the research task's merged files because dependents branch
   after parents merge.

The distinction matters because of the
[singular-prompt rule](#singular-prompt-rule): inside a single task, every
atom gets the same prompt verbatim. If the research and summary need different
instructions, use separate tasks with `dependsOn`.

---

**Plan until approved:**

A single `gateLoop` atom: write a plan, have a reviewer validate it, iterate
until satisfactory or maxIterations reached.

```json
{
  "type": "gateLoop",
  "work": { "type": "agent", "profile": "plan-writer", "title": "plan-writer" },
  "review": { "type": "agent", "profile": "plan-reviewer", "title": "plan-reviewer" },
  "maxIterations": 5
}
```

Note that `work` and `review` are full atom objects, not profile names —
each has a `"type": "agent"` wrapper.

## The singular-prompt rule and inter-atom result flow

### Singular-prompt rule

Every agent spawned under a task receives the task's `prompt` **verbatim**.
Atoms carry **no prompt of their own** — only an optional `profile` override
(or inherit from the task) and an optional `title`.

This means:

- A summarizer or reviewer atom **does not receive a separate per-atom
  instruction**. Instead it reads files in the shared worktree (the reviewer
  can `git diff`, inspect source, read output files) and receives the flow
  context described below.
- An atom that omits `profile` inherits the task's profile.

### Inter-atom result flow (context chaining)

In addition to the constant task prompt, each atom passes its **last assistant
message** to the next downstream atom. The effective prompt for any agent is:

```
<prior-result context>

---

<task prompt>
```

- **Root atom** (no predecessor) gets only the task prompt (no context prefix).
- **`sequential`** — atom A's last message flows to B; B's to C; etc.
- **`parallel`** — all children run on the same incoming context. Their last
  messages are concatenated (each prefixed with a header from the atom's
  `title`) and become the parallel node's single output to the next sibling.
- **`gateLoop`** — the work atom's last message flows to the review atom
  (which also inspects the worktree). The work atom's final last message is
  the gateLoop's output after exit.
- **`loop`** — iteration _i_'s last message flows to iteration _i+1_ as
  context.

## Concurrency limits and the Parked status

### Three AND-gated limit pools

```jsonc
"limits": {
  "total": 4,                              // whole-pool cap
  "provider": { "anthropic": 3 },          // any anthropic model, counted together
  "model": { "anthropic/claude-sonnet-4-5": 2 }  // that exact model
}
```

- **`total`** — default `4`. Caps the number of simultaneously running agents
  across the entire pool.
- **`provider[<provider>]`** — caps all sessions using a given provider
  regardless of model (e.g. `anthropic: 3` counts Sonnet + Opus together).
- **`model["<provider>/<model>"]`** — caps sessions using a specific
  provider/model pair.

An agent may start **iff every applicable pool has room** (AND-semantics). A
pool that is not configured is unlimited (not consulted).

A session using `anthropic/claude-sonnet-4-5` consumes 1 from `total`, 1 from
`provider.anthropic`, and 1 from `model["anthropic/claude-sonnet-4-5"]`.

The merge-helper agent also consumes limit slots like any other agent.

### The six task statuses

| Status    | Color  | Meaning                                                                                                               |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `blocked` | orange | Has unfinished dependencies.                                                                                          |
| `ready`   | blue   | All deps done; available to run, waiting on capacity.                                                                 |
| `running` | yellow | At least one agent is executing for this task.                                                                        |
| `parked`  | orange | Had agents running; now has zero running AND cannot start the next agent because every applicable limit pool is full. |
| `failed`  | red    | Exhausted all retries.                                                                                                |
| `done`    | green  | All atoms complete and merged into the pool branch.                                                                   |

> **Note:** Dependents of a failed task become `skipped` — a display variant of `failed`, shown as ⊘ SKIPPED in summaries (they never run).

### Parking invariant

A task is moved to `parked` **only** from `running`, and only when (a) zero of
its agents are currently running **and** (b) none of the agents it wants to
start next can acquire capacity. A `ready` task never becomes `parked` directly
— it just waits in the ready queue. The scheduler prioritizes `parked` tasks
over `ready` ones so they get the next freed slot.

## On-disk layout, finalizing, and inspecting

### Layout

```
.pi/subagent-tasks/<id>/
├── state.json              # canonical pool state (JSON)
├── audit.jsonl             # append-only event log
├── sessions/               # native pi session files, flat-named post-run
│   └── 20260709T151730Z-tests.jsonl
├── worktrees/
│   ├── pool/               # pool worktree (branch: pi-subagent-task/<slug>)
│   ├── <taskId>/           # task worktree (branch: pi-subagent-task/<slug>--<taskId>)
│   └── ...
└── artifacts/              # agents are told to write run artifacts here
```

### Finalizing (merging to main)

`run_tasks` does **not** merge the pool branch into main — that is the
orchestrator agent's job using plain git tools. After the pool completes:

```bash
# Fast-forward merge (if possible, recommended):
git merge --ff-only pi-subagent-task/<slug>

# Or create a PR:
gh pr create --head pi-subagent-task/<slug>
```

The `state.json` file records `baseBranch` (the repo branch at pool creation)
so you know the merge target.

### Inspecting a pool

Use `get_task_history({ "poolId": "<pool>", "taskId": "<task>" })` to get every
agent execution's final response in completion order, including retries and
rejected gate-loop iterations. Pass `"fullSessionData": true` only when the
final responses are insufficient; it includes every JSONL entry from each
session used by the task and can be large.

For raw pool state and logs, use the pi `read` tool (not a shell builtin):

- Read the pool summary: `read .pi/subagent-tasks/<id>/state.json`
- Read the event log: `read .pi/subagent-tasks/<id>/audit.jsonl`
- List session files: `ls .pi/subagent-tasks/<id>/sessions/`
- Read a specific agent's transcript:
  `read .pi/subagent-tasks/<id>/sessions/20260709T151730Z-tests.jsonl`

### Final summary format

When the pool reaches a fixed point (all tasks done or failed), `run_tasks`
returns a plain-text summary:

```
Pool: release-feature  (id: release-feature)
Pool branch: pi-subagent-task/release-feature   (worktree: .pi/subagent-tasks/release-feature/worktrees/pool)
Tasks: 3 done, 1 failed, 1 skipped
Task IDs: plan, tests, code, docs, deploy
  ✓ plan        (session: …/sessions/…-plan.jsonl)
  ✓ tests       (session: …/sessions/…-tests.jsonl)
  ✓ code        (session: …/sessions/…-code.jsonl)
  ✗ docs        FAILED after 3 attempts — <reason>  (resume to retry)
  ⊘ deploy      SKIPPED (depends on failed: docs)
Sessions: .pi/subagent-tasks/release-feature/sessions/
Audit:    .pi/subagent-tasks/release-feature/audit.jsonl
Finalize: from your repo, e.g.  git merge --ff-only pi-subagent-task/release-feature
                              | gh pr create --head pi-subagent-task/release-feature
```

## Retry, failure, and resume behavior

Two-level retry model:

### Level 1 — per-agent soft-retry (resume session)

When an individual agent process errors (nonzero exit, crash, idle timeout, loop
detected, or gateLoop maxIterations exhausted), the same agent is retried by
**resuming its existing session** (native `pi --session <path>`), up to **5
total executions** (1 initial attempt + up to 4 soft-retries). Audit `agent_retry` is logged per
retry.

### Level 2 — whole-task fresh restart

If the agent still fails after 5 total executions, that is a **task-attempt failure**:

- If `retryCount <= maxRetries` (default `2`): **fresh restart** — up to
  `maxRetries` whole-task fresh restarts (i.e. 3 total task attempts before
  `failed`). The task worktree and branch are deleted, a new worktree is
  created from the current pool HEAD, the compose cursor is reset, and
  brand-new sessions run. Audit `worktree_deleted` and `worktree_created` are
  logged.
- Otherwise: `task.status = failed`. Dependents of a failed task become
  `failed(skipped)` during fixed-point propagation.

### Resume

`run_tasks({ resume: "<id>" })`:

- Resets all `failed` tasks back to `ready`.
- Tasks whose persisted status was `running` or `parked` (dead process from a
  hard-kill) are reset to `ready` — the in-flight atom starts fresh (the
  half-written session is discarded).
- Missing worktrees are recreated from the pool HEAD.
- The pool continues execution from the restored state.

A hard tool abort (SIGKILL) leaves the on-disk state intact, so `run_tasks
({resume})` works reliably.

## Parallel-atom caveat (shared worktree)

Parallel atoms within the same task share **one task worktree**. They write to
the same filesystem. Last-writer-wins races are possible if multiple agents
write to the same file. The extension does **not** detect intra-task file
conflicts at runtime — they surface only at the task merge into the pool branch
(and only if they collide with pool state).

**Guidance:** use `parallel` only for atoms that write to **disjoint files**,
are read-only (scouting, researching), or write structured artifacts to the
`artifacts/` directory. Do not use `parallel` for atoms that modify the same
source file concurrently.
