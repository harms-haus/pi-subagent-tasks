# Build: `pi-task-pools` — a pi-coding-agent extension

> This document is the full specification / build prompt for a new extension. It
> consolidates platform research, every decision made during brainstorming, and
> the stated defaults that still await a final yes/no. It is intentionally
> exhaustive; implement against it, and flag any place where a "stated default"
> is wrong.

---

## 1. Executive summary

`pi-task-pools` is a single pi-coding-agent extension that provides **one tool**
(`run_tasks`) and **one skill**. It lets the agent define an ordered pool of
dependent "tasks", then **autonomously orchestrates** the entire pool: it spawns
sub-agent processes under named profiles, manages per-task git worktrees off a
shared pool worktree, serially merges finished work back into the pool branch
(reviving a `merge-helper` agent on conflicts), enforces multi-dimensional
concurrency limits, and renders a live, tiered "board" of task states inside the
tool output (Ctrl+O expands it). The blocking tool call returns when the pool
reaches a fixed point.

It is the autonomous-orchestrator generalization of `delegate_to_subagents`, with
a dependency scheduler (kanban-class), a composition DSL (wisp-class), and
worktree isolation (pi-worktrees-class) built in.

**This extension is intended to supersede** (the user will disable):
`pi-subagents`, `pi-workflows`, `pi-kanban`, and `pi-wisp`.

---

## 2. Scope

**It IS:**
- An autonomous scheduler/orchestrator that the agent kicks off via one tool call.
- A composition system for per-task agent pipelines (`sequential` / `parallel` /
  `gateLoop` / `loop` atoms).
- Worktree-isolated, merge-queued, durable, resumable execution.
- A live TUI board with Ctrl+O expand.

**It is NOT (explicitly decided):**
- LLM-driven stepping (no `claim_tasks`/`workflow_step` style tools — the
  extension drives itself).
- More than one tool. Finalizing the pool branch (PR/squash/FF/merge to a
  target) and inspecting sessions is done by the agent with plain `git`/`read`
  against the documented on-disk layout.
- Interactive mid-run control. Fire-and-forget; abort = hard kill.
- Dynamic task addition. A pool's task set is fixed at creation.

---

## 3. Confirmed platform capabilities (research basis)

Verified against the installed pi docs/examples and the four extensions being
superseded. These are the building blocks; the implementation should crib
directly from the cited files (see §18).

| Capability | How / where it's proven |
|---|---|
| Spawn an agent as a subprocess | `pi-subagents/src/spawner.ts`: `spawn(pi, ["--mode","json","-p","--no-session", ...profileArgs])`, prompt via **stdin**; JSON events (`message_end`, `turn_end`) stream on stdout. Has loop detection + SIGTERM→SIGKILL abort + idle-timeout auto-extend. |
| Profiles → CLI args | `pi-subagents/src/profiles.ts` `profileToArgs()`: frontmatter (`provider/model/thinkingLevel/tools/excludeTools/systemPrompt/appendSystemPrompt/skills/extensions/extraArgs/apiKey`) → `--provider/--model/--system-prompt/--append-system-prompt/--thinking/--tools/--skill/--extension/...`. |
| Native session files at a custom dir | pi CLI flags `--session-dir <dir>` and `--session <path\|id>` (and `--no-session` to disable). Env `PI_CODING_AGENT_SESSION_DIR`. **Caveat (verified):** pi nests files by cwd — `<dir>/--<cwd>--/<ts>_<uuid>.jsonl` — so we move+rename post-run to our flat `{timecode}-{name}.jsonl` and resume by path. |
| Blocking tool that streams a live board | `pi-subagents/src/tools/delegate.ts`: `execute(...)` is async, calls `onUpdate({content, details})` continuously, resolves only when done; `renderResult(result, options, theme)` re-renders on each update. |
| Ctrl+O expand | Built-in keybinding `app.tools.expand` = `ctrl+o` = "Collapse or expand tool output"; toggles `options.expanded` passed to `renderResult`/`registerEntryRenderer`. Doc: `ctx.ui.setToolsExpanded()` / `getToolsExpanded()`. |
| Concurrency limiting | `pi-subagents/src/utils.ts` `mapWithConcurrencyLimit()`. |
| Dependency resolution + status recompute | `pi-kanban/src/resolve-deps.ts`, `state.ts` (`recomputeStatuses`). |
| Composition IR (atoms) | `pi-wisp/src/types.ts`: `node/parallel/sequence/cond/loop(until,maxIterations)/fanOut/reduce`. Our `gateLoop` ≈ wisp reviewLoop; our `loop` ≈ wisp `loop`. |
| git via extension | `pi.exec("git", [...])`; `pi-worktrees/src/git.ts` (`gitExec`, `parseWorktreePorcelain`, `getWorktreeList`, `getMainWorktree`) and `worktree.ts` (merge-integrity verify, untracked-file copy, AI commit msg) are hardened primitives. |
| Persistence + reconstruct | `pi.appendEntry(customType, data)` + reconstruct on `session_start` from `ctx.sessionManager.getBranch()` (kanban/workflows pattern). For us, **disk files under `.pi/task-pools/{id}/`** are primary (see §12). |
| TUI primitives | `@earendil-works/pi-tui` (`Container`, `Text`, `Spacer`, `Box`); `theme.fg("warning"|"error"|"success"|"accent"|"dim"|"muted"|"toolTitle", text)`, `theme.bold(...)`. |
| Background resources | Defer to `session_start`; clean up on `session_shutdown`. Factory must not start timers/processes. |
| Events | `pi.on("session_start"|"session_shutdown"|...)`, `pi.events` bus. |

---

## 4. Decisions log (from brainstorming — all confirmed)

| # | Topic | Decision |
|---|---|---|
| D1 | Execution model | **Blocking orchestrator.** `run_tasks` blocks; an internal scheduler loop runs autonomously, streams the live board via `renderResult`, returns a summary at the fixed point. |
| D2 | Composition format | **Nested JSON `compose` tree** in each task spec. Atom kinds: `agent` / `parallel` / `sequential` / `gateLoop` / `loop`. |
| D3 | Parallel-atom isolation | **One worktree per task.** Parallel atoms share the task's worktree (guidance: parallel atoms should touch disjoint areas; see §10 caveat). |
| D4 | Profiles location | **New `profiles/` dirs:** `~/.pi/agent/profiles/` (global) + `.pi/profiles/` (project, overrides global). The old `agent-profiles/` is **ignored**. |
| D5 | Termination | **Fixed point:** return when no task is Ready/Running/Parked (everything Done or Failed). A task whose dependency permanently Failed is marked Failed(skipped) and never runs. Partial success allowed. |
| D6 | Retry / Failed (two-level) | **(1)** per-agent **soft-retry** that RESUMES the same session, up to **5 total executions** (1 attempt + 4 retries); **(2)** if the agent still fails → task-attempt failure → **whole-task fresh restart** (delete worktree + branch, new worktree from pool HEAD, reset compose cursor, fresh sessions) up to `maxRetries` (default **2**); **(3)** then **Failed**. Failed tasks are NOT re-scheduled this run; `run_tasks({resume})` resets Failed→Ready. *(gateLoop rejection is separate — see D8.)* |
| D7 | Concurrency limits | **Three independent pools, all AND-gated:** `total` (whole pool) + `provider[<provider>]` (provider-only; counts every session using that provider regardless of model) + `model["<provider>/<model>"]` (provider/model-only). An agent may start iff **every** applicable pool has room. Default `total: 4`; provider/model unset = unlimited. |
| D8 | gateLoop verdict | **Structured-output schema verdict + resume work.** Reviewer emits `{approved:boolean, feedback:string}`. approved → loop exits. rejected → work agent **resumes** (`--session <path>`, native resume — §11) with feedback prepended. Cap `maxIterations` (default **3**); exhausting it = task failure → D6 retry/Failed path. |
| D9 | Merge strategy | **Fast-forward if possible; else a merge commit produced by the `merge-helper` agent.** Serial merge queue; pool HEAD locked during merge. Unresolved conflict → task → **Failed** (D6). |
| D10 | Pool base + deps | **Base = repo's current branch HEAD** at pool start. Each task worktree branches from the pool branch's **current** HEAD at task-start time. Because deps must be Done+merged first, a dependent task branches **after** its parents merged → **sees their code**. Pool branch never auto-merges to main. |
| D11 | Session files | **Native pi session files.** Spawn each agent with `--session-dir <pool>/sessions` (drop `--no-session`); pi writes `<dir>/--<cwd>--/<ts>_<uuid>.jsonl` (nested by the task worktree cwd) — after the run **move+rename** to flat `<pool>/sessions/{timecode}-{name}.jsonl`; resume via `--session <that-path>`. ⚠ smoke-test that `-p`/json mode persists without `--no-session` (§21). |
| D12 | Pool durability | **Durable + resumable by id.** Full state persisted to disk; `run_tasks({resume:<id>})` reloads and continues (resets Failed→Ready, restores Parked/Running). Survives across pi sessions. |
| D13 | Tool surface | **`run_tasks` only.** Finalize/inspect via agent's plain `git`/`read` against documented layout. |
| D14 | Interjection | **Fire-and-forget.** No pause/cancel shortcuts. Aborting the tool = **hard-kill** all child agents immediately; in-flight partial state discarded; persisted on-disk state remains for resume. |
| D15 | Profile seeding | **Seed only `merge-helper.md`** into `~/.pi/agent/profiles/` on first run if absent (never overwrite). All other profiles (workers, reviewers) the user creates. Missing referenced profile → clear error. |
| D16 | Dynamic tasks | **Static.** Task set fixed at creation. Resume only continues/retries existing tasks. |

---

## 5. Core concepts & data model

### 5.1 The singular prompt + result-flow model

A task has **exactly one prompt**, and every agent spawned under that task
receives it **verbatim** (it is constant). Atoms carry **no prompt of their
own** — only an optional `profile` and `title`. An atom that omits `profile`
**inherits the task's `profile`**.

What differs between agents is: (a) the **profile** (provider/model/system-
prompt/tools) and (b) the **inter-atom result context** that flows through the
compose tree (§5.5).

- A `gateLoop`'s reviewer runs with the same task prompt + a reviewer profile
  (whose system-prompt instructs it to review and emit the verdict schema) + the
  work atom's last message as context. It also inspects the **on-disk worktree
  state** (it runs after the work atom, sequentially, in the same worktree — it
  can `git diff`/read files).
- A summarizer/reduce atom receives its predecessors' results as context (§5.5)
  — it does **not** need a per-atom prompt.

### 5.2 Task statuses (exactly these six)

| Status | Color | Meaning |
|---|---|---|
| `blocked` | orange | Has un-finished dependencies. |
| `ready` | blue | All deps Done; available to run, not currently running (waiting on capacity/priority). **Persists** (not transient). |
| `running` | yellow | ≥1 of the task's agents is executing, OR the task can immediately start its next agent. |
| `parked` | orange | Was running; now has **zero** agents running **and** cannot start its next agent (capacity-blocked on every applicable limit pool). |
| `failed` | red | Exhausted retries (D6). Not re-scheduled this run; reset to `ready` only on `run_tasks({resume})`. |
| `done` | green | All atoms complete **and** merged into the pool branch. |

**Parking invariant (D7 refinement):** a task is moved to `parked` **only** from
`running`, and only when (a) zero of its agents are currently running **and**
(b) none of the agents it wants to start next can acquire capacity. **Never park
a task while any of its agents could run.** `ready` never becomes `parked`
directly (it just waits).

### 5.3 Concurrency limit pools (D7)

```jsonc
"limits": {
  "total": 4,                              // whole-pool cap
  "provider": { "anthropic": 3 },          // any anthropic model, counted together
  "model": { "anthropic/claude-sonnet-4-5": 2 }  // that exact model
}
```
- A session using `anthropic/claude-sonnet-4-5` consumes 1 from `total`, 1 from
  `provider.anthropic`, and 1 from `model["anthropic/claude-sonnet-4-5"]`.
- A session using `anthropic/claude-opus` consumes 1 from `total` and 1 from
  `provider.anthropic` (no model-specific limit unless set).
- provider-only covers **all** models under that provider and fills for every
  session using that provider even if the model isn't individually limited.
- An agent may start **iff every applicable pool has room** (AND-semantics). A
  pool that isn't configured is unlimited (not consulted).

### 5.4 Compose atoms (D2) — JSON schema

Every atom resolves to one or more **agent sessions**, each = the task's single
prompt (constant for all agents) + **inter-atom result context** that flows
through the tree (§5.5) + a profile. Atoms carry **no prompt of their own** —
only an optional `profile` and `title`.

```jsonc
// A bare task with no `compose` is equivalent to: { type: "agent" } using the task's profile.
"compose": { "type": "agent", "profile": "coder", "title": "implement" }  // optional profile override + title (parallel headers / TUI / audit)

// sequential: run atoms one after another in the same worktree; next starts after prev completes
{ "type": "sequential", "atoms": [ <atom>, <atom>, ... ] }

// parallel: start all child atoms concurrently (subject to limits); task is done when all complete
{ "type": "parallel", "atoms": [ <atom>, <atom>, ... ] }

// gateLoop: run `work`, then `review`; approved→exit, rejected→resume `work` with feedback; cap maxIterations
{ "type": "gateLoop",
  "work":   { "profile": "coder" },
  "review": { "profile": "code-reviewer" },
  "maxIterations": 3 }

// loop: run `atom` exactly `count` times in the same worktree, sequentially; each iteration is a fresh agent that sees prior iterations' file changes
{ "type": "loop", "atom": { "profile": "variant-gen" }, "count": 3 }
```

Worked examples from the spec:
- `sequential([ gateLoop(test-writer, test-reviewer), gateLoop(coder, code-reviewer) ])` — TDD: tests first (loop until red+complete), then code (loop until green+complete).
- `sequential([ parallel([research-1, research-2, research-3]), summarize ])` — fan out research, then one summarizer.
- `gateLoop(plan-writer, plan-reviewer)` — plan until satisfactory.

### 5.5 Inter-atom result flow

The task prompt is constant for every agent. In addition, the **last assistant
message** of each atom flows downstream as context:

- **`sequential([A,B,C])`** — a pipeline: A's last message is passed to B; B's
  to C.
- **`parallel([X,Y,Z])`** — all run on the same incoming context; their last
  messages are concatenated, **each prefixed with a header from the atom's
  `title`** (fallback: profile name, then index). That concatenation is the
  parallel node's **single output**, passed to the next sequential sibling.
- **`gateLoop`** — the work atom's last message flows to the review atom (which
  also inspects the worktree); the work atom's final last message is the
  gateLoop's output.
- **`loop(atom, n)`** — iterations chain: iteration *i+1* receives iteration
  *i*'s last message as context.

Effective prompt for any agent = `<prior-result context>\n\n---\n\n<task.prompt>`
(context first, then the constant task instruction). A root atom with no
predecessor gets only the task prompt. This makes
`sequential([ parallel([r1,r2,r3]), summarize ])` work: the summarizer receives
the headed concatenation of the three research outputs.

---

## 6. The `run_tasks` tool

### 6.1 Parameters (create vs resume are mutually exclusive)

```jsonc
// CREATE
{
  "name": "release-feature",            // required → slugified to pool id + branch + dir
  "tasks": [ <task>, ... ],             // required (static; D16)
  "limits": { "total": 4, "provider": {...}, "model": {...} },  // optional (D7)
  "maxRetries": 2                       // optional, default 2 (D6)
}

// RESUME
{ "resume": "release-feature" }         // existing pool id/slug (D12)

// task object
{
  "id": "tests",                        // optional; else assigned t-<N>. Used by `dependsOn`.
  "title": "Write test suite",          // optional human label
  "prompt": "...",                      // REQUIRED. The singular task prompt (§5.1).
  "profile": "coder",                   // default profile for this task's atoms (inheritance: §5.1)
  "dependsOn": ["plan"],                // optional; ids OR titles, resolved at creation (kanban-style)
  "compose": { ... }                    // optional; omit → single {type:"agent"} (§5.4)
}
```

`name` is slugified (kebab) to the **pool id**. Branch = `pi-task-pool/<slug>`.
If a pool id already exists on disk and no `resume` is given → error (suggest
`resume`). `dependsOn` is resolved against task ids/titles at creation (kanban
`resolveBlockedByTitles`); unresolved refs are a hard error.

### 6.2 Return value (final summary — this is the agent's only handle)

Plain-text `content` + structured `details` (for branching/reconstruction). Must
include everything the agent needs to finalize with plain git:

```
Pool: release-feature  (id: release-feature)
Pool branch: pi-task-pool/release-feature   (worktree: .pi/task-pools/release-feature/worktrees/pool)
Tasks: 3 done, 1 failed, 1 skipped
  ✓ plan        (session: …/sessions/…-plan.jsonl)
  ✓ tests       (session: …/sessions/…-tests.jsonl)
  ✓ code        (session: …/sessions/…-code.jsonl)
  ✗ docs        FAILED after 3 attempts — <reason>  (resume to retry)
  ⊘ deploy      SKIPPED (depends on failed: docs)
Sessions: .pi/task-pools/release-feature/sessions/
Audit:    .pi/task-pools/release-feature/audit.jsonl
Finalize: from your repo, e.g.  git merge --ff-only pi-task-pool/release-feature
                              | gh pr create --head pi-task-pool/release-feature
```

The collapsed `renderResult` shows the live board (§13); the final return is the
summary above.

---

## 7. Scheduler algorithm (the heart of the extension)

State (in-memory, mirrored to `state.json`):
- `tasks[]`: id, title, prompt, profile, dependsOn, compose, status, retryCount,
  atom-execution cursor (where in the compose tree it is), runningAgentCount,
  taskWorktreePath, taskBranch, lastSessionId (for gateLoop resume).
- `pools`: `{ total:{used,cap}, provider:{[p]:{used,cap}}, model:{[p/m]:{used,cap}} }`.
- `mergeQueue`: FIFO of task ids awaiting merge (processed serially).
- `mergeInProgress`: boolean (pool HEAD lock).

### 7.1 Pseudocode

```
// Try to start the next agent(s) a task wants, given current atom cursor.
// Returns true if at least one agent was started (or one is already running).
function tryAdvance(task):
    if task.runningAgents > 0:
        // something's running; opportunistically try to start pending parallel siblings
        startAnyStartablePendingAgents(task)
        return true
    candidates = nextWantedAgents(task)        // from compose cursor (see 7.2)
    for agent in candidates:                   // parallel = several; sequential/gateLoop/loop = one
        if poolsHaveRoom(agent.provider, agent.model):
            startAgent(task, agent)            // consume slots, write session, audit agent_start
            return true
    return false

// Called on EVERY agent start, agent finish, and merge complete.
function onAgentFinished(task, agent, result):
    releaseSlots(agent)
    advanceComposeCursor(task, agent, result)  // gateLoop: parse verdict schema; loop: bump iter; etc.
    // AFFINITY: try to keep this task running first
    if task.runningAgents > 0:
        tryAdvance(task); return               // still has parallel agents going -> stays running
    if tryAdvance(task): return                // started its next agent -> stays running
    task.status = PARKED; audit task_parked    // nothing running, can't start next -> park
    globalSchedule()

function globalSchedule():
    if mergeQueue non-empty and not mergeInProgress: runMerge(mergeQueue.pop())
    // candidates = ready ∪ parked whose deps are all Done
    cands = [t for t in tasks if t.status in (READY, PARKED) and depsAllDone(t)]
    cands.sort by priority:  PARKED before READY;
                            within each, more transitive downstream dependents first;
                            then fewer/no deps;
                            then creation order (list order)
    for t in cands (in priority order):
        if tryAdvance(t): t.status = RUNNING; audit task_running
        // a READY task that can't start STAYS ready (never auto-parks); a PARKED one stays parked
    if nothing is RUNNING, nothing PARKED, nothing READY, mergeQueue empty:
        reachFixedPoint()                      // all Done or Failed -> return summary

function reachFixedPoint():
    // propagate failure: any task still BLOCKED whose dep is FAILED -> FAILED(skipped), transitively
    propagateFailures()
    persist(); return finalSummary             // tool resolves
```

**Main loop:** the tool's `execute()` runs an event-driven loop: it calls
`globalSchedule()` initially, then waits on agent-finish / merge-complete events
(emitted by the spawner and merge worker) and re-enters `globalSchedule()`. A
1s tick also re-renders the board (elapsed timers etc.) and re-checks for
liveness (fixed-point). The tool resolves at the fixed point.

### 7.2 `nextWantedAgents(task)` — mapping compose cursor → agent demands

- `agent` atom → one candidate (profile resolved: atom.profile ?? task.profile).
- `sequential` → the next child atom only (one candidate at a time).
- `parallel` → all children not yet started and not done (multiple candidates;
  start as many as capacity allows; the rest stay pending within the task;
  task is `running` while ≥1 child runs; parks only when 0 running and 0 can start).
- `gateLoop` → if no work-run yet or last verdict was rejected → the `work`
  candidate (resume via `--session` if a prior work session exists for this
  loop); if a work-run just completed and awaiting verdict → the `review`
  candidate.
- `loop` → the child atom for the current iteration (one at a time).
- **Prompt assembly at start time:** an agent's effective prompt = its flow
  context (per §5.5) + the constant task prompt. Flow context = predecessor's
  last message (sequential), the parallel concat (parallel→next sibling), the
  prior iteration's last message (loop), or the work atom's last message
  (gateLoop review).

### 7.3 Priority detail

"Downstream dependents" = number of tasks that (transitively) depend on this one.
Compute once at creation (DAG), store the count. Ties → list order. This is what
makes high-fanout tasks win the next freed slot.

---

## 8. Retry & failure model (D6) — two levels

**Level 1 — per-agent soft-retry (resume).** When an individual agent process
errors (nonzero exit, crash, idle-timeout, loop-detected, or gateLoop
maxIterations exhausted), retry **that same agent** by **resuming its session**
(native `pi --session <id>`), up to **5 total executions** (1 attempt + 4
retries). Audit `agent_retry` (with attempt #) per retry. If the agent produced
no session before erroring, the retry is a fresh run that then becomes resumable
for subsequent retries.

**Level 2 — whole-task fresh restart.** If the agent still fails after 5
executions → that's a **task-attempt failure**: `taskRetryCount++`.
- If `taskRetryCount <= maxRetries` (default 2): **fresh restart** — delete the
  task worktree + its branch, create a new worktree from current pool HEAD,
  reset the compose cursor **and per-agent retry counters**, run brand-new
  sessions. Audit `worktree_deleted`, `worktree_created`, `task_retry`.
- Else: `task.status = FAILED`. Audit `task_failed`. Not re-scheduled this run.

**Failure propagation:** dependents of a FAILED task → FAILED(skipped) at
fixed-point propagation. `run_tasks({resume})` resets FAILED → READY
(and parks/restores others).

**Resume reconciliation (edge case):** on `run_tasks({resume})` — especially in
a *new* pi session after a hard-kill abort — any task whose persisted status is
`running`/`parked` has a **dead process** and a possibly-partial session.
Reconcile: set such tasks to `ready`; for the atom that was in-flight, **start
fresh** (do NOT resume a half-written session — abort was a hard kill) and reset
that atom's soft-retry counter. Also re-verify worktrees via `git worktree list`
and recreate any task worktree that's missing but whose state says it should exist.

---

## 9. gateLoop semantics (D8)

1. Run `work` agent (resume prior work session if one exists for this loop via
   `pi --session <id>`; else fresh).
2. Run `review` agent (fresh each time; receives the work atom's last message as context per §5.5) and capture its verdict `{approved:boolean, feedback:string}`. **There is no CLI `--output-schema`** (verified); enforce via one of:
   - **(Recommended) terminating tool:** pi-task-pools registers a `gate_verdict({approved, feedback})` tool with `terminate:true` (pattern: `examples/extensions/structured-output.ts`). Since pi-task-pools is installed, spawned agents auto-load it; the reviewer profile's system-prompt instructs calling `gate_verdict` last. We read `approved`/`feedback` from the `tool_execution_end` event args in the JSON stream. *(Adds one internal tool visible to all agents — minor deviation from D13; acceptable plumbing.)*
   - **(Fallback) JSON-in-text:** reviewer profile instructs "respond with ONLY a JSON object"; parse the last assistant text from `message_end`/`agent_end`. Less robust.
   Invalid/missing verdict → treat as rejected (feedback: "reviewer produced no valid verdict").
3. `approved === true` → gateLoop exits; advance compose cursor. The gateLoop's output (= the work atom's final last message) flows to the next sequential sibling (§5.5).
4. `approved === false` → prepend to the next `work` run:
   `Previous review feedback:\n<feedback>\n\n<task prompt>`; increment iteration.
5. Iteration ≥ `maxIterations` (default 3) still not approved → **task failure**
   (→ §8 retry/Failed). Audit `gateloop_rejected` / `gateloop_approved`.

---

## 10. Worktree & merge lifecycle (D3, D9, D10)

### 10.1 Creation
- At pool start: create **pool worktree** at
  `.pi/task-pools/<id>/worktrees/pool` on branch `pi-task-pool/<slug>`, based on
  the repo's **current branch HEAD** (D10). Audit `worktree_created(pool)`.
- Each task: on **first start** (when it first transitions toward running),
  create its worktree at `.pi/task-pools/<id>/worktrees/<taskId>` on branch
  `pi-task-pool/<slug>/<taskId>`, based on the pool branch's **current HEAD**
  (so dependents branch after their parents merged — D10). Audit
  `worktree_created(<taskId>)`.

### 10.2 Per-task merge (serial queue, D9)
When a task's atoms all complete:
1. Enqueue task id in `mergeQueue`.
2. Merge worker (one at a time; `mergeInProgress` locks pool HEAD):
   - In the **pool worktree** (pool branch checked out): attempt
     `git merge --ff-only <taskBranch>`.
   - If FF succeeds → done; pool HEAD advances.
   - Else → run **`merge-helper` agent**: profile `merge-helper`, prompt =
     `<task prompt>` + the conflict context (the `git merge` conflict output /
     `git diff --name-only --diff-filter=U`). It resolves in the pool worktree
     and commits. Audit `merge_conflict`, `merge_resolved` (or `merge_failed`).
   - If merge-helper still can't produce a clean merge → task → **FAILED** (§8),
     abort the merge (`git merge --abort`), audit `merge_failed`.
3. On success: audit `worktree_merged(<taskId>)`; **delete the task worktree**
   (`git worktree remove`) and its branch; audit `worktree_deleted(<taskId>)`;
   task → `done`. Then `globalSchedule()` (pool HEAD advanced → may unblock deps).

### 10.3 Caveat (parallel atoms share a worktree — D3)
Parallel agents edit the same worktree concurrently. Last-writer-wins / races are
possible if they touch the same files. **Guidance baked into the skill:** use
`parallel` only for atoms that write disjoint files (or only read / write to
`artifacts/`). Conflicts from overlapping parallel edits are NOT caught until the
task merge (and only if they collide with pool state). Document this loudly.

### 10.4 Non-git repos
If the repo isn't a git repo or worktrees can't be created → hard error at
`run_tasks` create time with a clear message. (No fallback to shared-cwd mode.)

### 10.5 Worktree location & git-status noise (verified)
The spec stores worktrees under `.pi/task-pools/<id>/worktrees/` (inside the
repo's working tree). **Verified by experiment:** `git worktree add` to a path
inside the working tree **succeeds** (no fatal error), BUT the nested worktree's
files show up in the main repo's `git status` as untracked noise (`?? .pi/`).
**Mitigation (do at pool creation):** append `.pi/task-pools/` to
`.git/info/exclude` (local-only, NOT committed — avoids touching the project's
`.gitignore`). Verified: with that excluded, `git status` is clean.
*Fallback* if a repo misbehaves: store worktrees under
`.git/pi-task-pools/<id>/worktrees/` (inside the git dir, like pi-worktrees'
`.git/worktrees/` default) while keeping `state.json` / `audit.jsonl` / `sessions/`
/ `artifacts/` under `.pi/task-pools/<id>/`.

---

## 11. Agent execution

- Reuse the proven spawner pattern from `pi-subagents/src/spawner.ts`:
  `spawn(piBinary, ["--mode","json","-p", "--session-dir", sessionsDir,
     ...(resume ? ["--session", priorSessionPath] : []), ...profileArgs])`,
  prompt via **stdin**. (`--mode json` + `-p` are complementary: print =
  non-interactive single-shot, json = output format — mirror pi-subagents' proven set.)
  - **Drop `--no-session`** so pi persists the session (D11). ⚠ **Smoke-test** that
    `-p`/json mode actually writes the file without `--no-session`.
  - pi writes the file **nested by the agent's cwd**:
    `<sessionsDir>/--<taskWtAbsPath>--/<ts>_<uuid>.jsonl`. After the agent exits,
    **move+rename** it to the flat canonical `<sessionsDir>/{timecode}-{name}.jsonl`
    and record that path in `state.json`.
  - **Resume** (soft-retry or gateLoop work-loop): re-spawn with
    `--session <that-flat-path>` (resume by path; pi appends to it). Don't rely on
    resume-by-id after renaming.
- Profile loading: read `~/.pi/agent/profiles/*.md` then `.pi/profiles/*.md`
  (project overrides), parse YAML frontmatter + body, `profileToArgs()`. Cache
  with invalidation. A referenced profile that doesn't exist → clear error
  naming the profiles dir and listing available profiles.
- Seed `merge-helper.md` into `~/.pi/agent/profiles/` on first run if absent
  (D15). Its system-prompt: "You resolve git merge conflicts in a worktree. You
  are given the task's goal and the conflicted files. Resolve, commit, do not
  push." Never overwrite an existing file.
- Loop detection + idle-timeout auto-extend + SIGTERM→SIGKILL escalation: reuse
  `spawner.ts`/`delegate-runner.ts` logic.
- All agents are instructed (via a wrapper around the task prompt) to write any
  run artifacts to `.pi/task-pools/<id>/artifacts/` (and that this should be
  rare). System prompt addition only; the task prompt itself is delivered
  verbatim.

---

## 12. Persistence & on-disk layout (primary source of truth, D12)

```
.pi/task-pools/<id>/
├── state.json              # canonical readable pool state (see below) — agent can read this to inspect
├── audit.jsonl             # append-only event log (§15)
├── sessions/               # native pi session files, MOVED flat post-run to {timecode}-{name}.jsonl
│   └── 20260709T151730Z-tests.jsonl   # (pi initially writes them nested under --<cwd>--/)
├── worktrees/
│   ├── pool/               # pool worktree (branch pi-task-pool/<slug>) — NEVER auto-merged to main
│   ├── <taskId>/           # task worktree (branch pi-task-pool/<slug>/<taskId>) — deleted after merge
│   └── ...
└── artifacts/              # where agents are told to write run artifacts
```

`state.json` (rewritten atomically after every status change; this is what the
agent reads to inspect a pool without a dedicated tool):

```jsonc
{
  "id": "release-feature", "name": "release-feature",
  "branch": "pi-task-pool/release-feature",
  "poolWorktree": ".pi/task-pools/release-feature/worktrees/pool",
  "baseBranch": "<repo branch at creation>",
  "limits": { /* D7 */ },
  "maxRetries": 2,
  "createdAt": 0, "updatedAt": 0, "status": "running|done|failed",
  "tasks": [
    { "id":"tests","title":"...","status":"done","dependsOn":["plan"],
      "retryCount":0,"sessionFiles":["…"],"worktree":null /* deleted after merge */,
      "compose":{...}, "cursor": {...} }
  ]
}
```

- Also `pi.appendEntry("pi-task-pools", {poolId})` on create/resume so the
  session can surface an active-pool hint; the disk files remain authoritative.
- Reconstruct: on `session_start`, do nothing special (pools are disk-driven);
  the blocking tool is what loads them.

---

## 13. TUI rendering (board)

Rendered as the `run_tasks` tool's `renderResult(result, options, theme)`:

- **Tiers, in this vertical order**, each a section with a header:
  1. **Active / Running** — yellow (`theme.fg("warning", …)`)
  2. **Parked** — orange → `theme.fg("mdHeading", …)` (amber; icon ⏸)
  3. **Ready** — blue → `theme.fg("accent", …)` (icon ▶)
  4. **Failed** — red → `theme.fg("error", …)` (icon ✗)
  5. **Blocked** — orange → `theme.fg("mdHeading", …)` (amber; icon ⊘)
  6. **Done** — green (`theme.fg("success", …)`)
- Each row: status icon + task title + atom progress (e.g. `[2/3]`, or current
  atom name) + retry count if >0 + elapsed/timeout + last error line (failed).
- **Collapsed (default): at most 20 rows total.** Fill tiers in the order above
  until 20; if truncated, show a final line `+N more — press Ctrl+O for full
  board`.
- **Expanded:** `if (options.expanded)` render **all** rows (Ctrl+O toggles
  `options.expanded` via built-in `app.tools.expand`).
- A 1s timer calls `onUpdate` while running so timers/progress refresh; footer
  line shows pool-level limit usage, e.g. `agents 3/4 · anthropic 2/3 · merges 0`.

**Color constraint (verified):** pi themes are fixed JSON with exactly **51
tokens** — extensions **cannot register new tokens**; `theme.fg(token, text)`
accepts only those 51. So map tiers to existing tokens (running→`warning`,
ready→`accent`, failed→`error`, done→`success`, parked+blocked→amber via
`mdHeading`/`bashMode`), disambiguated by icon + tier label. For *exact* orange/blue,
embed raw ANSI 256-color codes in the string (Text passes embedded ANSI through;
use `wrapTextWithAnsi()` for multi-line) — at the cost of not adapting to light
themes. Default: token mapping (theme-respecting).

---

## 14. Abort semantics (D14)

- No registered shortcuts. No pause/cancel.
- The tool's `execute()` receives `signal` (AbortSignal). On abort (agent/user
  cancels the tool, or pi shutdown): **hard-kill every running child process**
  (SIGKILL immediately — no graceful drain), clear the in-memory scheduler, and
  resolve the tool with the best partial summary available. **On-disk state is
  already current** (written incrementally), so `run_tasks({resume})` works.
- `session_shutdown`: same hard-kill of any lingering children.

---

## 15. Audit event taxonomy (append-only `audit.jsonl`)

One JSON object per line: `{ t: <iso>, pool: <id>, type: <event>, ...payload }`.
Emit at least:

| Event | Payload |
|---|---|
| `pool_created` | name, branch, baseBranch, taskCount, limits |
| `pool_resumed` | id, statuses snapshot |
| `pool_completed` | id, counts {done,failed,skipped} |
| `task_ready` / `task_running` / `task_parked` / `task_failed` / `task_done` / `task_skipped` | taskId, reason? |
| `task_retry` | taskId, attempt, reason |
| `agent_start` | taskId, atomPath, profile, provider/model, sessionId, resume?:bool |
| `agent_complete` / `agent_error` | taskId, sessionId, exitCode?, error?, durationMs |
| `agent_resume` | taskId, sessionId |
| `agent_retry` | taskId, sessionId, attempt (1–5), reason |
| `gateloop_approved` / `gateloop_rejected` | taskId, iteration, feedback? |
| `worktree_created` / `worktree_merged` / `worktree_deleted` | taskId\|"pool", branch, path |
| `merge_started` / `merge_conflict` / `merge_resolved` / `merge_failed` | taskId, files? |
| `limit_blocked` | taskId, provider/model, pool, used/cap (why an agent couldn't start) |

---

## 16. The skill

Ship one skill via `pi.skills` in `package.json` (auto-discovered; description in
system prompt; agent `read`s it on demand). Contents:

- **When to use `run_tasks`**: multi-step, multi-task work with dependencies that
  should run autonomously and isolated; replacing ad-hoc
  `delegate_to_subagents`/kanban/workflow patterns.
- **The `compose` DSL** (§5.4) with the worked examples.
- **The singular-prompt rule** (§5.1) and the implication that summarizer/review
  atoms read files, not passed prompts.
- **The limits model** (§5.3) and how Parked works (§5.2).
- **The on-disk layout** (§12) so the agent can **finalize** (git merge/PR the
  pool branch) and **inspect** (`read state.json`, `read` a session file) with
  plain tools.
- **Retry/Failed/resume** behavior (§8, D12).
- **Parallel-atom caveat** (§10.3).

---

## 17. Stated defaults (confirmed unless overridden)

1. **Counts/caps:** `maxRetries` 2 (task-level fresh restarts); per-agent soft-retry cap **5**; `gateLoop maxIterations` 3; `total` limit 4.
2. **`loop` iterations** chain — iteration *i+1* receives iteration *i*'s last message as context (same worktree, so it also sees prior file changes).
3. **Task id assignment:** `t-<N>` if not provided; `dependsOn` accepts ids or titles (resolved at creation, kanban-style).
4. **Branch naming:** `pi-task-pool/<slug>` and `pi-task-pool/<slug>/<taskId>`.
5. **Colors:** fixed 51-token palette (no custom tokens) — running `warning`, ready `accent`, failed `error`, done `success`, parked+blocked amber (`mdHeading`); raw-ANSI exact hues optional. (§13)
6. **Merge-helper consumes limit slots** like any agent.
7. **Board collapsed cap = 20 rows**, tier-order fill, `+N more (Ctrl+O)` line.
8. **`merge-helper.md`** is the only seeded profile; all others user-supplied.

---

## 18. Reference: what to crib from the existing extensions

| Need | Crib from |
|---|---|
| Subprocess spawning, JSON event parsing, loop detection, abort/timeout | `pi-subagents/src/spawner.ts`, `tools/delegate-runner.ts`, `utils.ts` |
| Profile markdown → CLI args; profile dir loading + caching | `pi-subagents/src/profiles.ts`, `profile-types.ts` |
| Blocking tool that streams a live `renderResult` board; `onUpdate`/`details` | `pi-subagents/src/tools/delegate.ts`, `delegate-render.ts` |
| Dependency resolution + status recompute + reconstruct | `pi-kanban/src/resolve-deps.ts`, `state.ts`, `reconstruct.ts` |
| Atom/composition IR concepts | `pi-wisp/src/types.ts` (node/parallel/sequence/loop) |
| git primitives, worktree list/parse, merge integrity | `pi-worktrees/src/git.ts`, `worktree.ts` |
| Native session writing | pi CLI `--session-dir` / `--session` flags |
| Persistence pattern | `pi.appendEntry` + reconstruct on `session_start` (kanban/workflows) |

---

## 19. Out of scope / non-goals (v1)

- No `finalize_pool`/`get_task_session`/`describe_pool` tools (D13).
- No mid-run pause/cancel shortcuts (D14).
- No dynamic task addition (D16).
- No cross-agent shared memory beyond the shared worktree + `artifacts/`.
- No automatic PR creation or push to remote (orchestrator agent's job).
- No per-atom prompts (singular-prompt rule, §5.1).
- Does not auto-disable the superseded extensions — the user removes them.

---

## 20. Suggested file layout for the extension itself

```
pi-task-pools/
├── package.json            # { pi: { extensions:["./src/index.ts"], skills:["./skills/task-pools"] } }
├── src/
│   ├── index.ts            # factory: register run_tasks + gate_verdict + skill; session_shutdown hard-kill
│   ├── types.ts            # Pool, Task, Status, Limits, Atom IR, AuditEvent
│   ├── profiles.ts         # load profiles/ md → args (adapted from pi-subagents)
│   ├── spawner.ts          # spawn pi agent, --session-dir, parse events (adapted)
│   ├── scheduler.ts        # §7 algorithm + parking + affinity + fixed-point
│   ├── atoms.ts            # compose cursor / nextWantedAgents / gateLoop verdict (reads gate_verdict call)
│   ├── gate-verdict.ts      # registers `gate_verdict({approved,feedback})` terminating tool (§9)
│   ├── worktrees.ts        # pool+task WT create, merge queue, merge-helper (§10)
│   ├── merge.ts            # FF-else-helper; conflict → merge-helper agent
│   ├── state.ts            # state.json read/write; audit.jsonl append; reconstruct
│   ├── render.ts           # board renderResult (§13)
│   ├── run-tasks.ts        # the tool: params/schema, create vs resume, execute loop
│   └── defaults/           # bundled merge-helper.md (seeded on first run)
└── skills/task-pools/SKILL.md
```

---

## 21. Validation against pi docs (audit trail)

Claims re-checked against the installed pi docs/examples during spec review.

**Confirmed true:**
- Subprocess spawn + JSON event stream (`message_end` / `turn_end` / `tool_execution_end`) — `pi-subagents/spawner.ts`, `docs/json.md`.
- `--mode json` + `-p` are complementary (print = non-interactive single-shot; json = output format); prompt via stdin — proven by the installed spawner.
- Profile frontmatter → CLI args (`--provider/--model/--system-prompt/--append-system-prompt/--thinking/--tools/--skill/--extension`) — `profiles.ts` + README.
- `--session-dir`, `--session <path|id>`, `--no-session` exist; `pi --session` resumes — README + `sessions.md`.
- Session storage nests by cwd: `<dir>/--<cwd>--/<ts>_<uuid>.jsonl` — `session-format.md`.
- Blocking tool streams via `onUpdate`; `renderResult(result, options, theme)`; Ctrl+O = `app.tools.expand` toggles `options.expanded` — `delegate.ts`, `keybindings.md`.
- `pi.exec("git", …, {cwd})` — `extensions.md`; worktree primitives — `pi-worktrees/git.ts`.
- `git worktree add` to a path **inside** the working tree (`.pi/task-pools/…/worktrees/`) succeeds; produces `git status` noise unless `.pi/task-pools/` is in `.git/info/exclude` (verified by experiment — §10.5).
- Terminating structured-output tool via `terminate:true` — `examples/extensions/structured-output.ts`.
- `pi.appendEntry` + reconstruct on `session_start`; resources deferred to `session_start`; `session_shutdown` cleanup — `extensions.md`.

**Corrected (were wrong/loose in the spec):**
- ❌ "register custom theme tokens" → themes are a **fixed 51-token** JSON; no extension-registered tokens. Use existing tokens / raw ANSI (§13).
- ❌ "pi's structured-output / outputSchema mechanism" for a spawned agent → **no CLI `--output-schema`**; use a terminating `gate_verdict` tool or JSON-parse (§9).
- ✏ Session files are NOT written flat/named by pi → pi nests by cwd + names `<ts>_<uuid>`; we **move+rename** post-run and resume by path (§11, §12).

**Needs a smoke test before relying on it:**
- That `-p` / `--mode json` **persists** the session file to `--session-dir` when `--no-session` is omitted (auto-save is default in interactive mode; verify it holds in print/json mode).
- That `--session <flat-path>` **appends** to a renamed file on resume, and compaction/auto-save don't relocate it.
- That `renderResult` with many rows has **no built-in height cap** clipping the 20-row collapsed board.
- That a spawned agent (loading pi-task-pools via settings) can actually **see and call** `gate_verdict` (extension tools available to `pi -p` children).
