/**
 * Autonomous scheduling loop — the engine core (§7).
 *
 * The scheduler runs a synchronous {@link Scheduler.globalSchedule} pass that:
 *  1. Processes the serial merge queue (§10.2);
 *  2. Builds candidate-ready/parked tasks sorted by priority (§7.3);
 *  3. Starts agent sessions subject to concurrency-pool limits (§5.3);
 *  4. Detects the fixed point (D5, §7.1).
 *
 * Agent completion is handled via {@link Scheduler.onAgentFinished}, which
 * advances the compose cursor, handles errors (soft-retry / task-restart /
 * task-fail), and triggers a fresh scheduling pass.
 *
 * CRITICAL design properties:
 *  - The scheduler is synchronous and re-entrant (guarded by a `scheduling` bool).
 *  - `runAgent` is fire-and-forget via `.then()` — the scheduler never awaits it.
 *  - Pool accounting is all-or-nothing via {@link PoolCoordinator.tryAcquire}.
 *
 * @module
 */

import type {
  AgentDemand,
  AgentRunResult,
  AgentRunner,
  CursorNode,
  PoolState,
  Status,
  TaskRuntime,
} from "./types";
import type { PoolCoordinator } from "./pools";
import { canTransition, depsAllDone, isFixedPoint } from "./status";
import { nextWantedAgents, advanceComposeCursor } from "./atoms";
import type { AdvanceHandlers } from "./atoms";
import { handleGateLoopResult, needsReminderRetry, buildReviewerReminder } from "./gateloop";
import { handleAgentError as retryHandleAgentError } from "./retry";
import { resetCursorToPending } from "./cursor";
import { gateLoopParentPath } from "./atoms";
import { DEFAULT_MAX_RETRIES } from "./constants";

// ── Callbacks ───────────────────────────────────────────────────────────────

/**
 * Injected seam that bridges the scheduler to compose execution (§7.2).
 *
 * Every callback is synchronous. The scheduler calls them at specific points
 * during the scheduling loop and agent completion.
 */
export interface SchedulerCallbacks {
  /**
   * Extract the next set of agent demands from the task's compose cursor.
   *
   * Returns the atoms that *want* to run right now (pending cursor nodes whose
   * dependencies within the compose tree are satisfied). The scheduler will
   * further filter by concurrency-pool capacity.
   *
   * For a simple single-agent task with no pending work this returns an empty
   * array.
   */
  getDemands: (task: TaskRuntime) => AgentDemand[];

  /**
   * Advance the compose cursor after a successful agent run.
   *
   * @returns `composeComplete` — true when every atom in the compose tree has
   *   been consumed (task may still need merge).
   * @returns `needsMerge` — true when the task's worktree must be merged into
   *   the pool's base branch. The scheduler enqueues the task for merge when
   *   this is true.
   */
  advanceCursor: (
    task: TaskRuntime,
    atomPath: string,
    result: AgentRunResult,
  ) => { composeComplete: boolean; needsMerge: boolean };

  /**
   * Decide how to react to an agent failure (§8).
   *
   * @returns `"soft-retry"` — leave the cursor node pending; the compose tree
   *   will retry the same atom on the next scheduling pass.
   * @returns `"task-restart"` — reset the entire task to `"ready"` so it is
   *   re-scheduled from scratch (bounded by maxRetries).
   * @returns `"task-fail"` — mark the task as `"failed"` permanently.
   */
  handleAgentError: (
    task: TaskRuntime,
    atomPath: string,
    result: AgentRunResult,
  ) => "soft-retry" | "task-restart" | "task-fail";

  /**
   * Called when the scheduler is about to process the merge queue.
   *
   * The callback is expected to eventually remove `taskId` from
   * `pool.mergeQueue`. If it does so synchronously, the scheduler
   * immediately clears the merge-in-progress flag and may continue.
   */
  onMergeEnqueue: (taskId: string) => void;

  /**
   * Called when a task is restarted (L2 retry, task-restart action).
   *
   * The callback should remove the old worktree, create a new one, and
   * update the task's worktreePath, branch, cursor, and sessionFiles.
   * May be async — the scheduler awaits the returned promise.
   *
   * If the callback throws, the task is marked as failed.
   */
  onTaskRestart?: (task: TaskRuntime) => Promise<void> | void;

  /**
   * Fired after every state mutation so the TUI / persistence layer can react.
   */
  onUpdate: () => void;
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface SchedulerOptions {
  /** The live pool state (mutated in place). */
  pool: PoolState;
  /** Concurrency-pool coordinator. */
  pools: PoolCoordinator;
  /** Agent runner seam (real or mock). */
  agentRunner: AgentRunner;
  /** Callbacks bridging to compose execution. */
  callbacks: SchedulerCallbacks;
  /** Optional abort signal; when aborted the scheduler stops starting agents. */
  signal?: AbortSignal;
}

// ── Public interface ────────────────────────────────────────────────────────

export interface Scheduler {
  /**
   * Run one synchronous scheduling pass.
   *
   * Process merge queue, build candidate list, start agents, detect fixed
   * point. Guarded against re-entrance.
   */
  globalSchedule(): void;

  /**
   * Called by agent completion handlers (fire-and-forget).
   *
   * Releases pool slots, advances the compose cursor, handles errors, feeds
   * the task's next demands, and triggers a fresh scheduling pass.
   * May be async — the scheduler awaits cursor advancement internally.
   */
  onAgentFinished(taskId: string, atomPath: string, result: AgentRunResult): void | Promise<void>;

  /**
   * Notify the scheduler that an async merge has completed.
   *
   * The async merge worker MUST call this when its merge finishes. The
   * scheduler removes `taskId` from the merge queue, clears the
   * merge-in-progress flag if the queue is now empty, and triggers a fresh
   * scheduling pass.
   */
  mergeComplete(taskId: string): void;

  /** True when the scheduler has determined no more work will happen. */
  isComplete(): boolean;

  /** Number of agents currently in-flight (across all tasks). */
  getInFlightCount(): number;
}

// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Create a scheduler instance.
 *
 * The returned {@link Scheduler} mutates `opts.pool` in place. The caller
 * should call {@link Scheduler.globalSchedule} immediately after creation
 * to kick off the first scheduling pass.
 */

export function createScheduler(opts: SchedulerOptions): Scheduler {
  // ── Internal state ──────────────────────────────────────────────────────
  const inFlight = new Map<string, Promise<void>>();
  const demandMeta = new Map<string, { provider?: string; model?: string }>();
  let mergeInProgress = false;
  let complete = false;
  let scheduling = false;

  // ── Helpers ─────────────────────────────────────────────────────────────

  function buildTaskMap(): Map<string, TaskRuntime> {
    const map = new Map<string, TaskRuntime>();
    for (const task of opts.pool.tasks) {
      map.set(task.id, task);
    }
    return map;
  }

  /**
   * Release all resources held by an agent identified by `(taskId, atomPath)`.
   *
   * Releases pool slots (via demandMeta), deletes the demandMeta entry, and
   * decrements `task.runningAgentCount` (floor at 0). Safe to call even if the
   * agent was never started — the demandMeta entry may not exist.
   */
  function releaseAgent(taskId: string, atomPath: string): void {
    const key = `${taskId}:${atomPath}`;
    const meta = demandMeta.get(key);
    if (meta !== undefined) {
      opts.pools.release(meta.provider, meta.model);
      demandMeta.delete(key);
    }

    const task = opts.pool.tasks.find((t) => t.id === taskId);
    if (task) {
      task.runningAgentCount = Math.max(0, task.runningAgentCount - 1);
    }
  }

  // ── tryAdvance ──────────────────────────────────────────────────────────

  /**
   * Try to start agent sessions for `task`'s pending demands.
   *
   * Iterates the demands returned by `callbacks.getDemands`, skipping any
   * atom path that is already in-flight. For each eligible demand, checks
   * concurrency-pool capacity and, if room exists, acquires the slot and
   * fires off `agentRunner.runAgent`.
   *
   * @returns `true` if at least one agent was started.
   */
  function tryAdvance(task: TaskRuntime): boolean {
    const demands = opts.callbacks.getDemands(task);
    if (demands.length === 0) return false;

    let started = false;

    for (const demand of demands) {
      const key = `${task.id}:${demand.atomPath}`;
      // Skip atoms that are already in-flight.
      if (inFlight.has(key)) continue;

      // All-or-nothing acquire: if the pool has room, the slot is ours.
      if (!opts.pools.tryAcquire(demand.provider, demand.model)) continue;

      task.runningAgentCount++;
      demandMeta.set(key, {
        provider: demand.provider,
        model: demand.model,
      });

      const p = opts.agentRunner
        .runAgent(demand, {
          sessionDir: "",
          poolId: opts.pool.id,
          signal: opts.signal,
        })
        .then(
          async (r) => {
            // IMPORTANT: delete from inFlight BEFORE awaiting onAgentFinished
            // so that globalSchedule() (called inside onAgentFinished) sees
            // inFlight.size === 0 for fixed-point detection. The key is
            // removed early so the scheduler can determine completion;
            // async worktree recreation (onTaskRestart) keeps the task in
            // "ready" state so isFixedPoint still returns false.
            inFlight.delete(key);
            await onAgentFinished(task.id, demand.atomPath, r);
          },
          () => {
            // Promise rejection: release all resources (pool slots, demandMeta,
            // runningAgentCount) so the system does not deadlock, then
            // re-trigger scheduling so freed slots get picked up.
            void inFlight.delete(key);
            releaseAgent(task.id, demand.atomPath);
            globalSchedule();
            opts.callbacks.onUpdate();
          },
        );

      inFlight.set(key, p);
      started = true;
    }

    return started;
  }

  // ── onAgentFinished ─────────────────────────────────────────────────────

  async function onAgentFinished(
    taskId: string,
    atomPath: string,
    result: AgentRunResult,
  ): Promise<void> {
    const task = opts.pool.tasks.find((t) => t.id === taskId);
    if (!task) return;

    // Release pool slots and decrement running agent count.
    releaseAgent(taskId, atomPath);

    if (result.success) {
      // Advance the compose cursor.
      const { composeComplete, needsMerge } = opts.callbacks.advanceCursor(task, atomPath, result);

      // Always enqueue for merge when compose is complete — even when
      // needsMerge is false — otherwise the task stays "running" with 0
      // agents and the fixed point is never reached (dead-end, §7.1).
      if (needsMerge || composeComplete) {
        opts.pool.mergeQueue.push(task.id);
      }

      // If the compose tree is exhausted, the task has no more pending
      // atoms. Skip the feeding/parking section entirely.
      if (composeComplete) {
        globalSchedule();
        opts.callbacks.onUpdate();
        return;
      }
    } else {
      // Agent failure — consult the error handler.
      const action = opts.callbacks.handleAgentError(task, atomPath, result);

      if (action === "task-restart") {
        task.status = "ready";
        task.retryCount++;
        // Remove old worktree and create a new one for the restarted task.
        // If the callback throws, the task transitions to failed so the
        // scheduler does not hang.
        try {
          await opts.callbacks.onTaskRestart?.(task);
        } catch (e) {
          task.status = "failed";
          task.lastError = `Worktree recreation failed after retry: ${e instanceof Error ? e.message : String(e)}`;
        }
      } else if (action === "task-fail") {
        task.status = "failed";
      }
      // "soft-retry": leave cursor node pending so getDemands re-emits it.
      // No status change needed.
    }

    // If the task has been marked failed (by gateLoop exhaustion or
    // task-fail), skip the feeding/parking section to avoid re-spawning
    // agents from a stale pending cursor.
    if (task.status === "failed") {
      globalSchedule();
      opts.callbacks.onUpdate();
      return;
    }

    // ── Feeding / parking decision ──────────────────────────────────────
    if (task.runningAgentCount > 0) {
      // Task still has running agents; try to start more (parallel siblings).
      tryAdvance(task);
    } else {
      // tryAdvance calls getDemands internally. When no agent started,
      // the task may have pending demands blocked by pool capacity or
      // all demands already satisfied.
      const started = tryAdvance(task);

      if (started) {
        // Successfully started one or more new agents; ensure the task is
        // in the "running" state.
        if (canTransition(task.status, "running")) {
          task.status = "running";
        }
      } else {
        // Nothing running and nothing was started. Check if the task still
        // wants to run (has pending demands) but is blocked by other tasks.
        // Parking invariant: only running→parked (never ready→parked).
        if (task.status === "running") {
          task.status = "parked";
        }
        // If status is not "running" (e.g. "ready" with nothing to do), stay
        // as-is. The next globalSchedule pass may advance it.
      }
    }

    // Trigger a fresh scheduling pass and notify observers.
    globalSchedule();
    opts.callbacks.onUpdate();
  }

  // ── globalSchedule ──────────────────────────────────────────────────────

  function globalSchedule(): void {
    // If the signal was aborted, stop scheduling forever.
    if (opts.signal?.aborted) {
      complete = true;
      return;
    }

    // Re-entry guard — prevents infinite recursion when onAgentFinished
    // calls globalSchedule while already inside a scheduling pass.
    if (scheduling) return;
    scheduling = true;

    try {
      // ── 1. Merge processing ──────────────────────────────────────────
      if (!mergeInProgress && opts.pool.mergeQueue.length > 0) {
        const mergingId = opts.pool.mergeQueue[0];
        if (mergingId !== undefined) {
          mergeInProgress = true;
          opts.callbacks.onMergeEnqueue(mergingId);

          // If the callback processed the merge synchronously (removed the
          // task from the queue), clear the flag immediately.
          if (opts.pool.mergeQueue.length === 0 || opts.pool.mergeQueue[0] !== mergingId) {
            mergeInProgress = false;
          }
        }
      }

      // ── 2. Unblock tasks whose dependencies are now all done ──────
      const taskMap = buildTaskMap();

      for (const task of opts.pool.tasks) {
        if (task.status === "blocked" && depsAllDone(task, taskMap)) {
          task.status = "ready";
        }
      }

      // ── 3. Build candidate list ─────────────────────────────────────
      const candidates = opts.pool.tasks.filter(
        (t) => (t.status === "ready" || t.status === "parked") && depsAllDone(t, taskMap),
      );

      // ── 4. Sort by priority (§7.3) ──────────────────────────────────
      candidates.sort((a, b) => {
        // PARKED first
        if (a.status === "parked" && b.status !== "parked") return -1;
        if (a.status !== "parked" && b.status === "parked") return 1;

        // Higher downstreamCount first
        if (b.downstreamCount !== a.downstreamCount) {
          return b.downstreamCount - a.downstreamCount;
        }

        // Fewer dependencies first
        if (a.dependsOn.length !== b.dependsOn.length) {
          return a.dependsOn.length - b.dependsOn.length;
        }

        // Stable sort — equal keys retain original order.
        return 0;
      });

      // ── 5. Try to advance each candidate ───────────────────────────
      for (const candidate of candidates) {
        const prevStatus: Status = candidate.status;
        const started = tryAdvance(candidate);

        if (started && canTransition(prevStatus, "running")) {
          candidate.status = "running";
        }
      }

      // ── 6. Fixed-point detection (D5, §7.1) ────────────────────────
      if (
        isFixedPoint(opts.pool.tasks, opts.pool.mergeQueue) &&
        inFlight.size === 0 &&
        !mergeInProgress
      ) {
        complete = true;
        opts.callbacks.onUpdate();
      }
    } finally {
      scheduling = false;
    }
  }

  // ── mergeComplete ────────────────────────────────────────────────

  function onMergeComplete(taskId: string): void {
    const idx = opts.pool.mergeQueue.indexOf(taskId);
    if (idx >= 0) {
      opts.pool.mergeQueue.splice(idx, 1);
    }

    if (opts.pool.mergeQueue.length === 0) {
      mergeInProgress = false;
    }

    globalSchedule();
    opts.callbacks.onUpdate();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  const scheduler: Scheduler = {
    globalSchedule,
    onAgentFinished,
    mergeComplete: onMergeComplete,
    isComplete(): boolean {
      // When aborted, also require that no agents are in-flight — the abort
      // handler sets complete=true but in-flight agents may still need cleanup.
      if (opts.signal?.aborted) {
        return complete && inFlight.size === 0;
      }
      return complete;
    },
    getInFlightCount(): number {
      return inFlight.size;
    },
  };

  return scheduler;
}

// ── Compose integration ───────────────────────────────────────────────────────

/** Options for {@link createComposeScheduler}. */
export interface ComposeSchedulerOptions {
  /** The live pool state (mutated in place). */
  pool: PoolState;
  /** Concurrency-pool coordinator. */
  pools: PoolCoordinator;
  /** Agent runner seam (real or mock). */
  agentRunner: AgentRunner;
  /**
   * Whole-task fresh-restart cap (default {@link DEFAULT_MAX_RETRIES}).
   * Passed to {@link handleAgentError} from the retry module.
   */
  maxRetries?: number;
  /**
   * Override the gateLoop iteration cap across ALL gateLoop nodes in the pool.
   * When omitted, each gateLoop node uses its own `maxIterations` (set from the
   * compose atom), falling back to the extension default of 3 (D8).
   */
  maxGateLoopIterations?: number;
  /**
   * Merge queue handler. Called when a task is ready for serial merge.
   * The default is a no-op — tests should supply a stub that marks the task
   * done and removes it from the merge queue.
   */
  onMergeEnqueue?: (taskId: string) => void;
  /** Fired after every state mutation (TUI / persistence). Default no-op. */
  onUpdate?: () => void;
  /** Optional audit callback for lifecycle events (retries, gateLoop, etc.). */
  onAudit?: (type: string, payload: Record<string, unknown>) => void;
  /**
   * Called when a task is restarted (L2 retry).
   *
   * The callback should remove the old worktree, create a new one, and
   * update the task's worktreePath, branch, cursor, and sessionFiles.
   * May be async — the scheduler awaits the returned promise.
   */
  onTaskRestart?: (task: TaskRuntime) => Promise<void> | void;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

/**
 * Create a scheduler with the real compose/gateLoop/retry callbacks wired in.
 *
 * This is the high-level factory that integrates:
 *   - {@link nextWantedAgents}     → `getDemands`
 *   - {@link advanceComposeCursor} → `advanceCursor` (with gateLoop handling)
 *   - {@link handleAgentError}     → `handleAgentError`
 *
 * ## GateLoop reminder retry
 *
 * When a review agent finishes without a valid verdict
 * ({@link needsReminderRetry} returns `true`), the integration resets the
 * review cursor to `"pending"` and arranges for the review to re-run **once**
 * with {@link buildReviewerReminder} prepended to its prompt. If the re-run
 * still produces no valid verdict, the normal rejection path is taken (the
 * result is treated as rejected with `NO_VERDICT`).
 *
 * ## GateLoop exhaustion
 *
 * When a gateLoop exceeds its iteration cap, the task is marked `"failed"`
 * with `lastError` set. This is a terminal failure — the scheduler will
 * propagate it through the dependency graph and reach the fixed point.
 *
 * @returns A fully-wired {@link Scheduler} that the caller should immediately
 *          call `.globalSchedule()` on.
 */
export function createComposeScheduler(opts: ComposeSchedulerOptions): Scheduler {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxGateLoopIterations = opts.maxGateLoopIterations;
  const onUpdate = opts.onUpdate ?? ((): void => {});
  const onAudit = opts.onAudit;

  // Track gateLoop paths whose review agent needs a reminder appended on the
  // next demand. Managed inside the closure — no cursor type pollution.
  const reminderPending = new Set<string>();
  /**
   * Tracks whether a reminder has already been injected for a given gateLoop
   * path. Prevents the infinite reminder loop: on the first no-verdict review
   * within an iteration the reminder is prepended once; if the reviewer still
   * produces no valid verdict the second time the result is treated as a
   * rejection (NO_VERDICT), advancing the gateLoop iteration.
   */
  const reminderUsed = new Set<string>();

  // ── getDemands ───────────────────────────────────────────────────────────
  // Wrap nextWantedAgents to inject review reminders when needed.

  function getDemands(task: TaskRuntime): AgentDemand[] {
    const demands = nextWantedAgents(task);
    for (const demand of demands) {
      // Check if this demand targets a review sub-cursor with a pending
      // reminder. The reminder was set by handleGateLoop when the previous
      // review result lacked a valid verdict.
      const gateLoopPath = gateLoopParentPath(demand.atomPath);
      if (gateLoopPath !== undefined && reminderPending.has(gateLoopPath)) {
        demand.effectivePrompt = buildReviewerReminder() + "\n\n" + demand.effectivePrompt;
        reminderPending.delete(gateLoopPath);
      }
    }
    return demands;
  }

  // ── advanceCursor ────────────────────────────────────────────────────────
  // Bridge advanceComposeCursor with gateLoop verdict handling.

  function advanceCursor(
    task: TaskRuntime,
    atomPath: string,
    result: AgentRunResult,
  ): { composeComplete: boolean; needsMerge: boolean } {
    const handlers: AdvanceHandlers = {
      /**
       * Called by advanceComposeCursor when a gateLoop sub-cursor (work or
       * review) agent completes, or when the atomPath points directly at a
       * gateLoop node.
       *
       * For review results without a valid verdict, this handler uses a
       * ONE-TIME reminder mechanism. On the first no-verdict outcome within
       * an iteration the review cursor is reset and a reminder will be
       * prepended on the next demand (via getDemands). If the reviewer still
       * produces no valid verdict after the reminder, the result is treated
       * as rejected via NO_VERDICT (advancing the iteration), NOT an infinite
       * re-spawn.
       */
      handleGateLoop: (gateLoopNode: CursorNode, result: AgentRunResult): void => {
        // ── One-time reminder retry ────────────────────────────────────
        if (gateLoopNode.gatePhase === "review" && needsReminderRetry(result)) {
          if (!reminderUsed.has(gateLoopNode.path)) {
            // First no-verdict: reset review cursor and schedule a reminder.
            if (gateLoopNode.reviewCursor) {
              resetCursorToPending(gateLoopNode.reviewCursor);
            }
            reminderPending.add(gateLoopNode.path);
            reminderUsed.add(gateLoopNode.path);
            return;
          }
          // Reminder already used this iteration — fall through to
          // handleGateLoopResult which treats the result as rejected
          // (NO_VERDICT), advancing the iteration.
        }

        // ── Normal gateLoop progression ─────────────────────────────────
        const outcome = handleGateLoopResult(task, gateLoopNode, result, {
          maxIterations: maxGateLoopIterations,
          onAudit,
        });

        // When the gateLoop transitions to a new work iteration (rejected
        // but not exhausted), clear the reminder tracking so the new
        // iteration gets a fresh reminder opportunity.
        if (!outcome.approved && !outcome.exhausted) {
          reminderPending.delete(gateLoopNode.path);
          reminderUsed.delete(gateLoopNode.path);
        }

        if (outcome.exhausted) {
          // GateLoop exhausted its iteration cap — terminal failure.
          task.status = "failed";
          task.lastError = `gateLoop exhausted after ${gateLoopNode.iteration ?? "?"} iterations`;
          onAudit?.("task_failed", {
            taskId: task.id,
            reason: "gateloop_exhausted",
            iteration: gateLoopNode.iteration,
          });
        }
      },
    };

    return advanceComposeCursor(task, atomPath, result, handlers);
  }

  // ── handleAgentError ─────────────────────────────────────────────────────
  // Delegate to the retry module. The caller (scheduler) owns task-level
  // mutations (retryCount++, status).

  function handleAgentErrorCallback(
    task: TaskRuntime,
    atomPath: string,
    result: AgentRunResult,
  ): "soft-retry" | "task-restart" | "task-fail" {
    return retryHandleAgentError(task, atomPath, result, {
      maxRetries,
      onAudit,
    });
  }

  // ── Assemble and return ─────────────────────────────────────────────────

  const onMergeEnqueue =
    opts.onMergeEnqueue ??
    ((taskId: string): void => {
      void taskId;
    });

  const onTaskRestart = opts.onTaskRestart;

  return createScheduler({
    pool: opts.pool,
    pools: opts.pools,
    agentRunner: opts.agentRunner,
    callbacks: {
      getDemands,
      advanceCursor,
      handleAgentError: handleAgentErrorCallback,
      onMergeEnqueue,
      onTaskRestart,
      onUpdate,
    },
    signal: opts.signal,
  });
}
