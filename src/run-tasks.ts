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
  CursorNode,
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
import { buildCursor, isComposeComplete } from "./cursor";
import { slugify, poolDir } from "./utils";
import { seedMergeHelperProfile, resolveProfile } from "./profiles";
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
    worktree: Type.Optional(
      Type.Boolean({
        description: "Use isolated git worktrees and automatic merge (default true)",
      }),
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

// ── Helper: detect completed atoms in a cursor tree ──────────────────────

/**
 * Recursively check whether a cursor tree contains ANY node whose state is
 * `"done"` — i.e. the task has made meaningful progress that should not be
 * destroyed by a worktree recreation.
 *
 * Mirrors the recursive-walk pattern in `retry.ts`'s `findAllRunningNodes`,
 * traversing `children`, `workCursor`, `reviewCursor`, and `childCursor`.
 */
function hasCompletedAtoms(cursor: CursorNode): boolean {
  if (cursor.state === "done") return true;
  if (cursor.children) {
    for (const child of cursor.children) {
      if (hasCompletedAtoms(child)) return true;
    }
  }
  for (const sub of [cursor.workCursor, cursor.reviewCursor, cursor.childCursor]) {
    if (sub !== undefined && hasCompletedAtoms(sub)) return true;
  }
  return false;
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
    status: "ready", // overwritten by recomputeInitialStatuses; placeholder
    retryCount: 0,
    runningAgentCount: 0,
    worktreePath: null,
    branch: null,
    sessionFiles: [],
    downstreamCount,
    lastError: undefined,
    startedAt: undefined,
    outputLines: [],
    toolCallCount: 0,
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
      "concurrency limits, optional worktree isolation, and automatic merge. " +
      "Tasks use isolated git worktrees by default; set worktree:false to run all agents " +
      "in the current working directory. Also supports resuming an existing pool by its pool id.",
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
  const useWorktrees = params.worktree !== false;
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
          `Pool "${resume}" not found at ${poolDirPath}. List pools with 'ls .pi/subagent-tasks/' or inspect a pool with 'read .pi/subagent-tasks/<id>/state.json'.`,
        );
      }
      pool = restored;

      // Create the audit logger early so lifecycle events during
      // reconciliation and worktree recreation are captured (H3/M4).
      audit = new AuditLogger(poolDirPath, pool.id);

      // Reconcile running/parked/failed → ready.
      //
      // M8: verifyWorktrees now returns { missing, stale }. We capture the
      // stale ids via the callback closure (reconcilePoolOnResume →
      // reconcileForResume forwards only the "missing" ids as its return
      // value). This avoids touching the reconcile plumbing while still
      // surfacing stale-base worktrees for targeted recreation below.
      let staleWorktreeIds: string[] = [];
      const { missingWorktrees } = await reconcilePoolOnResume(pool, {
        verifyWorktrees:
          pool.worktree !== false
            ? async (p: PoolState) => {
                const v = await verifyWorktrees(git, p, cwd);
                staleWorktreeIds = v.stale;
                return v.missing;
              }
            : undefined,
      });

      const slug = slugify(pool.name);

      // Recreate missing task worktrees (externally deleted / corrupted).
      const poolHead = pool.worktree !== false ? await git.revParseHead(pool.poolWorktree) : "";
      for (const taskId of missingWorktrees) {
        const task = pool.tasks.find((t) => t.id === taskId);
        if (task !== undefined) {
          const wt = await createTaskWorktree(git, cwd, pool.id, slug, task.id, poolHead);
          task.worktreePath = wt.path;
          task.branch = wt.branch;
          audit.log("worktree_created", {
            scope: "task",
            taskId: task.id,
            path: wt.path,
            reason: "resume",
          });
        }
      }

      // M8: handle stale-base task worktrees — those branched from an old
      // pool HEAD before their parents' code was merged in (D10 / §10.1).
      for (const taskId of staleWorktreeIds) {
        const task = pool.tasks.find((t) => t.id === taskId);
        if (task === undefined) continue;
        if (!hasCompletedAtoms(task.cursor)) {
          // No progress to lose — recreate from the current pool HEAD so the
          // task sees its parents' merged code. Mirrors onTaskRestart /
          // onEnsureWorktree recreation.
          if (task.worktreePath !== null && task.branch !== null) {
            await removeTaskWorktree(git, task.worktreePath, task.branch, cwd);
            audit.log("worktree_deleted", { taskId: task.id, reason: "stale-base" });
          }
          const wt = await createTaskWorktree(git, cwd, pool.id, slug, task.id, poolHead);
          task.worktreePath = wt.path;
          task.branch = wt.branch;
          audit.log("worktree_created", {
            scope: "task",
            taskId: task.id,
            path: wt.path,
            reason: "stale-base",
          });
        } else {
          // Has completed-atom progress — preserve the worktree to avoid
          // losing work, but surface a warning so it's visible that the
          // task may be missing its parents' merged code.
          audit.log("worktree_stale", {
            taskId: task.id,
            path: task.worktreePath,
            reason: "has-progress",
          });
        }
      }

      // N2a: reconcile completed-but-unmerged tasks and a stale mergeQueue so
      // a pool aborted mid-merge can recover instead of hanging.
      //
      // The mergeQueue is transient (rebuilt from in-flight merges), so clear
      // any stale persisted entries — an id whose worktree/branch is already
      // gone would hit the no-worktree guard in processOne and (before the
      // N2b fix) strand accounting forever.
      pool.mergeQueue = [];

      // For each task whose atoms are fully executed (cursor complete) but
      // whose status is not "done", the merge never completed because of a
      // crash/abort in the window between the last atom succeeding and the
      // merge marking it done.
      for (const t of pool.tasks) {
        if (isComposeComplete(t.cursor) && t.status !== "done") {
          if (pool.worktree === false) {
            // Shared-cwd pools have no merge phase: completed atoms mean the
            // task itself completed before the prior process exited.
            t.status = "done";
          } else if (t.worktreePath !== null) {
            // Worktree still exists → merge is genuinely pending: set the
            // task to running and re-enqueue it so the merge worker drains
            // it (onAgentFinished-style merge-enqueue only fires on agent
            // success, which won't re-trigger for an already-complete cursor).
            t.status = "running";
            pool.mergeQueue.push(t.id);
          } else {
            // worktreePath === null — the worktree was already removed, which
            // only happens after a successful merge+cleanup. The merge
            // actually completed before the crash but persisted status lagged.
            t.status = "done";
          }
        }
      }

      writeState(poolDirPath, pool);
      appendPoolHint({ appendEntry: rpc.pi.appendEntry.bind(rpc.pi) }, pool.id);

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

      // Worktree mode requires git; shared-cwd mode also works outside a repo.
      if (useWorktrees && !(await isGitRepo(git, cwd))) {
        throw new Error("Not a git repository — worktree task pools require git.");
      }
      if (useWorktrees && !(await canUseWorktrees(git, cwd))) {
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

      const poolBranch = useWorktrees ? `${BRANCH_PREFIX}/${poolId}` : "";
      const poolWtPath = useWorktrees ? join(poolDirPath, "worktrees", "pool") : cwd;
      const baseBranch = useWorktrees ? await git.revParseHead(cwd) : "";

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
        worktree: useWorktrees,
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

      // Create the audit logger early so worktree creation events are
      // captured (H3/M4).
      audit = new AuditLogger(poolDirPath, pool.id);

      // BUGFIX §10.6: track created worktrees so we can clean up if any
      // subsequent creation fails, preventing orphan worktrees.
      const createdWts: Array<{ path: string; branch: string }> = [];

      try {
        if (useWorktrees) {
          // Create pool worktree.
          const poolWt = await createPoolWorktree(git, cwd, poolId, poolId, baseBranch);
          pool.poolWorktree = poolWt.path;
          pool.branch = poolWt.branch;
          createdWts.push(poolWt);
          audit.log("worktree_created", { scope: "pool", path: poolWt.path });

          // Ensure .pi/subagent-tasks/ is excluded from tracking.
          await ensureExcludeEntry(git, cwd);
        }

        // NOTE (H1 / D10 / §10.1): task worktrees are NOT created here.
        // They are created lazily on first start (when the task becomes
        // ready/parked with all deps done) via the scheduler's
        // ensureWorktrees() hook + the onEnsureWorktree callback below.
        // This ensures a dependent task branches from the pool HEAD that
        // already includes its merged parents' code.
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

      // Emit pool_created (audit logger was created earlier, after createPoolDirs).
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
      cwd,
      getTask: (taskId: string) => pool.tasks.find((t) => t.id === taskId),
      onMerged: (taskId: string) => {
        const t = pool.tasks.find((task) => task.id === taskId);
        if (t) {
          t.status = "done";
          t.worktreePath = null;
          t.branch = null;
        }
        writeState(poolDirPath, pool);
        // H3: worktree_merged is already emitted by the merge worker.
        // Emit task_done here where the status transition happens.
        (audit as AuditLogger).log("task_done", { taskId });
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
      sessionDir: join(poolDirPath, "sessions"),
      // C3: resolve each atom's profile so provider/model concurrency limits
      // (D7) are enforced, not just the `total` pool.
      profileResolver: (profileName: string) => {
        try {
          const p = resolveProfile(profileName, cwd);
          return { provider: p.provider, model: p.model };
        } catch {
          // Unknown profile → leave undefined; the agent start will fail with
          // a clear error from resolveProfile at spawn time.
          return {};
        }
      },
      maxRetries: pool.maxRetries,
      onMergeEnqueue: (taskId: string) => {
        if (pool.worktree === false) {
          const task = pool.tasks.find((candidate) => candidate.id === taskId);
          if (task) task.status = "done";
          (audit as AuditLogger).log("task_done", { taskId });
          writeState(poolDirPath, pool);
          scheduler.mergeComplete(taskId);
          return;
        }
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
        if (pool.worktree === false) {
          task.worktreePath = cwd;
          task.branch = null;
          task.cursor = buildCursor(task.compose, task.id);
          task.sessionFiles = [];
          return;
        }
        // BUGFIX §8.2 (L2 retry): remove the stale worktree + branch,
        // create a fresh one from the current pool HEAD, and reset the
        // compose cursor so the task starts from scratch.
        if (task.worktreePath && task.branch) {
          await removeTaskWorktree(git, task.worktreePath, task.branch, cwd);
          (audit as AuditLogger).log("worktree_deleted", { taskId: task.id, reason: "L2 restart" });
        }
        const poolHead = await git.revParseHead(pool.poolWorktree);
        const slug = slugify(pool.name);
        const wt = await createTaskWorktree(git, cwd, pool.id, slug, task.id, poolHead);
        task.worktreePath = wt.path;
        task.branch = wt.branch;
        (audit as AuditLogger).log("worktree_created", {
          scope: "task",
          taskId: task.id,
          path: wt.path,
          reason: "L2 restart",
        });
        task.cursor = buildCursor(task.compose, task.id);
        task.sessionFiles = [];
      },
      onEnsureWorktree: async (task: TaskRuntime) => {
        if (pool.worktree === false) {
          task.worktreePath = cwd;
          task.branch = null;
          writeState(poolDirPath, pool);
          return;
        }
        // H1 / D10 / §10.1: lazily create a task worktree on first start,
        // branched from the pool's CURRENT HEAD so dependent tasks see
        // their merged parents' code.
        const poolHead = await git.revParseHead(pool.poolWorktree);
        const slug = slugify(pool.name);
        const wt = await createTaskWorktree(git, cwd, pool.id, slug, task.id, poolHead);
        task.worktreePath = wt.path;
        task.branch = wt.branch;
        (audit as AuditLogger).log("worktree_created", {
          scope: "task",
          taskId: task.id,
          path: wt.path,
        });
        writeState(poolDirPath, pool);
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
          // M7: during partial (in-progress) updates, renderResult only uses
          // details.board — the full summary string is rebuilt and discarded
          // every tick. Send a lightweight placeholder instead.
          updateFn({
            content: [{ type: "text", text: "running…" }],
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
      const check = async (): Promise<void> => {
        // H1 / D10 / §10.1: lazily create worktrees for ready/parked tasks
        // whose dependencies are all done. ensureWorktrees() branches each
        // from the pool's current HEAD and triggers globalSchedule() so the
        // newly-worktree'd tasks can start.
        try {
          await scheduler.ensureWorktrees();
        } catch {
          // Best-effort — will retry on the next tick.
        }
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
        setTimeout(() => {
          void check();
        }, 100);
      };
      void check();
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

      // N6 (§15): emit task_skipped for tasks that failed purely by
      // propagation (a dependency failed), so the audit log can distinguish
      // a genuine failure from a transitive skip. Mirrors the summary's
      // SKIPPED-vs-FAILED prefix check on lastError.
      for (const t of pool.tasks) {
        if (
          t.status === "failed" &&
          t.lastError !== undefined &&
          t.lastError.startsWith("depends on failed")
        ) {
          audit.log("task_skipped", { taskId: t.id, reason: t.lastError });
        }
      }

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
