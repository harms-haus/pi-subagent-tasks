/**
 * run_tasks tool — THE integration tool wiring ALL prior modules (§6, §7, §14).
 *
 * This module provides the `run_tasks` tool definition that the pi-host calls
 * to create and execute a task pool. It handles:
 *
 *   - CREATE path: validate → build pool state → create worktrees →
 *     start scheduler → await fixed point → return summary.
 *   - RESUME path: read saved state → reconcile → recreate missing
 *     worktrees → start scheduler → await fixed point → return summary.
 *   - ABORT path: on signal.aborted → kill child processes → resolve
 *     with a best-effort partial summary.
 *   - Live board updates via onUpdate (1-second interval).
 *
 * This module is the HIGHEST-level seam — it wires together every other
 * module in the extension and is the intended entry point for integration
 * testing.
 *
 * @module run-tasks
 */

import { type ChildProcess } from "node:child_process";
import { join } from "node:path";

import kill from "tree-kill";

import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";

import type { GitOps } from "./git-op";
import type {
  AgentRunner,
  ComposeAtom,
  LimitsConfig,
  PoolState,
  PoolUsage,
  TaskRuntime,
  TaskSpec,
} from "./types";
import type { Scheduler } from "./scheduler";
import { createComposeScheduler } from "./scheduler";
import { createPoolCoordinator } from "./pools";
import { createMergeWorker } from "./merge";
import {
  writeState,
  readState,
  appendPoolHint,
  createPoolDirs,
  listPools,
  reconcilePoolOnResume,
  AuditLogger,
} from "./state";
import {
  createPoolWorktree,
  createTaskWorktree,
  ensureExcludeEntry,
  isGitRepo,
  canUseWorktrees,
  verifyWorktrees,
  removeTaskWorktree,
} from "./worktrees";
import { renderBoard, renderSummary } from "./render";
import { resolveDeps, detectCycles, computeDownstreamCount } from "./dag";
import { recomputeInitialStatuses, propagateFailures } from "./status";
import { buildCursor } from "./cursor";
import { slugify, poolDir } from "./utils";
import { seedMergeHelperProfile } from "./profiles";
import { DEFAULT_TOTAL_LIMIT, DEFAULT_MAX_RETRIES, BRANCH_PREFIX } from "./constants";

// ── Compose schema (relaxed — Type.Any for recursive compose field) ─────────

const composeAtomSchema: TSchema = Type.Any({
  description:
    "A compose atom — {type:'agent'}, {type:'sequential',atoms:[...]}, " +
    "{type:'parallel',atoms:[...]}, {type:'gateLoop',work,review}, " +
    "or {type:'loop',atom,count}",
});

// ── Limits schema ──────────────────────────────────────────────────────────

const limitsSchema = Type.Optional(
  Type.Object({
    total: Type.Optional(Type.Number({ description: "Whole-pool cap (default 4)" })),
    provider: Type.Optional(
      Type.Record(Type.String(), Type.Number(), {
        description: "Provider-only caps, e.g. { anthropic: 2 }",
      }),
    ),
    model: Type.Optional(
      Type.Record(Type.String(), Type.Number(), {
        description: "Model-specific caps, e.g. { 'anthropic/claude-sonnet-4-5': 1 }",
      }),
    ),
  }),
);

// ── Task spec schema ───────────────────────────────────────────────────────

const taskSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Optional task id; else t-<N>" })),
  title: Type.Optional(Type.String({ description: "Optional human label" })),
  prompt: Type.String({ description: "REQUIRED — the singular task prompt, delivered verbatim" }),
  profile: Type.Optional(Type.String({ description: "Default profile for this task's atoms" })),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), { description: "Ids or titles of dependencies (kanban-style)" }),
  ),
  compose: Type.Optional(composeAtomSchema),
});

// ── Parameters schema ──────────────────────────────────────────────────────

const runTasksParams = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        description: "Pool name → slugified to pool id + branch (required for CREATE)",
      }),
    ),
    tasks: Type.Optional(Type.Array(taskSchema, { description: "Array of task specs" })),
    limits: limitsSchema,
    maxRetries: Type.Optional(
      Type.Number({ description: "Whole-task fresh-restart cap (default 2)" }),
    ),
    resume: Type.Optional(
      Type.String({ description: "Pool id to resume (mutually exclusive with name+tasks)" }),
    ),
  },
  { additionalProperties: false },
);

// ── Tool options ───────────────────────────────────────────────────────────

export interface CreateRunTasksToolOptions {
  /** Factory returning a real or mock AgentRunner. */
  getAgentRunner: () => AgentRunner;
  /** Factory returning a real or mock GitOps. */
  getGitOps: () => GitOps;
  /** Mutable set of all spawned child processes (for abort cleanup). */
  childProcesses: Set<ChildProcess>;
}

// ── Helper: build a TaskRuntime from a spec + resolved metadata ────────────

function specToTaskRuntime(
  spec: TaskSpec,
  assignedId: string,
  deps: string[],
  downstreamCount: number,
): TaskRuntime {
  const compose: ComposeAtom = spec.compose ?? { type: "agent" as const };
  const cursor = buildCursor(compose, "0");
  return {
    id: assignedId,
    title: spec.title,
    prompt: spec.prompt,
    profile: spec.profile,
    dependsOn: deps,
    compose,
    cursor,
    status: "blocked",
    retryCount: 0,
    runningAgentCount: 0,
    worktreePath: null,
    branch: null,
    sessionFiles: [],
    downstreamCount,
    lastError: undefined,
    startedAt: undefined,
  };
}

// ── Tool implementation ────────────────────────────────────────────────────

/**
 * Create the `run_tasks` tool definition, wiring ALL prior modules.
 *
 * The returned tool definition can be registered with the pi extension
 * API via `pi.registerTool(...)`.
 */
export function createRunTasksTool(
  _pi: ExtensionAPI,
  opts: CreateRunTasksToolOptions,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: "run_tasks",
    label: "Run Tasks",
    description:
      "Create and execute a pool of tasks with dependency resolution, " +
      "concurrency limits, worktree isolation, and automatic merge. " +
      "Each task runs as one or more pi-agent sessions in its own git worktree. " +
      "Also supports resuming an existing pool by its pool id.",
    parameters: runTasksParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      // Parse known params for quick validation.
      const name = params.name as string | undefined;
      const tasks = params.tasks as TaskSpec[] | undefined;
      const resume = params.resume as string | undefined;

      // CREATE vs RESUME mutual exclusion.
      if (resume !== undefined && (name !== undefined || tasks !== undefined)) {
        throw new Error(
          "Cannot specify both 'resume' and 'name'/'tasks' — they are mutually exclusive.",
        );
      }

      // Shared state for cleanup in the catch block.
      let intervalId: ReturnType<typeof setInterval> | undefined;

      try {
        // ── Dispatched to helper ──────────────────────────────────────────
        return await runPool(params, {
          signal,
          onUpdate,
          ctx: _ctx,
          agentRunnerFactory: opts.getAgentRunner,
          gitOpsFactory: opts.getGitOps,
          pi: _pi,
          childProcesses: opts.childProcesses,
          intervalIdRef: (id: ReturnType<typeof setInterval> | undefined) => {
            intervalId = id;
          },
        });
      } finally {
        // Clean up interval on any exit (success, error, or abort).
        if (intervalId !== undefined) {
          clearInterval(intervalId);
        }
      }
    },

    renderResult(
      result: { content: Array<{ type?: string; text?: string }>; details?: unknown },
      options: { isPartial?: boolean; expanded?: boolean },
      _theme: Theme,
      _context?: unknown,
    ): Component {
      void _context;
      const opts = { isPartial: options.isPartial ?? false, expanded: options.expanded ?? false };
      if (opts.isPartial && result.details !== undefined) {
        const details = result.details as {
          board?: PoolState;
          poolsUsage?: PoolUsage;
          mergeInProgress?: boolean;
        };
        if (details.board !== undefined) {
          return renderBoard(
            details.board,
            opts,
            _theme,
            details.poolsUsage,
            details.mergeInProgress,
          );
        }
      }

      // Final summary: just render the text.
      const part = result.content[0];
      const text = part?.type === "text" && part.text !== undefined ? part.text : "";
      return new Text(text);
    },
  });
}

// ── Pool runner ────────────────────────────────────────────────────────────

/**
 * Internal state used by the pool runner that is shared between the main
 * runner and helper functions.
 */
interface RunPoolContext {
  signal?: AbortSignal;
  onUpdate?: unknown;
  ctx: unknown;
  agentRunnerFactory: () => AgentRunner;
  gitOpsFactory: () => GitOps;
  pi: ExtensionAPI;
  childProcesses: Set<ChildProcess>;
  intervalIdRef: (id: ReturnType<typeof setInterval> | undefined) => void;
}

/**
 * Run a pool: CREATE or RESUME, then enter the scheduling loop until fixed
 * point, and return the summary.
 */
async function runPool(params: Record<string, unknown>, rpc: RunPoolContext) {
  const name = params.name as string | undefined;
  const tasks = params.tasks as TaskSpec[] | undefined;
  const limits = params.limits as Partial<LimitsConfig> | undefined;
  const maxRetries = params.maxRetries as number | undefined;
  const resume = params.resume as string | undefined;

  // Resolve cwd.
  const ctxObj = rpc.ctx as { cwd?: string } | undefined;
  const cwd = ctxObj?.cwd ?? process.cwd();

  let pool: PoolState;
  let poolDirPath: string;
  const git = rpc.gitOpsFactory();
  let audit: AuditLogger | undefined;

  try {
    // ── RESUME path ─────────────────────────────────────────────────────────
    if (resume !== undefined) {
      if (typeof resume !== "string" || resume === "") {
        throw new Error("'resume' must be a non-empty pool id string.");
      }
      poolDirPath = poolDir(cwd, resume);
      const restored = readState(poolDirPath);
      if (restored === undefined) {
        throw new Error(
          `Pool "${resume}" not found at ${poolDirPath}. List pools with 'ls .pi/task-pools/' or inspect a pool with 'read .pi/task-pools/<id>/state.json'.`,
        );
      }
      pool = restored;

      // Reconcile running/parked/failed → ready.
      const { missingWorktrees } = await reconcilePoolOnResume(pool, {
        verifyWorktrees: async (p: PoolState) => verifyWorktrees(git, p, cwd),
      });

      // Recreate missing task worktrees.
      const poolHead = await git.revParseHead(pool.poolWorktree);
      for (const taskId of missingWorktrees) {
        const task = pool.tasks.find((t) => t.id === taskId);
        if (task !== undefined) {
          const wt = await createTaskWorktree(
            git,
            cwd,
            pool.id,
            slugify(pool.name),
            task.id,
            poolHead,
          );
          task.worktreePath = wt.path;
          task.branch = wt.branch;
        }
      }

      writeState(poolDirPath, pool);
      appendPoolHint({ appendEntry: rpc.pi.appendEntry.bind(rpc.pi) }, pool.id);

      audit = new AuditLogger(poolDirPath, pool.id);
      audit.poolResumed({ poolId: pool.id, tasks: pool.tasks.length });
    } else {
      // ── CREATE path ──────────────────────────────────────────────────────
      if (name === undefined || typeof name !== "string" || name === "") {
        throw new Error("'name' is required for CREATE and must be a non-empty string.");
      }
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error("'tasks' is required for CREATE and must be a non-empty array.");
      }
      for (const [i, t] of tasks.entries()) {
        if (typeof t.prompt !== "string" || t.prompt.trim() === "") {
          throw new Error(`Task at index ${i} has empty or missing 'prompt'.`);
        }
      }

      // Validate limits.
      if (limits !== undefined && limits.total !== undefined) {
        if (limits.total <= 0) {
          throw new Error("'limits.total' must be > 0 when provided.");
        }
        if (limits.total > 32) {
          throw new Error("'limits.total' must be <= 32.");
        }
      }

      // Validate maxRetries.
      if (maxRetries !== undefined) {
        if (maxRetries > 10) {
          throw new Error("'maxRetries' must be <= 10.");
        }
      }

      // Resolve dependencies and detect cycles.
      const resolved = resolveDeps(tasks);
      const cycle = detectCycles(resolved.assignedIds, resolved.idMap);
      if (cycle !== null) {
        throw new Error(`Dependency cycle detected: ${cycle}`);
      }

      // Check git repository and worktree support.
      if (!(await isGitRepo(git, cwd))) {
        throw new Error("Not a git repository — task pools require git worktrees.");
      }
      if (!(await canUseWorktrees(git, cwd))) {
        throw new Error("Git worktrees are not supported in this repository or git version.");
      }

      // Check pool doesn't already exist.
      const poolId = slugify(name);
      if (listPools(cwd).includes(poolId)) {
        throw new Error(
          `Pool "${name}" (id: "${poolId}") already exists. Use resume: "${poolId}" to resume it.`,
        );
      }

      poolDirPath = poolDir(cwd, poolId);

      // Build LimitsConfig.
      const mergedLimits: LimitsConfig = {
        total: limits?.total ?? DEFAULT_TOTAL_LIMIT,
        provider: limits?.provider ?? {},
        model: limits?.model ?? {},
      };
      const mergedMaxRetries = maxRetries ?? DEFAULT_MAX_RETRIES;

      const poolBranch = `${BRANCH_PREFIX}/${poolId}`;
      const poolWtPath = join(poolDirPath, "worktrees", "pool");
      const baseBranch = await git.revParseHead(cwd);

      // Build task runtime objects.
      const downstreamCounts = computeDownstreamCount(resolved.assignedIds, resolved.idMap);
      const tasksRuntime: TaskRuntime[] = [];

      for (const [i, spec] of tasks.entries()) {
        const assignedId = resolved.assignedIds[i] as string;
        const deps = resolved.idMap.get(assignedId) ?? [];
        const count = downstreamCounts.get(assignedId) ?? 0;
        tasksRuntime.push(specToTaskRuntime(spec, assignedId, deps, count));
      }

      recomputeInitialStatuses(tasksRuntime);

      pool = {
        id: poolId,
        name,
        branch: poolBranch,
        poolWorktree: poolWtPath,
        baseBranch,
        limits: mergedLimits,
        maxRetries: mergedMaxRetries,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: "running",
        tasks: tasksRuntime,
        mergeQueue: [],
      };

      // Create pool directories.
      createPoolDirs(poolDirPath);

      // BUGFIX §10.6: track created worktrees so we can clean up if any
      // subsequent creation fails, preventing orphan worktrees.
      const createdWts: Array<{ path: string; branch: string }> = [];

      try {
        // Create pool worktree.
        const poolWt = await createPoolWorktree(git, cwd, poolId, poolId, baseBranch);
        pool.poolWorktree = poolWt.path;
        pool.branch = poolWt.branch;
        createdWts.push(poolWt);

        // Ensure .pi/task-pools/ is excluded from tracking.
        await ensureExcludeEntry(git, cwd);

        // Create task worktrees for ALL tasks (so scheduler can start them).
        // NOTE (D10): this eagerly creates all task worktrees at pool creation
        // time rather than lazily from post-merge pool HEAD.  Lazy-branching
        // (§10.3) is a known spec deviation acceptable for v1 and will be
        // validated in kb-26 (real integration).
        const poolHead = await git.revParseHead(pool.poolWorktree);
        for (const task of pool.tasks) {
          const wt = await createTaskWorktree(git, cwd, pool.id, poolId, task.id, poolHead);
          task.worktreePath = wt.path;
          task.branch = wt.branch;
          createdWts.push(wt);
        }
      } catch (err) {
        // Clean up any worktrees already created before the failure to avoid
        // orphaned branches and working trees.
        for (const wt of createdWts) {
          try {
            await removeTaskWorktree(git, wt.path, wt.branch, cwd);
          } catch {
            // Best-effort — don't mask the original error.
          }
        }
        throw new Error(
          `Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      // Persist initial state.
      writeState(poolDirPath, pool);

      // Seed merge-helper profile.
      seedMergeHelperProfile();

      // Register pool hint for session browser.
      appendPoolHint({ appendEntry: rpc.pi.appendEntry.bind(rpc.pi) }, pool.id);

      // Start audit.
      audit = new AuditLogger(poolDirPath, pool.id);
      audit.poolCreated({
        poolId: pool.id,
        name,
        tasks: tasksRuntime.length,
        limits: mergedLimits,
      });
    }

    // ── Common run loop (CREATE & RESUME) ──────────────────────────────────

    const pools = createPoolCoordinator(pool.limits);
    const agentRunner = rpc.agentRunnerFactory();

    // audit is always assigned in both the RESUME and CREATE branches above,
    // so audit! is safe here — TypeScript can't narrow past the if/else.
    const onAudit = (type: string, payload: Record<string, unknown>): void => {
      (audit as AuditLogger).log(type, payload);
    };

    // Declare scheduler first so merge worker callbacks can reference it
    // without circular dependency issues (mergeWorker calls scheduler.mergeComplete
    // and scheduler calls mergeWorker.enqueue).
    // eslint-disable-next-line prefer-const
    let scheduler: Scheduler;

    // ── Merge worker ───────────────────────────────────────────────────────
    const mergeWorker = createMergeWorker({
      git,
      poolWorktree: pool.poolWorktree,
      agentRunner,
      sessionDir: join(poolDirPath, "sessions"),
      pools,
      poolId: pool.id,
      getTask: (taskId: string) => pool.tasks.find((t) => t.id === taskId),
      onMerged: (taskId: string) => {
        const t = pool.tasks.find((task) => task.id === taskId);
        if (t) {
          t.status = "done";
          t.worktreePath = null;
          t.branch = null;
        }
        writeState(poolDirPath, pool);
        (audit as AuditLogger).worktreeMerged({ taskId });
        scheduler.mergeComplete(taskId);
      },
      onFailed: (taskId: string, reason: string) => {
        const t = pool.tasks.find((task) => task.id === taskId);
        if (t) {
          t.status = "failed";
          t.lastError = reason;
        }
        writeState(poolDirPath, pool);
        scheduler.mergeComplete(taskId);
      },
      audit: onAudit,
    });

    // ── Scheduler (declared after mergeWorker but referenced in its callbacks
    //     via the `let scheduler` above).
    scheduler = createComposeScheduler({
      pool,
      pools,
      agentRunner,
      maxRetries: pool.maxRetries,
      onMergeEnqueue: (taskId: string) => {
        mergeWorker.enqueue(taskId);
        // BUGFIX §14.1: call processNext after each enqueue so the merge
        // pipeline actually starts — without this the merge queue fills up
        // but processNext is never invoked, mergeInProgress stays true, and
        // the fixed point is never reached (production hang).
        mergeWorker.processNext().catch(() => {
          /* errors handled inside merge worker */
        });
      },
      onUpdate: (() => {
        // BUGFIX §14.2: throttle scheduler-state persistence so in-flight
        // mutations survive a process crash (resume-ability). Write every
        // 500ms at most; writeState is a fast atomic temp+rename.
        let lastWriteTime = 0;
        return () => {
          const now = Date.now();
          if (lastWriteTime === 0 || now - lastWriteTime >= 500) {
            lastWriteTime = now;
            pool.updatedAt = now;
            writeState(poolDirPath, pool);
          }
        };
      })(),
      onTaskRestart: async (task: TaskRuntime) => {
        // BUGFIX §8.2 (L2 retry): remove the stale worktree + branch,
        // create a fresh one from the current pool HEAD, and reset the
        // compose cursor so the task starts from scratch.
        if (task.worktreePath && task.branch) {
          await removeTaskWorktree(git, task.worktreePath, task.branch, cwd);
        }
        const poolHead = await git.revParseHead(pool.poolWorktree);
        const slug = slugify(pool.name);
        const wt = await createTaskWorktree(git, cwd, pool.id, slug, task.id, poolHead);
        task.worktreePath = wt.path;
        task.branch = wt.branch;
        task.cursor = buildCursor(task.compose, task.id);
        task.sessionFiles = [];
      },
      onAudit,
      signal: rpc.signal,
    });

    // Start the scheduler (first scheduling pass).
    scheduler.globalSchedule();

    // ── Live board updates (1s interval) ───────────────────────────────────
    const updateFn = rpc.onUpdate as
      | ((partial: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void)
      | undefined;

    const intervalId = setInterval(() => {
      if (updateFn) {
        try {
          const partial = renderSummary(pool);
          updateFn({
            content: partial.content,
            details: {
              poolId: pool.id,
              board: pool,
              poolsUsage: pools.usage(),
              mergeInProgress: mergeWorker.getInProgress(),
            },
          });
        } catch {
          // Best-effort — don't crash the loop on render errors.
        }
      }
    }, 1000);

    // Expose the interval id for cleanup.
    rpc.intervalIdRef(intervalId);

    // ── Wait for fixed point ───────────────────────────────────────────────
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (rpc.signal?.aborted) {
          // BUGFIX §14.3: kill all child processes immediately so they do not
          // orphan; clear the set after to prevent double-kill on repeated
          // checks.
          for (const proc of rpc.childProcesses) {
            if (proc.pid == null) continue;
            try {
              kill(proc.pid);
            } catch {
              // best-effort — process may already have exited
            }
          }
          rpc.childProcesses.clear();
          resolve(undefined);
          return;
        }
        if (
          scheduler.isComplete() &&
          !mergeWorker.getInProgress() &&
          pool.mergeQueue.length === 0
        ) {
          resolve(undefined);
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });

    // ── Completion ─────────────────────────────────────────────────────────
    clearInterval(intervalId);
    rpc.intervalIdRef(undefined);

    // BUGFIX §14.4: on abort, skip the done/finalisation block — writing
    // "done" would destroy resume-ability. Just render the partial summary.
    // Re-check signal.aborted since the promise resolves for both abort and
    // normal completion paths (the closure variable is not tracked by lint).
    if (!rpc.signal?.aborted) {
      // Propagate failures to dependent tasks.
      propagateFailures(pool.tasks);

      // Update pool status.
      pool.status = "done";
      pool.updatedAt = Date.now();
      writeState(poolDirPath, pool);

      audit.poolCompleted({ poolId: pool.id, tasks: pool.tasks.length });
    }
  } finally {
    if (audit !== undefined) {
      audit.close();
    }
  }

  return renderSummary(pool);
}
