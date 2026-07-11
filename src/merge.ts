/**
 * FIFO merge queue with a merge-helper agent for conflict resolution.
 *
 * Tasks are serialised through a single merge worker to avoid races on the
 * shared pool worktree. The flow is:
 *
 * 1. Dirty check — auto-commit uncommitted changes.
 * 2. Fast-forward merge into the pool worktree.
 * 3. On success → clean up (remove worktree, delete branch, prune) → onMerged.
 * 4. On conflict → spawn a merge-helper agent → check remaining conflicts →
 *    resolved → success path / unresolved → mergeAbort + onFailed.
 *
 * @module
 */

import type { GitOps } from "./git-op";
import type { AgentDemand, AgentRunner, AgentRunOptions, TaskRuntime } from "./types";
import type { PoolCoordinator } from "./pools";
import { removeTaskWorktree } from "./worktrees";
import { resolveProfile } from "./profiles";

// ── Slot-acquire tuning (merge-helper) ───────────────────────────────────────

/** Delay between merge-helper slot-acquire attempts while the pool is full. */
export const HELPER_ACQUIRE_POLL_MS = 50;
/**
 * Maximum time to wait for a merge-helper slot before giving up and failing
 * the merge. Generous bound so a temporarily-full pool can drain, while a
 * permanently-full pool fails the merge instead of hanging the serial queue.
 */
export const HELPER_ACQUIRE_TIMEOUT_MS = 5 * 60 * 1000;

// ── Options ──────────────────────────────────────────────────────────────────

export interface MergeWorkerOptions {
  /** Git operations bound to the extension API. */
  git: GitOps;
  /** Absolute path to the pool worktree (the merge target). */
  poolWorktree: string;
  /** Injectable seam for spawning agents. */
  agentRunner: AgentRunner;
  /** Pool sessions directory (for merge-helper agent runs). */
  sessionDir: string;
  /** Concurrency-pool coordinator (for merge-helper slot accounting). */
  pools: PoolCoordinator;
  /** Optional abort signal, honoured while waiting for a merge-helper slot. */
  signal?: AbortSignal;
  /** Repository root cwd (retained for merge-helper context). */
  cwd: string;
  /** Pool id (for audit events). */
  poolId: string;
  /** Look up a task by id from the pool's in-memory state. */
  getTask: (taskId: string) => TaskRuntime | undefined;
  /** Called after a successful merge and cleanup. */
  onMerged: (taskId: string) => void;
  /** Called when the merge could not be resolved. */
  onFailed: (taskId: string, reason: string) => void;
  /** Emit an audit event. */
  audit: (type: string, payload: Record<string, unknown>) => void;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface MergeWorker {
  /** Push a task id onto the merge queue. */
  enqueue(taskId: string): void;
  /**
   * Process the next item in the queue, if any. No-op when a merge is
   * already in progress or the queue is empty. Recursively processes
   * subsequent items after the current one completes.
   */
  processNext(): Promise<void>;
  /** True when a merge is currently in-flight. */
  getInProgress(): boolean;
}

/**
 * Create a {@link MergeWorker} bound to the given options.
 *
 * Ref-mutating git operations (commitAll, mergeFF, worktreeRemove, etc.)
 * self-serialise via the promise-chain mutex inside {@link GitOps} — no
 * outer lock wrapper is needed.
 */
export function createMergeWorker(opts: MergeWorkerOptions): MergeWorker {
  const queue: string[] = [];
  let mergeInProgress = false;

  // ── Enqueue ───────────────────────────────────────────────────────────

  function enqueue(taskId: string): void {
    queue.push(taskId);
  }

  // ── Process next ──────────────────────────────────────────────────────

  async function processNext(): Promise<void> {
    if (mergeInProgress) return;
    if (queue.length === 0) return;

    mergeInProgress = true;
    const taskId = queue.shift() as string;

    try {
      await processOne(taskId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.audit("merge_error", { taskId, reason });
      try {
        opts.onFailed(taskId, reason);
      } catch (cbErr) {
        opts.audit("merge_callback_error", {
          taskId,
          phase: "onFailed",
          reason: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
    } finally {
      mergeInProgress = false;
      // Recursively process the next item in the queue. We intentionally
      // do NOT await the recursive call — the caller's promise resolves
      // after the current task finishes, and the next one starts on a fresh
      // microtask (via setTimeout) to avoid stack buildup on long queues.
      if (queue.length > 0) {
        setTimeout(() => {
          processNext().catch(() => {
            /* errors logged inside processNext or processOne */
          });
        }, 0);
      }
    }
  }

  // ── In-progress check ─────────────────────────────────────────────────

  function getInProgress(): boolean {
    return mergeInProgress;
  }

  // ── Internal: process one task ────────────────────────────────────────

  /**
   * Run the full merge pipeline for a single task.
   *
   * Ref-mutating ops (commitAll, mergeFF, etc.) each self-serialise via
   * the promise-chain mutex inside {@link GitOps}, so no outer lock is
   * needed.
   *
   * Steps:
   *   1. Look up the task; guard against missing task/worktree/branch.
   *   2. Dirty worktree → auto-commit.
   *   3. FF-merge the task branch into the pool worktree.
   *   4. FF success → clean up worktree + branch, onMerged.
   *   5. FF fail:
   *      a. No conflicts → mergeAbort + onFailed (diverged, not conflict).
   *      b. Conflicts → spawn merge-helper agent, check outcome.
   */
  async function processOne(taskId: string): Promise<void> {
    const task = opts.getTask(taskId);
    if (!task) {
      // N2b: even on a skip, we MUST call onFailed so the scheduler's
      // mergeComplete fires and accounting never sticks (a bare return
      // here leaves mergeInProgress true and the id at queue head → hang).
      opts.audit("merge_skipped", { taskId, reason: "task not found" });
      try {
        opts.onFailed(taskId, "task not found");
      } catch (cbErr) {
        opts.audit("merge_callback_error", {
          taskId,
          phase: "onFailed",
          reason: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
      return;
    }
    const worktreePath = task.worktreePath;
    const branch = task.branch;
    if (!worktreePath || !branch) {
      // N2b: same as above — a bare return would strand accounting.
      opts.audit("merge_skipped", { taskId, reason: "no worktree or branch" });
      try {
        opts.onFailed(taskId, "no worktree or branch");
      } catch (cbErr) {
        opts.audit("merge_callback_error", {
          taskId,
          phase: "onFailed",
          reason: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
      return;
    }

    // ── Step 2: dirty check ─────────────────────────────────────────────
    opts.audit("merge_started", { taskId });
    const status = await opts.git.statusPorcelain(worktreePath);
    if (status.trim().length > 0) {
      await opts.git.commitAll("WIP: auto-commit before merge", worktreePath);
    }

    // ── Step 3: FF merge ────────────────────────────────────────────────
    const ffResult = await opts.git.mergeFF(branch, opts.poolWorktree);

    // ── Step 4: FF succeeded ────────────────────────────────────────────
    if (ffResult.code === 0) {
      await handleFfSuccess(taskId, worktreePath, branch);
      return;
    }

    // ── Step 5: FF failed — fall back to a regular merge ────────────────
    // Divergence is normal when sibling task branches were created from the
    // same pool HEAD. A failed --ff-only is therefore not a task failure.
    opts.audit("merge_fallback", { taskId });
    const mergeResult = await opts.git.lock(() =>
      opts.git.gitExec(["merge", "--no-edit", branch], opts.poolWorktree),
    );
    if (mergeResult.code === 0) {
      await handleFfSuccess(taskId, worktreePath, branch);
      return;
    }

    // ── Step 6: regular merge conflicted/failed ──────────────────────────
    await handleMergeConflict(taskId, task, worktreePath, branch);
  }

  /**
   * Handle a successful fast-forward merge: audit, remove worktree, and
   * notify the caller.
   *
   * NOTE: `merge --ff-only` already updated HEAD to the merged commit, so
   * we do NOT call revParseHead — that would detach HEAD and break
   * subsequent merges.
   */
  async function handleFfSuccess(
    taskId: string,
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    opts.audit("worktree_merged", { taskId });

    await removeTaskWorktree(opts.git, worktreePath, branch, opts.poolWorktree);
    opts.audit("worktree_deleted", { taskId });

    try {
      opts.onMerged(taskId);
    } catch (err) {
      opts.audit("merge_callback_error", {
        taskId,
        phase: "onMerged",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle a merge conflict: check for files with unmerged conflicts, spawn
   * a merge-helper agent, then check whether conflicts remain.
   *
   * The merge-helper consumes a concurrency slot like any other agent
   * (§17.6, D7): before spawning it we wait for a `total` slot to free up,
   * so the cap is never exceeded. If no slot becomes available within the
   * bounded wait, the merge is aborted and reported as failed.
   *
   * Edge case — if the regular merge fails but reports no unmerged files
   * (for example a hook or repository-state error), abort and report the
   * actual merge diagnostic rather than spawning a helper with nothing to
   * resolve.
   */
  async function handleMergeConflict(
    taskId: string,
    task: TaskRuntime,
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    opts.audit("merge_conflict", { taskId });

    const conflictFiles = await opts.git.conflictedFiles(opts.poolWorktree);

    // A non-conflict merge failure cannot be repaired by the helper.
    if (conflictFiles.length === 0) {
      await opts.git.mergeAbort(opts.poolWorktree);
      const reason = "regular merge failed without conflicts";
      opts.audit("merge_failed", { taskId, reason });
      try {
        opts.onFailed(taskId, reason);
      } catch (err) {
        opts.audit("merge_callback_error", {
          taskId,
          phase: "onFailed",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // The merge-helper consumes a concurrency slot like any other agent
    // (§17.6, D7): before spawning it we wait for a slot to free up so the
    // `total` cap — and the helper's real provider/model caps — are never
    // exceeded. The helper's provider/model are resolved from its profile
    // (N7); if the profile can't be resolved we fall back to total-only
    // accounting. The wait is bounded — a generous timeout (and an optional
    // abort signal) ensures a permanently-full pool fails the merge rather
    // than hanging the serial queue.
    let helperProvider: string | undefined;
    let helperModel: string | undefined;
    try {
      const p = resolveProfile("merge-helper", opts.cwd);
      helperProvider = p.provider;
      helperModel = p.model;
    } catch {
      // merge-helper profile missing/unresolved → fall back to total-only
    }

    const slotAcquired = await acquireHelperSlot(
      opts.pools,
      helperProvider,
      helperModel,
      opts.signal,
    );
    if (!slotAcquired) {
      const reason = "merge-helper could not acquire a concurrency slot";
      await opts.git.mergeAbort(opts.poolWorktree);
      opts.audit("merge_failed", { taskId, reason });
      try {
        opts.onFailed(taskId, reason);
      } catch (err) {
        opts.audit("merge_callback_error", {
          taskId,
          phase: "onFailed",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    const demand: AgentDemand = {
      atomPath: `merge-${taskId}`,
      profileName: "merge-helper",
      effectivePrompt: buildMergeHelperPrompt(task, conflictFiles),
      cwd: opts.poolWorktree,
      taskId,
    };

    const runOpts: AgentRunOptions = {
      sessionDir: opts.sessionDir,
      poolId: opts.poolId,
    };

    try {
      try {
        await opts.agentRunner.runAgent(demand, runOpts);
      } finally {
        opts.pools.release(helperProvider, helperModel);
      }

      // Check whether conflicts were resolved.
      const remainingConflicts = await opts.git.conflictedFiles(opts.poolWorktree);
      if (remainingConflicts.length === 0) {
        opts.audit("merge_resolved", { taskId });
        await handleFfSuccess(taskId, worktreePath, branch);
      } else {
        await opts.git.mergeAbort(opts.poolWorktree);
        opts.audit("merge_failed", { taskId });
        try {
          opts.onFailed(taskId, "merge-helper could not resolve conflicts");
        } catch (err) {
          opts.audit("merge_callback_error", {
            taskId,
            phase: "onFailed",
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      // Ensure mergeAbort is called even if agentRunner.runAgent throws or
      // the post-flight check fails, so the pool worktree isn't left with
      // MERGE_HEAD.
      await opts.git.mergeAbort(opts.poolWorktree).catch(() => {});
      throw err;
    }
  }

  return { enqueue, processNext, getInProgress };
}

// ── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Build the effective prompt for the merge-helper agent.
 *
 * The prompt communicates the task goal and the list of conflicted files so
 * the agent understands the context of the merge.
 */
function buildMergeHelperPrompt(task: TaskRuntime, conflictFiles: string[]): string {
  return [
    `Task goal: ${task.prompt}`,
    "",
    "Conflicted files:",
    ...conflictFiles.map((f) => `  ${f}`),
    "",
    "Resolve the merge conflicts, stage, and commit.",
  ].join("\n");
}

/**
 * Acquire a merge-helper slot from the concurrency pools, polling every
 * {@link HELPER_ACQUIRE_POLL_MS} until one is available.
 *
 * Resolves `true` once a slot is acquired, or `false` if the
 * {@link HELPER_ACQUIRE_TIMEOUT_MS} deadline elapses or `signal` (if
 * provided) aborts first — in which case the caller should treat the merge
 * as failed.
 *
 * Acquires against `provider`/`model` (when provided) so the merge-helper
 * is counted against its real provider/model caps (§17.6, D7 / N7), not
 * just the `total` pool. When both are `undefined` (e.g. the merge-helper
 * profile couldn't be resolved) only the `total` pool is touched.
 */
async function acquireHelperSlot(
  pools: PoolCoordinator,
  provider?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + HELPER_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    if (pools.tryAcquire(provider, model)) return true;
    if (signal?.aborted) return false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(HELPER_ACQUIRE_POLL_MS, remaining)),
    );
  }
}
