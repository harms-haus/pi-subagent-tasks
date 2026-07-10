/**
 * Status state machine and failure propagation for pi-task-pools.
 *
 * Pure functions that operate on the task-status domain model (§5.2). Every
 * function is synchronous and side-effect-free (no IO, no mutation beyond the
 * stated in-place updates on TaskRuntime arrays).
 *
 * Allowed transitions (§5.2, documented in {@link canTransition}):
 *   blocked → ready  (all deps done)
 *   blocked → failed  (dependency failed — propagation)
 *   ready   → running (capacity opens up)
 *   running → running (self-loop, multiple agents executing)
 *   running → parked  (zero agents running + none can start)
 *   parked  → running (capacity opens up again)
 *   parked  → ready   (reset, e.g. after dependency re-evaluation)
 *   running → done    (all compose atoms complete + merged)
 *   running → failed  (exhausted retries)
 *   failed  → ready   (on resume)
 *
 * Rejected transitions:
 *   ready  → parked   (ready never auto-parks, §5.2 parking invariant)
 *   done   → *        (terminal — never leaves done)
 *   failed → *        (only failed → ready is allowed)
 *
 * @module
 */

import type { Status, TaskRuntime } from "./types";

// ── Transition table ────────────────────────────────────────────────────────

/**
 * Canonical edge set for the task status state machine (§5.2).
 *
 * Allowed transitions:
 * - `blocked` → `ready` — all dependencies completed
 * - `blocked` → `failed` — dependency failed (skipped via propagation)
 * - `ready` → `running` — capacity opens up
 * - `running` → `running` — self-loop (multiple agents executing)
 * - `running` → `parked` — zero agents running + none can start
 * - `parked` → `running` — capacity opens up again
 * - `parked` → `ready` — reset, e.g. after dependency re-evaluation
 * - `running` → `done` — all compose atoms complete + merged
 * - `running` → `failed` — exhausted retries
 * - `failed` → `ready` — on resume
 *
 * Rejected transitions:
 * - `ready` → `parked` (ready never auto-parks, §5.2 parking invariant)
 * - `done` → * (terminal — never leaves done)
 * - `failed` → * (only failed → ready is allowed)
 */
const TRANSITIONS: ReadonlyMap<Status, ReadonlySet<Status>> = new Map([
  ["blocked", new Set(["ready", "failed"])],
  ["ready", new Set(["running"])],
  ["running", new Set(["running", "parked", "done", "failed"])],
  ["parked", new Set(["running", "ready"])],
  ["failed", new Set(["ready"])],
  ["done", new Set()],
]);

/**
 * Enforce the task-status state machine (§5.2).
 *
 * @returns `true` if the transition is legal per the edge set above.
 */
export function canTransition(from: Status, to: Status): boolean {
  const allowed = TRANSITIONS.get(from);
  return allowed !== undefined && allowed.has(to);
}

// ── Dependency helpers ──────────────────────────────────────────────────────

/**
 * True iff every id in `task.dependsOn` maps to a task whose status is `"done"`.
 *
 * A task with an empty `dependsOn` array trivially returns `true`.
 */
export function depsAllDone(task: TaskRuntime, taskMap: Map<string, TaskRuntime>): boolean {
  for (const depId of task.dependsOn) {
    const dep = taskMap.get(depId);
    if (dep === undefined || dep.status !== "done") {
      return false;
    }
  }
  return true;
}

// ── Initial status assignment ───────────────────────────────────────────────

/**
 * Compute the initial status for each task based on its dependencies (§5.2).
 *
 * Tasks with no `dependsOn` → `"ready"`; tasks with dependencies → `"blocked"`.
 * Mutates `task.status` in place.
 */
export function recomputeInitialStatuses(tasks: TaskRuntime[]): void {
  for (const task of tasks) {
    task.status = task.dependsOn.length === 0 ? "ready" : "blocked";
  }
}

// ── Failure propagation ─────────────────────────────────────────────────────

/**
 * Propagate failure through the dependency graph at the fixed point (D5, §7.1).
 *
 * Any task that is `"blocked"` or `"ready"` and has a dependency that is
 * `"failed"` is itself set to `"failed"` with `lastError = "depends on failed: <depId>"`.
 * The propagation is **transitive** via BFS over the dependency graph:
 * if A fails, B (depending on A) fails, then C (depending on B) fails, etc.
 *
 * Tasks whose status is `"done"` are **never** touched (they are already merged
 * and terminal).
 *
 * @returns The list of newly-failed task ids, in the order they were discovered.
 */
export function propagateFailures(tasks: TaskRuntime[]): string[] {
  // Build a map for quick lookups and a reverse-dependency index.
  const taskMap = new Map<string, TaskRuntime>();
  const reverseDeps = new Map<string, string[]>();

  for (const task of tasks) {
    taskMap.set(task.id, task);
    reverseDeps.set(task.id, []);
  }

  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      const rd = reverseDeps.get(depId);
      if (rd !== undefined) {
        rd.push(task.id);
      }
    }
  }

  // Seed the BFS queue with tasks that are already failed (and not done).
  const queue: string[] = [];
  const newlyFailed = new Set<string>();

  for (const task of tasks) {
    if (task.status === "failed" && !newlyFailed.has(task.id)) {
      queue.push(task.id);
    }
  }

  // BFS: for each failed task, fail any dependent that is blocked or ready.
  while (queue.length > 0) {
    const failedId = queue.shift();
    if (failedId === undefined) continue;
    const dependents = reverseDeps.get(failedId);
    if (dependents === undefined) continue;

    for (const depId of dependents) {
      if (newlyFailed.has(depId)) continue;

      const dep = taskMap.get(depId);
      if (dep === undefined) continue;

      // Skip already-done tasks (terminal, never touched).
      if (dep.status === "done") continue;

      // Only propagate to blocked or ready tasks.
      if (dep.status !== "blocked" && dep.status !== "ready") continue;

      dep.status = "failed";
      dep.lastError = `depends on failed: ${failedId}`;
      newlyFailed.add(depId);
      queue.push(depId);
    }
  }

  return Array.from(newlyFailed);
}

// ── Aggregations ────────────────────────────────────────────────────────────

/**
 * Tally how many tasks are in each status.
 *
 * All six {@link Status} keys are present in the result (value is `0` if no
 * task has that status).
 */
export function countByStatus(tasks: TaskRuntime[]): Record<Status, number> {
  const counts: Record<Status, number> = {
    blocked: 0,
    ready: 0,
    running: 0,
    parked: 0,
    failed: 0,
    done: 0,
  };

  for (const task of tasks) {
    counts[task.status]++;
  }

  return counts;
}

// ── Fixed-point detection ───────────────────────────────────────────────────

/**
 * Check whether the pool has reached a fixed point (D5, §7.1).
 *
 * A fixed point is reached when **no** task is ready, running, or parked
 * (everything is done or failed) **and** the merge queue is empty.
 *
 * @param mergeQueue — The FIFO of task ids awaiting serial merge (§10.2).
 */
export function isFixedPoint(tasks: TaskRuntime[], mergeQueue: string[]): boolean {
  if (mergeQueue.length > 0) return false;

  for (const task of tasks) {
    if (task.status === "ready" || task.status === "running" || task.status === "parked") {
      return false;
    }
  }

  return true;
}
