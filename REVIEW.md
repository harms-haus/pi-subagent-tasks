# `pi-task-pools` — Implementation Review vs. `TASK-POOLS-EXTENSION-PROMPT.md`

Review date: 2026-07-10
Reviewer method: full read of `src/` (all modules), the test suite, the skill,
and cross-checks against the installed `@earendil-works/pi-coding-agent` platform
types/docs. `npm run typecheck`, `npm run lint`, and `npm test` **all pass**
(24 files, 691 passed / 4 todo). The passing suite is itself part of the
problem: several critical integration paths are untested with realistic
plumbing, and a few tests assert behaviour against a _hallucinated_ platform
contract, so green tests coexist with production-broken features.

Severity scale used below:

- **CRITICAL** — a headline feature is non-functional in any real run; or a
  production hang.
- **HIGH** — core spec behaviour is wrong/missing, or the code+tests+docs
  conspire to hide a spec deviation.
- **MEDIUM** — meaningful gap, dead code, or robustness issue; degrades
  observability/correctness but isn't fatal.
- **LOW** — cosmetic, minor redundancy, or documentation nit.

---

## 0. Summary table

| ID  | Sev      | Area               | One-line                                                                                          |
| --- | -------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| C1  | CRITICAL | gateLoop / spawner | `gate_verdict` parsed from wrong JSON shape → **every gateLoop always rejected → task fails**.    |
| C2  | CRITICAL | sessions / wiring  | Task agents spawned with `sessionDir: ""` → no session persistence, no resume, broken summary.    |
| C3  | CRITICAL | concurrency (D7)   | `provider`/`model` limits **never enforced** in the real compose path (demands carry no p/m).     |
| C4  | CRITICAL | merge queue        | Second task queued mid-merge is **stranded → scheduler hangs** (two divergent queues).            |
| H1  | HIGH     | worktrees (D10)    | All task worktrees created eagerly at pool start → dependents **don't see parents' merged code**. |
| H2  | HIGH     | retry (D6)         | Soft-retry allows **6** executions; spec says **5**. Code/docs/tests aligned against the spec.    |
| H3  | HIGH     | audit (§15)        | Most of the §15 taxonomy is never emitted (agent_\*, task_\*, worktree_created, limit_blocked…).  |
| H4  | HIGH     | agent-runner       | `success` requires non-empty `lastAssistantText` → misclassifies valid runs as failures.          |
| H5  | HIGH     | testing            | The §21 smoke tests that validate fragile platform assumptions are `describe.skip` / `it.todo`.   |
| M1  | MEDIUM   | sessions           | `recordSessionPath` is dead; `task.sessionFiles` never populated → summary always shows `-`.      |
| M2  | MEDIUM   | agent-runner       | Binary resolution (`node <argv[1]>` vs `pi`) is fragile and unverified.                           |
| M3  | MEDIUM   | merge              | merge-helper runs even when pool is full → can exceed `total` cap (deviates from §17.6/D7).       |
| M4  | MEDIUM   | worktree audit     | `worktree_created`/`worktree_deleted` not emitted for pool/task creation or L2 restart.           |
| M5  | MEDIUM   | atoms.ts           | File ends with a dangling JSDoc (documents a function that lives in cursor.ts).                   |
| M6  | MEDIUM   | dead code          | `kebabCase`, `truncate`, `fallbackWorktreeDir`, `topoSort`, ~20 AuditLogger methods unused.       |
| M7  | MEDIUM   | render             | 1s `onUpdate` rebuilds the full final summary every tick though only `details.board` is used.     |
| M8  | MEDIUM   | resume             | Resume only detects _missing_ worktrees, not stale-base ones (compounds H1).                      |
| L1  | LOW      | run-tasks          | `specToTaskRuntime` sets `blocked` then `recomputeInitialStatuses` overwrites.                    |
| L2  | LOW      | render             | Board `[done/total]` counts the gateLoop `review` atom as a work leaf.                            |
| L3  | LOW      | spawner            | `Boolean(result.approved)` coercion (moot after C1 fix).                                          |
| L4  | LOW      | utils              | `assertNever` message says "compose kind" but is used generically.                                |
| L5  | LOW      | profiles           | `excludeTools` parsed/restricted but never emitted to CLI; plumbing incomplete.                   |

---

## 1. CRITICAL findings

### C1 — `gate_verdict` is parsed from the wrong JSON event shape → every gateLoop fails

**Where:** `src/spawner.ts` `extractVerdict()`:

```ts
const result = (event.result ?? event.args ?? {}) as Record<string, unknown>;
return {
  approved: Boolean(result.approved),
  feedback: typeof result.feedback === "string" ? result.feedback : "",
};
```

**The bug.** For a `tool_execution_end` event the real pi JSON stream emits the
full `AgentToolResult`, i.e. the verdict is nested under `result.details`, not
sitting on `result` itself. Verified two ways against the installed platform:

- `@earendil-works/pi-agent-core` `AgentEvent` type:
  `{ type: "tool_execution_end"; toolCallId; toolName; result: any; isError }`,
  and `AgentToolResult<T> = { content: …; details: T; terminate? }`.
- `docs/rpc.md` (tool_execution_end example):
  ```json
  { "type":"tool_execution_end", "toolName":"bash",
    "result": { "content":[…], "details": {…} }, "isError": false }
  ```

So for `gate_verdict`, `event.result` is `{ content, details: {approved, feedback} }`.
The code reads `result.approved` (undefined → `false`) and `result.feedback`
(undefined → `""`). Every verdict is therefore parsed as
`{ approved: false, feedback: "" }`.

**Impact.** `AgentRunResult.verdict` is always a _present_ (but wrong) object,
so `extractVerdict` (gateloop.ts) takes the fast path and `needsReminderRetry`
is `false`. Every review is treated as a rejection → the gateLoop increments
iterations until `maxIterations` is exhausted → the task is marked `failed`
(scheduler.ts `handleGateLoop` exhausted branch). **Every gateLoop task fails
in production, regardless of what the reviewer actually decided.** This
collapses the entire TDD / review-loop / plan-until-approved value proposition
(§5.4 worked examples).

**Why tests don't catch it.** `src/__tests__/spawner.test.ts:165` feeds:

```json
{
  "type": "tool_execution_end",
  "toolName": "gate_verdict",
  "result": { "approved": true, "feedback": "Looks good" }
}
```

i.e. a **hallucinated** shape (`approved` directly on `result`). The test passes
because implementation and test share the same wrong assumption. This is exactly
the assumption that §21 smoke test **S4** ("a spawned `pi -p` child can see +
call `gate_verdict`") was meant to validate — but S4 is `describe.skip`/`it.todo`
(see H5).

**Fix.**

```ts
function extractVerdict(event): GateVerdict | undefined {
  if (event.toolName !== "gate_verdict") return undefined;
  const result = event.result as Record<string, unknown> | undefined;
  const details = (result && typeof result === "object" ? result.details : undefined) as
    Record<string, unknown> | undefined;
  const src = details ?? result ?? {}; // tolerate either shape defensively
  if (typeof src.approved !== "boolean") return undefined;
  return { approved: src.approved, feedback: typeof src.feedback === "string" ? src.feedback : "" };
}
```

Then update the spawner tests to use the _real_ `{result:{content,details:{approved,feedback}}}`
shape, and actually run smoke test S4 against a real `pi` binary.

---

### C2 — Task agents are spawned with `sessionDir: ""`; sessions never persist

**Where:** `src/scheduler.ts:253` (inside `tryAdvance`):

```ts
opts.agentRunner.runAgent(demand, {
  sessionDir: "", // <-- always empty
  poolId: opts.pool.id,
  signal: opts.signal,
});
```

`SchedulerOptions` / `ComposeSchedulerOptions` (scheduler.ts) have **no**
`sessionDir` field at all, so the real sessions directory — which `run-tasks.ts`
_does_ compute and pass to the **merge** worker (`sessionDir: join(poolDirPath, "sessions")`,
run-tasks.ts:535) — has no path to ordinary task agents.

**Impact (all D11/§11-derived):**

- `agent-runner.ts` calls `buildSpawnSessionArgs("", …)` → emits `--session-dir ""`
  (broken/relative-to-cwd), and `findSessionFile("")` → `readdirSync("")` throws
  → returns `undefined` → **no session file is ever found or renamed**.
- `AgentRunResult.sessionFile` is therefore always `undefined` for task agents,
  so the cursor's `node.sessionFile` is never set. That breaks:
  - **soft-retry resume** (retry.ts sets `node.sessionFile = result.sessionFile`
    on L1, then `nextWantedAgents` resumes from it — undefined ⇒ always a fresh
    run instead of a resume);
  - **gateLoop work-loop resume** (atoms.ts `resumeSessionFile` fallback to
    `gateLoopNode.workSessionFile`, which is also never populated);
  - the final summary's per-task session listing
    (`renderSummary`: `t.sessionFiles[0] ?? "-"` ⇒ always `-`);
  - audit `agent_start.sessionId` (§15) which cannot be filled.
- `state.json` tasks never carry real `sessionFiles`, so the documented
  "inspect a session with `read …/sessions/…-<name>.jsonl`" workflow (§12, skill)
  has nothing to point at.

**Why tests don't catch it.** Every scheduler/agent test uses `createMockAgentRunner`
(mock-runner.ts) or an inline mock — never `createRealAgentRunner`. The real
runner is only constructed in `index.ts` via `getAgentRunner`, which no test
exercises end-to-end.

**Fix.** Thread the pool sessions dir through:
`SchedulerOptions`/`ComposeSchedulerOptions` get a `sessionDir: string`;
`createComposeScheduler` forwards it; `scheduler.ts tryAdvance` uses
`opts.sessionDir` instead of `""`. Then add an integration test that asserts
the spawned args contain `--session-dir <pool>/sessions` and that a produced
session file is recorded.

---

### C3 — `provider` / `model` concurrency limits are never enforced (D7)

**Where:** `src/atoms.ts` `demandsFor()` constructs `AgentDemand` with:

```ts
// provider and model intentionally left undefined — resolved by the
// profile loading / AgentRunner seam.
```

and `scheduler.ts tryAdvance` consumes them as-is:

```ts
if (!opts.pools.tryAcquire(demand.provider, demand.model)) continue;
```

`demand.provider` / `demand.model` are **never set** anywhere in the real compose
path. The real `agent-runner.ts` resolves the profile (`resolveProfile` →
`profileToArgs`) and therefore knows the provider/model, but it runs **after**
slot acquisition and never reports them back to the `PoolCoordinator`.

**Impact.** `tryAcquire(undefined, undefined)` consults only the `total` pool
(`pools.ts applicable() returns `[total]` when provider/model are undefined).
So in production:

- `limits.provider` and `limits.model` are **completely inert**.
- A pool with `{ total: 10, provider: { anthropic: 1 } }` will happily run 10
  anthropic agents at once.

This defeats the headline "three AND-gated pools" feature (§5.3, D7). It also
means `release()` is asymmetric (releases `total` only), so even the `usage()`
footer in the board is wrong for provider/model.

**Why tests don't catch it.** The `PoolCoordinator` itself is correct and well
unit-tested (`pools.test.ts` covers provider/model AND-gating). And
`scheduler-core.test.ts:517` exercises provider gating through the **low-level
`createScheduler` seam with a hand-written `getDemands` that manually sets
`provider: "anthropic"`/`"openai"`** on the demands. That proves the accounting
works _if demands carry provider/model_ — and masks the fact that the real
`createComposeScheduler` → `nextWantedAgents` path never populates them.

**Fix.** Resolve provider/model _before_ pool accounting and attach them to the
demand, e.g. have `nextWantedAgents` (or the scheduler, just before `tryAcquire`)
call a synchronous profile lookup (`resolveProfile(profileName, cwd)`) to read
`profile.provider`/`profile.model`, set them on the `AgentDemand`, and reuse the
same values for `releaseAgent`. (Profile loading is already sync and cached in
profiles.ts.) Then add an integration test that sets a provider cap and asserts
contention actually throttles.

---

### C4 — Serial merge queue strands tasks and hangs when ≥2 queue during a merge

**Where:** the merge path uses **two divergent queues/flags**:

1. The scheduler pushes completed tasks to `pool.mergeQueue`
   (`scheduler.ts onAgentFinished`: `opts.pool.mergeQueue.push(task.id)`).
2. `globalSchedule` step 1 hands **only the first** item to the merge worker,
   gated by the scheduler's own `mergeInProgress`:
   ```ts
   if (!mergeInProgress && opts.pool.mergeQueue.length > 0) {
     const mergingId = opts.pool.mergeQueue[0];
     mergeInProgress = true;
     opts.callbacks.onMergeEnqueue(mergingId);   // run-tasks: mergeWorker.enqueue + processNext
     ...
   }
   ```
3. `run-tasks onMergeEnqueue` pushes into the **merge worker's own internal
   `queue`** (`merge.ts`) and calls `processNext()`.
4. `scheduler.mergeComplete` (called by the worker's `onMerged`) removes the id
   from `pool.mergeQueue` and only clears `mergeInProgress` when
   `pool.mergeQueue.length === 0`.

**The deadlock.** Suppose task A is merging (slow — e.g. a real merge-helper
agent takes seconds) and task B finishes while A is in flight:

- `onAgentFinished(B)` pushes B → `pool.mergeQueue = [A, B]`.
- `globalSchedule` merge step is skipped (`mergeInProgress` true). **B is never
  `enqueue`d into the worker.**
- A completes → `mergeComplete(A)` removes A → `pool.mergeQueue = [B]`. Since
  `length !== 0`, `mergeInProgress` stays `true`. `globalSchedule` skips the
  merge step again.
- The worker's internal queue is empty (B was never enqueued), so its recursive
  `setTimeout(processNext)` does nothing. The scheduler's `mergeInProgress` can
  only clear when `pool.mergeQueue` empties — chicken-and-egg.

**B is stranded forever.** `isFixedPoint()` returns false (mergeQueue non-empty)
and the `run-tasks` wait loop also requires `pool.mergeQueue.length === 0`
(run-tasks.ts), so **the tool call never resolves**. With even modest
parallelism (e.g. two leaf tasks under `total: 4`) this is the normal case, not
an edge case.

**Why tests don't catch it.** All merge tests (`merge.test.ts`) drive the worker
in isolation (`enqueue`/`processNext` directly), never the scheduler→worker
handoff. The integration test `int-4` (5 tasks, `total: 2`) doesn't strand only
because the mocked merges resolve entirely within one microtask drain, _before_
the next agent's `setTimeout(0)` macrotask fires — so `pool.mergeQueue` never
holds two items at once. A real (slow) merge reproduces the hang immediately.

**Fix.** Collapse to a single source of truth. Cleanest: have the merge worker
drain `pool.mergeQueue` directly (no separate internal queue, no separate
`onMergeEnqueue` handoff), and clear the scheduler's `mergeInProgress` **per
item** (set when an item starts, clear when that item's `mergeComplete` fires),
not "when the queue is empty". Then add an integration test with a deliberately
slow merge (deferred runner) that completes two tasks back-to-back and asserts
both reach `done`.

---

## 2. HIGH findings

### H1 — Eager worktree creation breaks D10 ("dependents see parents' merged code")

**Where:** `src/run-tasks.ts` CREATE path, lines ~468–477:

```ts
// Create task worktrees for ALL tasks (so scheduler can start them).
// NOTE (D10): this eagerly creates all task worktrees at pool creation
// time rather than lazily from post-merge pool HEAD.  Lazy-branching
// (§10.3) is a known spec deviation acceptable for v1 ...
const poolHead = await git.revParseHead(pool.poolWorktree);
for (const task of pool.tasks) {
  const wt = await createTaskWorktree(git, cwd, pool.id, poolId, task.id, poolHead);
  task.worktreePath = wt.path;
  task.branch = wt.branch;
}
```

**The bug.** D10 / §10.1 require each task worktree to branch from the pool
branch's **current HEAD at task-start time** — explicitly so that "a dependent
task branches **after** its parents merged → **sees their code**." Branching
every task from the _initial_ pool HEAD at creation means dependent tasks never
see their parents' merged output in their worktree. That guts the dependency
model for the common case where a downstream task reads/builds on prior tasks'
files (the `plan → tests → code` example in the integration test would, in
reality, give `tests` an empty worktree with no `plan` artefacts).

It also means §10.1's "on **first start** … create its worktree" lifecycle (and
the `worktree_created(<taskId>)` audit) is not implemented, and the
`nextWantedAgents` guard `if (!task.worktreePath) return []` is effectively dead
(worktree always set). The code comment frames this as an acceptable v1
deviation, but it invalidates a core guarantee, not a minor one.

**Fix.** Create each task worktree lazily on first run: leave `worktreePath`/
`branch` null at creation; when the scheduler is about to start a task's first
agent (transition toward `running`), `createTaskWorktree(… poolHead =
revParseHead(pool.poolWorktree))`. `nextWantedAgents`' existing null-check then
becomes meaningful (and must be relaxed to "allow start → create worktree → then
demand"). Audit `worktree_created` at that point (also fixes M4).

---

### H2 — Soft-retry allows 6 executions; spec mandates 5

**Where:** `src/constants.ts`:

```ts
export const SOFT_RETRY_CAP = 5;
```

and `src/retry.ts handleAgentError`:

```ts
if (executionCount < SOFT_RETRY_CAP) {   // 0..4 → allows 5 soft-retries
  node.executionCount = executionCount + 1;
  ...
  return "soft-retry";
}
```

`executionCount` starts at 0 and increments only on an error, so the sequence is
attempt1→ec1, attempt2→ec2, … attempt5→ec5 (all soft-retry), attempt6→`5 < 5`
false ⇒ escalate. **That is 6 total executions.**

The spec is explicit and numeric (§8, D6): _"retry that same agent by resuming
its session … up to **5 total executions** (1 attempt + 4 retries)."_

**How it got hidden.** The `SOFT_RETRY_CAP` comment and the **SKILL.md** were
both rewritten to describe the implementation ("up to **6** total executions (1
initial attempt + up to 5 soft-retries)"), and `retry.test.ts`
("executionCount increments on each retry up to SOFT_RETRY_CAP", loops `i ≤
SOFT_RETRY_CAP`) plus integration `int-2` bake in the 6-count. So code, tests,
and docs agree with each other but disagree with the spec they claim to
implement.

**Fix (choose one and reconcile docs):**

- Honour the spec literally: treat the cap as _total_ executions. Easiest is
  `SOFT_RETRY_CAP` = number of _retries_ = 4 and keep `<`, yielding 5 total; or
  keep the constant as "total" and compare `executionCount + 1 < SOFT_RETRY_CAP`.
- Or update **the spec** to 6 and stop calling it "1 attempt + 4 retries".
  Either way, the constant naming (`SOFT_RETRY_CAP` ambiguous: retries? total?)
  should be made explicit, and the SKILL.md numbers must match.

---

### H3 — Audit coverage is a small fraction of the §15 taxonomy

§15 says "Emit at least:" and lists ~25 event types. Inventory of what the
non-test code actually emits through the live `onAudit`/`audit.log`/typed-method
paths:

Emitted: `pool_created`, `pool_resumed`, `pool_completed`, `agent_retry`,
`task_retry`, `task_failed`, `gateloop_approved`, `gateloop_rejected`,
`gateloop_exhausted`, `merge_conflict`, `merge_resolved`, `merge_failed`,
`merge_skipped`, `merge_error`, `merge_callback_error`, `worktree_merged`,
`worktree_deleted`, `task_ready` (resume only).

**Not emitted anywhere:**

- `agent_start`, `agent_complete`, `agent_error`, `agent_resume` — the scheduler
  starts/finishes agents silently (scheduler.ts has no audit calls at all).
- `task_running`, `task_parked`, `task_done`, `task_skipped` — status changes in
  `globalSchedule`/`onMerged`/`propagateFailures` aren't audited.
- `worktree_created` — pool + task creation in run-tasks CREATE and
  `onTaskRestart` are silent (only merge-cleanup emits `worktree_deleted`).
- `merge_started`, `limit_blocked` — never emitted (`limit_blocked` in
  particular would be the only signal explaining _why_ an agent didn't start).

Additionally, `worktree_merged` is **double-emitted** — `merge.ts handleFfSuccess`
audits it, and `run-tasks onMerged` calls `audit.worktreeMerged` again.

The skill tells users to `read .pi/task-pools/<id>/audit.jsonl` to inspect a
pool, so these gaps materially hurt debuggability. `agent_start`'s `sessionId`
payload also can't be filled until C2 is fixed.

**Fix.** Thread an `onAudit` (or direct `audit`) callback into the scheduler and
emit the lifecycle events at each transition; have the merge worker emit
`merge_started`; emit `limit_blocked` when `tryAcquire` fails in `tryAdvance`;
emit `worktree_created`/`worktree_deleted` in run-tasks creation + restart; drop
the duplicate `worktree_merged`. (Most of the typed `AuditLogger` methods that
currently exist precisely for these events are dead — see M6 — so this is also
"wiring up code that's already written.")

---

### H4 — `success` requires non-empty `lastAssistantText`

**Where:** `src/agent-runner.ts`:

```ts
return {
  success: result.exitCode === 0 && result.lastAssistantText.length > 0,
  ...
};
```

**Impact.** A perfectly normal agent run that exits 0 but emits no _trailing
assistant text_ is classified as a failure → triggers L1 soft-retry, and after
exhaustion, L2/L3. The most likely victim is the **gateLoop reviewer**: it is
instructed to call `gate_verdict` as its final action (`terminate:true`), so its
last assistant message may be just the tool call with no text — yielding empty
`lastAssistantText` and a spurious failure (on top of C1). More broadly, any
agent whose final turn is "tool-only" is affected.

**Fix.** Define success as `exitCode === 0 && !loopDetected && exitCode !==
null` (killed/aborted → not success). Do not gate on text length; if a non-empty
result is truly required for a particular atom, enforce that at the
cursor/compose layer, not in the generic runner.

---

### H5 — The §21 smoke tests are `describe.skip` / `it.todo` (the safety net is off)

**Where:** `src/__tests__/integration.test.ts:671`:

```ts
describe.skip("smoke test stubs (manual)", () => {
  it.todo("S1: `pi --mode json -p --session-dir <tmp>` writes a session file …");
  it.todo("S2: `--session <flat-abs-path>` resumes …");
  it.todo("S3: renderResult with 100 rows has no built-in height-cap …");
  it.todo("S4: a spawned `pi -p` child can see + call gate_verdict …");
});
```

§21 explicitly flags these as "needs a smoke test before relying on it." They
are the _only_ checks that would catch C1 (gate_verdict visibility + event
shape), C2 (session persistence in `-p`/json without `--no-session`), M2 (binary
resolution), and the 20-row board rendering. None of them run.

**Fix.** Implement them as an opt-in suite that boots a real `pi` binary (guard
on `PI_BIN` env or `which pi`) and run them in CI when a binary is available.
S4 in particular must spawn a child, have it call `gate_verdict`, and assert the
verdict is captured — which would have failed immediately and surfaced C1.

---

## 3. MEDIUM findings

### M1 — `recordSessionPath` is dead; `task.sessionFiles` never populated

`sessions.ts` exports `recordSessionPath` but nothing calls it (0 non-test
usages). Even setting C2 aside, the session file returned by the runner is
stored only on the cursor node (`node.sessionFile`) and never appended to
`task.sessionFiles`, so `state.json` and `renderSummary`'s `(session: …)` line
are always `-`. **Fix:** call `recordSessionPath` (or an equivalent) when a
session file is produced for a task.

### M2 — `createRealAgentRunner` binary resolution is fragile / unverified

`agent-runner.ts`:

```ts
const scriptPath =
  typeof argv1 === "string" && argv1 && !argv1.startsWith("/$bunfs/") ? argv1 : null;
const command = scriptPath ? process.execPath : "pi";
const commandArgs = scriptPath ? [scriptPath, ...args] : args;
```

Under the real pi host, `process.argv[1]` is pi's own entry — which may or may
not be a directly `node`-loadable script (native bin, bun, wrapper, etc.). The
whole real-runner path is mocked in every test and unverified by S1–S4, so a
misresolved binary would fail silently at first real use. **Fix:** resolve the
pi binary deterministically (explicit config / `which pi` / re-use the host's
loader) and cover it with a smoke test.

### M3 — merge-helper can exceed the `total` cap

`merge.ts handleMergeConflict`:

```ts
const acquired = opts.pools.tryAcquire(undefined, undefined);
...
await opts.agentRunner.runAgent(demand, runOpts);   // runs even if !acquired
```

§17.6 / D7 state the merge-helper "consumes limit slots like any agent." The
code runs it regardless of capacity (best-effort), so the pool can momentarily
exceed `total`. It also acquires with `(undefined, undefined)`, so it never
touches provider/model pools (consistent with C3, but still a deviation).
**Fix:** gate the helper through the normal acquire-or-wait flow, or document
this as a deliberate, spec-amended deviation.

### M4 — `worktree_created` / `worktree_deleted` not emitted for creation or L2 restart

run-tasks creates the pool worktree and all task worktrees (CREATE path) and
recreates a worktree in `onTaskRestart` (L2), none of which audit
`worktree_created`/`worktree_deleted`. §8 explicitly requires auditing
`worktree_deleted`/`worktree_created` on L2 restart; §15 lists both as required.
(Overlaps H3; called out separately because it's a concrete lifecycle gap.)
**Fix:** emit on every create/remove site.

### M5 — Dangling JSDoc at the end of `atoms.ts`

`src/atoms.ts` ends (after `gateLoopParentPath`) with a JSDoc block titled
"Recursively reset mutable runtime fields…" that documents **no function** — the
function it describes (`resetCursorToPending`) lives in `cursor.ts`. Misleading;
remove or move it.

### M6 — Dead / unused exports

- `kebabCase` (utils.ts) — 0 usages (alias of `slugify`).
- `truncate` (utils.ts) — 0 usages.
- `fallbackWorktreeDir` (worktrees.ts) — 0 usages (the §10.5 fallback path is
  not wired up).
- `topoSort` (dag.ts) — exported, computed nowhere in run-tasks (only
  `resolveDeps`/`detectCycles`/`computeDownstreamCount` are used).
- ~20 `AuditLogger` typed convenience methods are never called (events go
  through generic `log()`); see H3.
- `recordSessionPath` — see M1.

These inflate the public surface and imply features that don't exist (e.g. a
fallback worktree dir). **Fix:** delete unused, or wire them up (fallback dir,
audit methods).

### M7 — `onUpdate` rebuilds the full summary every second for nothing

run-tasks' 1s interval calls `renderSummary(pool)` to build `content`, but
`renderResult` ignores `content` while `isPartial` and renders only from
`details.board`. So the entire summary string is rebuilt and shipped every tick
only to be discarded. **Fix:** send a lightweight placeholder `content` (e.g.
`"running…"`) on partial updates.

### M8 — Resume only detects _missing_ worktrees, not stale-base ones

`worktrees.ts verifyWorktrees` returns ids whose path is absent from
`git worktree list`. On resume it then recreates them from the current pool HEAD
— but existing (present) task worktrees that were branched from an old HEAD
(see H1) are neither detected nor rebased. Compounds H1: a resumed dependent
task still won't see parents' code. **Fix:** on resume, either rebase/refresh
existing task worktrees to current pool HEAD, or recreate them too (matches the
"dependents branch after parents merge" intent).

---

## 4. LOW findings

- **L1** `specToTaskRuntime` sets `status: "blocked"` and then
  `recomputeInitialStatuses` immediately overwrites it. Harmless redundant churn;
  initialize to a placeholder or let `recomputeInitialStatuses` own it.
- **L2** Board `[done/total]` (`countAgentLeaves`) counts a gateLoop's `review`
  atom as a work leaf, so a gateLoop task reads e.g. `[1/2]` mid-flight. Cosmetic
  but slightly misleading.
- **L3** `extractVerdict` uses `Boolean(result.approved)` (coerces truthy
  non-booleans). Moot after the C1 fix; validate `typeof === "boolean"`.
- **L4** `assertNever`'s message ("Unexpected compose kind") is reused at the
  cursor/state boundary for non-compose `never`s — genericise the message.
- **L5** `profiles.ts` parses `excludeTools` and lists `--exclude-tools` in
  `TOOL_FLAGS`/restrictions, but `profileToArgs` never emits it
  (`// excludeTools: not yet a standard pi-agent flag; omitted for now.`). A
  profile that sets `excludeTools` is silently dropped. Either emit it or remove
  the parse + the restriction entry and document as unsupported.

---

## 5. What is done well (for balance)

- **Pure core is solid and well-tested:** `dag.ts` (id/title resolution, cycle
  detection, stable topo sort, transitive downstream count), `status.ts`
  (transition table, transitive failure-propagation BFS, fixed-point), `pools.ts`
  `PoolCoordinator` (correct all-or-nothing AND-gate, deadlock-free reasoning),
  `cursor.ts` (build/serialize/deserialize round-trip, structural deep copy).
- **State layer:** atomic `state.json` write (temp + rename), append-only
  `audit.jsonl` with a persistent fd, defensive `readState`. Good §12 fidelity.
- **Parking invariant:** the `ready`↛`parked` rule and "only running→parked" are
  implemented faithfully (scheduler.ts onAgentFinished + status.ts transitions).
- **gateLoop state machine** (gateloop.ts) and the **one-time reviewer-reminder
  retry** (scheduler.ts compose wrapper) are thoughtfully designed and would be
  correct _if_ C1 were fixed.
- **Abort/hard-kill** plumbing (SIGTERM→SIGKILL→force-resolve, child-process
  tracking, session_shutdown sweep, signal listener cleanup) is thorough.
- **Decomposition** closely follows the suggested §20 file layout, and modules
  are cleanly separated with injectable seams (AgentRunner, GitOps, callbacks).

The tragedy is that a strong pure core is wired to production through three
broken adapters (spawner verdict shape, scheduler sessionDir, provider/model
propagation) and a deadlock-prone merge handoff — none of which the current test
suite can see because it stops at the seams.

---

## 6. Recommended fix order

1. **C1** (gate_verdict shape) + run smoke **S4** — unblocks the entire gateLoop
   feature and validates the spawner's platform contract.
2. **C2** (sessionDir threading) + **M1** — restore sessions, resume, and the
   summary's session listing.
3. **C3** (provider/model on demands) — make the limits feature real; add an
   integration test with a provider cap.
4. **C4** (single merge queue) — eliminate the hang; add a slow-merge
   concurrency test.
5. **H1** (lazy worktrees) — restore the dependency-sees-parent guarantee.
6. **H4**, **H3/M4**, **H2**, then the M/L cleanups.
7. Turn the §21 smoke suite (**H5**) into a real, opt-in CI job so C1/C2/M2
   can't recur silently.
