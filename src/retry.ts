/**
 * Two-level retry + resume reconciliation (§8, D6).
 *
 * Retry model (§8):
 *   Level 1 — per-agent soft-retry: re-run the same atom up to
 *             {@link SOFT_RETRY_CAP} times (each subsequent run is a resume).
 *   Level 2 — whole-task fresh restart: recreate the task worktree and restart
 *             all atoms from scratch, up to {@link opts.maxRetries}.
 *   Level 3 — permanent task failure.
 *
 * Resume reconciliation:
 *   When a pool is restored from disk (e.g. after a crash), any task in
 *   "running" or "parked" state is moved to "ready", in-flight (running)
 *   agent atoms are reset to "pending" with executionCount zeroed, and
 *   missing worktrees are reported for recreation.
 *
 * References:
 *   §8   two-level retry (ALL rules)
 *   D6   retry architecture decision
 *   D12  resume semantics (failed → ready)
 *   §12  state.json persistence
 */

import { SOFT_RETRY_CAP } from "./constants";
import { getCursorByPath } from "./cursor";
import type { AgentRunResult, CursorNode, PoolState, TaskRuntime } from "./types";

// ── Two-level retry ──────────────────────────────────────────────────────────

/**
 * Handle an agent execution error and decide the next action.
 *
 * Returns one of three outcomes:
 *   - `"soft-retry"`   — L1: re-queue this atom for re-execution (resume).
 *   - `"task-restart"` — L2: the whole task's worktree should be recreated and
 *                        all atoms started fresh.
 *   - `"task-fail"`    — L3: permanent task failure after exhausting all
 *                        retry levels.
 *
 * The caller is responsible for acting on the returned verdict (e.g. advancing
 * the scheduler, resetting the worktree, or marking the task failed).
 *
 * @param task     the runtime task record (cursor is mutated in place).
 * @param atomPath the stable path of the failing agent node.
 * @param result   the completed (failed) agent result.
 * @param opts.maxRetries   the whole-task fresh-restart cap (typically
 *                          {@link DEFAULT_MAX_RETRIES} = 2).
 * @param opts.onAudit   optional audit callback for retry events.
 */
export function handleAgentError(
  task: TaskRuntime,
  atomPath: string,
  result: AgentRunResult,
  opts: {
    maxRetries: number;
    onAudit?: (type: string, payload: Record<string, unknown>) => void;
  },
): "soft-retry" | "task-restart" | "task-fail" {
  const node = getCursorByPath(task.cursor, atomPath);
  if (node === undefined) {
    throw new Error(`handleAgentError: no cursor node at path "${atomPath}" for task ${task.id}`);
  }

  // ── Level 1: per-agent soft-retry ──────────────────────────────────────────

  const executionCount = node.executionCount ?? 0;
  if (executionCount < SOFT_RETRY_CAP) {
    node.executionCount = executionCount + 1;
    node.state = "pending";
    node.sessionFile = result.sessionFile;
    opts.onAudit?.("agent_retry", {
      taskId: task.id,
      atomPath,
      attempt: node.executionCount,
    });
    return "soft-retry";
  }

  // ── Level 2: whole-task fresh restart ─────────────────────────────────────
  // The caller owns task-level mutations (retryCount++, status, lastError).
  // This function only reads task.retryCount to decide the verdict.

  if (task.retryCount < opts.maxRetries) {
    opts.onAudit?.("task_retry", {
      taskId: task.id,
      attempt: task.retryCount + 1,
    });
    return "task-restart";
  }

  // ── Level 3: permanent task failure ────────────────────────────────────────

  opts.onAudit?.("task_failed", { taskId: task.id });
  return "task-fail";
}

// ── Resume reconciliation ────────────────────────────────────────────────────

/**
 * Recursively collect every cursor node whose `state === "running"`.
 *
 * Container nodes (sequential, parallel, gateLoop, loop) in the "running"
 * state are included — the caller decides how to handle them.
 */
function findAllRunningNodes(node: CursorNode): CursorNode[] {
  const result: CursorNode[] = [];
  if (node.state === "running") {
    result.push(node);
  }

  if (node.children) {
    for (const child of node.children) {
      result.push(...findAllRunningNodes(child));
    }
  }

  for (const sub of [node.workCursor, node.reviewCursor, node.childCursor]) {
    if (sub !== undefined) {
      result.push(...findAllRunningNodes(sub));
    }
  }

  return result;
}

/**
 * Reconcile a pool's tasks for resume after a crash or hard kill.
 *
 * For every task:
 *   - `running` → `ready` (in-flight agents were aborted);
 *   - `parked`  → `ready`;
 *   - `failed`  → `ready` (D12: resume resets failed→ready).
 *
 * Every cursor node whose state is `"running"` (an in-flight agent session)
 * is reset to `"pending"` with `executionCount = 0`, `sessionFile = undefined`,
 * and `lastText = undefined` — i.e. start FRESH rather than resuming a
 * half-written session after a hard-kill abort (§8 "start FRESH").
 * Completed (`done`) atoms are preserved untouched.
 *
 * Worktree verification is delegated to `opts.verifyWorktrees`, if provided.
 * The returned array lists task ids whose worktree is missing (the caller
 * should recreate them).
 *
 * @param pool   the live pool state (mutated in place).
 * @param opts.verifyWorktrees  optional callback that inspects the pool's
 *                              worktrees and returns ids of tasks whose
 *                              worktree is missing.
 * @param opts.onAudit  optional audit callback for state transitions.
 * @returns the list of task ids whose worktrees are missing (empty if no
 *          `verifyWorktrees` was provided).
 */
export async function reconcileForResume(
  pool: PoolState,
  opts?: {
    verifyWorktrees?: (pool: PoolState) => string[] | Promise<string[]>;
    onAudit?: (type: string, payload: Record<string, unknown>) => void;
  },
): Promise<string[]> {
  for (const task of pool.tasks) {
    if (task.status === "running" || task.status === "parked" || task.status === "failed") {
      task.status = "ready";
      opts?.onAudit?.("task_ready", { taskId: task.id });
    }

    // Reset every in-flight (running) atom — start fresh, do NOT resume
    // a half-written session after hard-kill abort (§8).
    const runningNodes = findAllRunningNodes(task.cursor);
    for (const runningNode of runningNodes) {
      runningNode.state = "pending";
      runningNode.executionCount = 0;
      runningNode.sessionFile = undefined;
      runningNode.lastText = undefined;
    }
  }

  // Delegate worktree verification to the caller.
  const missingIds = (await opts?.verifyWorktrees?.(pool)) ?? [];
  return missingIds;
}
