---
name: subagent-tasks
description: >-
  Run autonomous pools of dependent tasks with compose pipelines, concurrency
  limits, retries, and optional isolated Git worktrees. Use for unattended
  multi-task work; not one agent call or interactive control.
---

# `run_tasks`

`run_tasks` blocks while it schedules a task pool. `get_task_history` returns a
task's agent responses. Press Ctrl+O to expand the live board.

Use this for coordinated, unattended work: dependency chains, parallel
research, review/fix cycles, or repeated generation. For one independent agent,
use `delegate_to_subagents`. A running pool has no interactive controls; abort
kills children and persisted state can be resumed.

## Profiles

Before creating a pool, call `list_task_profiles`. Do not use
`list_subagent_profiles`; that belongs to a different extension. The tool reads:

- project: `./.pi/agent/profiles/` (highest priority)
- global: `~/.pi/agent/profiles/`

These are not `agent-profiles/` directories. Project profiles override
same-named global profiles. Missing profiles fail when their agent starts.

Each `.md` file needs YAML frontmatter with `name`; other supported fields are
optional. The Markdown body is the system prompt. Common fields:

```markdown
---
name: code-reviewer
provider: anthropic
model: anthropic/claude-sonnet-4-5
thinkingLevel: medium
---

Review the work. End by calling gate_verdict({approved, feedback}).
```

Also supported: `appendSystemPrompt`, `noTools`, `tools`, `excludeTools`,
`noExtensions`, `extensions`, `noSkills`, `suggestedSkills`, `loadSkills`,
`noContextFiles`, `extraArgs`, and global-only `apiKey`. Tool/extension/skill
lists are comma-separated strings. Profile lookup uses frontmatter `name`, not
the filename.

`merge-helper` is seeded globally without provider/model and never overwritten.
Configure it before a merge conflict occurs. Every other profile is user-made.

An agent atom uses its `profile`, else the task profile. A task profile may be
omitted only if every agent leaf supplies one.

## Create or resume

```jsonc
{
  "name": "release-feature", // slugged pool id and branch suffix
  "worktree": true, // default
  "tasks": [
    {
      "id": "code", // optional; default t-<N>
      "title": "Implement", // optional
      "prompt": "Implement the feature.", // required, non-empty
      "profile": "coder",
      "dependsOn": ["plan"], // ids or titles
      "compose": { "type": "agent" }, // optional default
    },
  ],
  "limits": {
    "total": 4,
    "provider": { "anthropic": 3 },
    "model": { "anthropic/claude-sonnet-4-5": 2 },
  },
  "maxRetries": 2,
}
```

`name` becomes id `<slug>` and branch
`pi-subagent-task/<slug>`. Dependencies are resolved and checked for cycles at
creation. Existing ids require resume:

```json
{ "resume": "release-feature" }
```

`worktree:true` requires Git. Each ready task gets a worktree lazily from the
current pool HEAD; completed tasks merge serially into the pool branch. Thus a
dependent sees merged parent work. `worktree:false` needs no Git, creates and
merges nothing, and runs all agents in the caller cwd. Use it for read-only work
or disjoint writes; concurrent writes can race.

Limits are AND-gated: an agent starts only if every configured total, provider,
and exact provider/model pool has room. Unset provider/model caps are unlimited;
`total` defaults to 4. Merge helpers also consume capacity. Valid caps are
positive integers; `total <= 32`. `maxRetries` is an integer 0–10 (default 2).

## Compose

A task has one prompt and one compose tree. **Every agent receives the same task
prompt verbatim.** Atoms have no prompt; use profiles for role instructions or
separate dependent tasks when different prompts are required.

```jsonc
{ "type": "agent", "profile": "coder", "title": "code" }
```

Runs one agent.

```jsonc
{ "type": "sequential", "atoms": [A, B] }
```

Runs children in order in one task worktree. A's last assistant message becomes
context for B.

```jsonc
{ "type": "parallel", "atoms": [A, B] }
```

Runs children concurrently, subject to limits, in one task worktree. Each gets
the same incoming context. Headed child responses are concatenated for the next
atom. Use read-only agents or disjoint files; same-file writes race.

```jsonc
{
  "type": "gateLoop",
  "work": { "type": "agent", "profile": "coder" },
  "review": { "type": "agent", "profile": "reviewer" },
  "maxIterations": 3,
}
```

Runs work then review. The reviewer must end with
`gate_verdict({approved, feedback})`. Approval returns the work response;
rejection resumes the work session with feedback. Default `maxIterations` is 3;
exhaustion is an agent failure and enters normal retry handling.

```jsonc
{ "type": "loop", "atom": A, "count": 3 }
```

Runs 1–100 fresh sessions sequentially. Each sees prior file changes and gets
the prior response as context.

Containers may nest. Example: tests, then implementation, each reviewed:

```jsonc
{
  "type": "sequential",
  "atoms": [
    {
      "type": "gateLoop",
      "work": { "type": "agent", "profile": "test-writer" },
      "review": { "type": "agent", "profile": "reviewer" },
    },
    {
      "type": "gateLoop",
      "work": { "type": "agent", "profile": "coder" },
      "review": { "type": "agent", "profile": "reviewer" },
    },
  ],
}
```

Result flow is always:

```text
<prior result>

---

<task prompt>
```

The root has no prior result. A gate review receives the work response; an
approved gate outputs the work response. Loops chain iteration responses.

## Failure and resume

For a failed agent execution:

1. Resume that session up to 4 times (5 executions total).
2. If still failing, restart the whole task fresh up to `maxRetries`: recreate
   its worktree from pool HEAD, reset compose state, and use new sessions.
3. Mark it failed; dependents are skipped.

Resume changes failed/running/parked tasks to ready. Failed tasks restart their
compose tree. In-flight atoms from an interrupted run start fresh; completed
atoms remain. Missing worktrees are recreated. Stale worktrees with no completed
atoms are recreated from pool HEAD; ones with completed progress are preserved
and audited as stale. A task whose atoms finished before an interrupted merge is
reconciled and merged on resume.

Board states: `blocked`, `ready`, `running`, `parked`, `failed`, `done`.
`parked` means a previously running task has no active agent and its next agent
cannot acquire capacity. Parked tasks outrank ready tasks. Skipped dependents are
displayed as failed/skipped.

## Inspect and finish

State is under `.pi/subagent-tasks/<id>/`:

```text
state.json       canonical state
audit.jsonl      append-only events
sessions/        pi JSONL sessions
worktrees/pool/  pool branch worktree (worktree mode)
worktrees/<taskId>/
artifacts/
```

Use:

```json
{ "poolId": "release-feature", "taskId": "code" }
```

with `get_task_history` for all final agent responses, including retries and
gate iterations. Add `"fullSessionData": true` only when full JSONL transcripts
are needed.

`run_tasks` does not merge the pool branch into the original branch. After a
successful pool, finalize explicitly:

```bash
git merge --ff-only pi-subagent-task/release-feature
# or
gh pr create --head pi-subagent-task/release-feature
```
