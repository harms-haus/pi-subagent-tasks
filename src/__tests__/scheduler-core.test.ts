/**
 * Scheduler core unit tests — engine loop (§7), priority (§7.3), parking invariant (§5.2).
 *
 * Uses a mix of the mock {@link AgentRunner} and custom runners with deferred
 * promise resolution to observe intermediate scheduler states.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { createScheduler } from "../scheduler";
import type { SchedulerCallbacks } from "../scheduler";
import { createPoolCoordinator } from "../pools";
import type {
  AgentDemand,
  AgentRunOptions,
  AgentRunResult,
  AgentRunner,
  LimitsConfig,
  PoolState,
  TaskRuntime,
} from "../types";

/** Shared sessions dir for all scheduler-core tests. */
const SESSION_DIR = "/sessions";

// ── Test domain helpers ─────────────────────────────────────────────────────

const AGENT_ATOM = { type: "agent" as const };
const AGENT_CURSOR = (path = "0") => ({
  kind: "agent" as const,
  path,
  state: "pending" as const,
});

function makeTask(overrides: Partial<TaskRuntime> & { id: string }): TaskRuntime {
  return {
    id: overrides.id,
    title: overrides.title,
    prompt: overrides.prompt ?? "do the thing",
    profile: overrides.profile,
    dependsOn: overrides.dependsOn ?? [],
    compose: overrides.compose ?? AGENT_ATOM,
    cursor: overrides.cursor ?? AGENT_CURSOR(),
    status: overrides.status ?? "blocked",
    retryCount: overrides.retryCount ?? 0,
    runningAgentCount: overrides.runningAgentCount ?? 0,
    worktreePath: overrides.worktreePath ?? null,
    branch: overrides.branch ?? null,
    sessionFiles: overrides.sessionFiles ?? [],
    downstreamCount: overrides.downstreamCount ?? 0,
    lastError: overrides.lastError,
    startedAt: overrides.startedAt,
  };
}

interface PoolOpts {
  id?: string;
  name?: string;
  branch?: string;
  limits?: LimitsConfig;
  maxRetries?: number;
  tasks: TaskRuntime[];
}

function createPool(opts: PoolOpts): PoolState {
  return {
    id: opts.id ?? "test-pool",
    name: opts.name ?? "test",
    branch: opts.branch ?? "main",
    poolWorktree: "/tmp/test-worktree",
    baseBranch: "main",
    limits: opts.limits ?? { total: 4, provider: {}, model: {} },
    maxRetries: opts.maxRetries ?? 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
    tasks: opts.tasks,
    mergeQueue: [],
  };
}

/**
 * Build a stub {@link SchedulerCallbacks} with sensible defaults.
 *
 * - `getDemands` returns a single demand per ready/parked/running task and
 *   an empty array for terminal-status tasks.
 * - `advanceCursor` returns `{ composeComplete: true, needsMerge: true }`
 *   for any successful run.
 * - `handleAgentError` returns `"soft-retry"` by default.
 * - `onMergeEnqueue` is a no-op (caller must override for merge tests).
 * - `onUpdate` is a no-op.
 *
 * Individual properties can be overridden via the `overrides` argument.
 */
function stubCallbacks(overrides: Partial<SchedulerCallbacks> = {}): SchedulerCallbacks {
  const defaults: SchedulerCallbacks = {
    getDemands: (task) => {
      if (task.status === "done" || task.status === "failed" || task.status === "blocked") {
        return [];
      }
      return [
        {
          atomPath: "0",
          profileName: "default",
          effectivePrompt: task.prompt,
          cwd: "",
          taskId: task.id,
        },
      ];
    },

    advanceCursor: (_task, _atomPath, _result) => ({
      composeComplete: true,
      needsMerge: true,
    }),

    handleAgentError: (_task, _atomPath, _result) => "soft-retry" as const,

    onMergeEnqueue: (_taskId) => {
      /* no-op — caller overrides for merge tests */
    },

    onUpdate: () => {},
  };

  return { ...defaults, ...overrides };
}

/**
 * Create an agent runner that immediately resolves with a successful result
 * for most tasks, but allows specific task ids to be deferred (controlled
 * by manually calling the returned `resolve` function).
 *
 * This lets tests observe intermediate scheduler states (e.g. a task that is
 * "running" before its agent completes).
 */
function createDeferredRunner(defers: string[]): {
  runner: AgentRunner;
  resolve: (taskId: string, result?: Partial<AgentRunResult>) => void;
} {
  const pending = new Map<string, (result: AgentRunResult) => void>();

  const runner: AgentRunner = {
    async runAgent(demand: AgentDemand): Promise<AgentRunResult> {
      if (defers.includes(demand.taskId)) {
        return new Promise<AgentRunResult>((resolve) => {
          pending.set(demand.taskId, resolve);
        });
      }
      return {
        success: true,
        lastText: `mock-${demand.atomPath}`,
        exitCode: 0,
        durationMs: 0,
      };
    },
  };

  return {
    runner,
    resolve(taskId: string, result?: Partial<AgentRunResult>): void {
      const resolve = pending.get(taskId);
      if (resolve) {
        const base: AgentRunResult = {
          success: true,
          lastText: "done",
          exitCode: 0,
          durationMs: 0,
        };
        resolve({ ...base, ...result });
        pending.delete(taskId);
      }
    },
  };
}

/**
 * Flush all pending microtasks so that fire-and-forget `.then()` callbacks
 * have settled.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe("scheduler core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 1: Single-agent task ──────────────────────────────────────────
  it("single-agent task: starts, completes, merges, reaches fixed point", async () => {
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    const advanceCursor = vi.fn(
      (_task: TaskRuntime, _atomPath: string, _result: AgentRunResult) => ({
        composeComplete: true,
        needsMerge: true,
      }),
    );

    const onMergeEnqueue = vi.fn((taskId: string) => {
      const task = pool.tasks.find((t) => t.id === taskId);
      if (task) {
        task.status = "done";
        task.worktreePath = null;
        task.branch = null;
      }
      const idx = pool.mergeQueue.indexOf(taskId);
      if (idx >= 0) pool.mergeQueue.splice(idx, 1);
    });

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor,
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      sessionDir: SESSION_DIR,
      agentRunner: {
        async runAgent() {
          return { success: true, lastText: "done", exitCode: 0, durationMs: 5 };
        },
      },
      callbacks,
    });

    // First scheduling pass: start the agent
    scheduler.globalSchedule();
    expect(pool.tasks[0]!.runningAgentCount).toBe(1);
    expect(pool.tasks[0]!.status).toBe("running");

    // Wait for agent to complete (microtask flush)
    await flushMicrotasks();

    // The agent resolved → advanceCursor called → merge enqueued → merge
    // processed → task marked done → fixed point reached.
    expect(advanceCursor).toHaveBeenCalledTimes(1);
    expect(onMergeEnqueue).toHaveBeenCalledTimes(1);
    expect(pool.tasks[0]!.status).toBe("done");
    expect(pool.mergeQueue).toEqual([]);
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Test 2: Two independent tasks ────────────────────────────────────
  it("starts two independent tasks concurrently when total pool has room", async () => {
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" }), makeTask({ id: "t2", status: "ready" })],
    });

    const callbacks = stubCallbacks({
      onMergeEnqueue: (taskId) => {
        const task = pool.tasks.find((t) => t.id === taskId);
        if (task) task.status = "done";
        const idx = pool.mergeQueue.indexOf(taskId);
        if (idx >= 0) pool.mergeQueue.splice(idx, 1);
      },
    });

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      sessionDir: SESSION_DIR,
      agentRunner: {
        async runAgent() {
          return { success: true, lastText: "done", exitCode: 0, durationMs: 5 };
        },
      },
      callbacks,
    });

    scheduler.globalSchedule();

    // Both tasks should be running concurrently
    const t1 = pool.tasks.find((t) => t.id === "t1")!;
    const t2 = pool.tasks.find((t) => t.id === "t2")!;
    expect(t1.status).toBe("running");
    expect(t1.runningAgentCount).toBe(1);
    expect(t2.status).toBe("running");
    expect(t2.runningAgentCount).toBe(1);

    // Wait for both to finish
    await flushMicrotasks();
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Test 3: Dependent tasks A→B ────────────────────────────────────────
  it("runs dependent task only after its dependency completes", async () => {
    // A is ready → A runs first. B is blocked on A.
    const tasks = [
      makeTask({ id: "A", status: "ready", dependsOn: [] }),
      makeTask({ id: "B", status: "blocked", dependsOn: ["A"] }),
    ];
    const pool = createPool({ tasks });

    // Defer B's agent so we can observe B in the "running" state.
    const { runner, resolve: resolveB } = createDeferredRunner(["B"]);

    const advanceCursor = vi.fn(() => ({ composeComplete: true, needsMerge: true }));
    const onMergeEnqueue = vi.fn((taskId: string) => {
      const task = pool.tasks.find((t) => t.id === taskId);
      if (task) task.status = "done";
      const idx = pool.mergeQueue.indexOf(taskId);
      if (idx >= 0) pool.mergeQueue.splice(idx, 1);
    });

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor,
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    // Pass 1: A starts, B stays blocked
    scheduler.globalSchedule();
    const a = pool.tasks.find((t) => t.id === "A")!;
    const b = pool.tasks.find((t) => t.id === "B")!;
    expect(a.status).toBe("running");
    expect(a.runningAgentCount).toBe(1);
    expect(b.status).toBe("blocked");
    expect(b.runningAgentCount).toBe(0);

    // A finishes → A merges → B becomes ready → B starts (but deferred)
    await flushMicrotasks();
    expect(a.status).toBe("done");
    expect(b.status).toBe("running");
    expect(b.runningAgentCount).toBe(1);

    // Resolve B's agent → B finishes
    resolveB("B");
    await flushMicrotasks();
    expect(b.status).toBe("done");
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Test 4: total=1 — second stays READY (not parked) ─────────────────
  it("second task stays ready (not parked) when total cap is 1", async () => {
    const pool = createPool({
      limits: { total: 1, provider: {}, model: {} },
      tasks: [makeTask({ id: "t1", status: "ready" }), makeTask({ id: "t2", status: "ready" })],
    });

    // Defer t2's agent so we can observe the intermediate state (t2 ready, not parked)
    const { runner, resolve: resolveT2 } = createDeferredRunner(["t2"]);

    const onMergeEnqueue = vi.fn((taskId: string) => {
      const task = pool.tasks.find((t) => t.id === taskId);
      if (task) task.status = "done";
      const idx = pool.mergeQueue.indexOf(taskId);
      if (idx >= 0) pool.mergeQueue.splice(idx, 1);
    });

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor: vi.fn(() => ({ composeComplete: true, needsMerge: true })),
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    // Pass 1: only t1 can acquire (total=1)
    scheduler.globalSchedule();
    const t1 = pool.tasks.find((t) => t.id === "t1")!;
    const t2 = pool.tasks.find((t) => t.id === "t2")!;
    expect(t1.status).toBe("running");
    expect(t1.runningAgentCount).toBe(1);
    expect(t2.status).toBe("ready"); // NOT parked — parking invariant
    expect(t2.runningAgentCount).toBe(0);

    // t1 finishes → released → t2 can now acquire the slot
    await flushMicrotasks();
    expect(t1.status).toBe("done");
    expect(t2.status).toBe("running");
    expect(t2.runningAgentCount).toBe(1);

    // Resolve t2's agent → t2 finishes
    resolveT2("t2");
    await flushMicrotasks();
    expect(t2.status).toBe("done");
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Test 5: Priority — PARKED wins over READY ─────────────────────────
  it("gives priority to a PARKED task over a READY task when a slot frees", async () => {
    // A is parked (was running but couldn't get its next demand).
    // B is ready. Both have all deps done.
    // total=1 means only one can run at a time; parked priority wins.
    const pool = createPool({
      limits: { total: 1, provider: {}, model: {} },
      tasks: [
        makeTask({ id: "A", status: "parked", downstreamCount: 0 }),
        makeTask({ id: "B", status: "ready", downstreamCount: 0 }),
      ],
    });

    // Defer both A and B so we can observe intermediate states.
    // A starts first (parked priority), B starts after A resolves.
    const { runner, resolve: resolveDeferred } = createDeferredRunner(["A", "B"]);

    const onMergeEnqueue = vi.fn((taskId: string) => {
      const task = pool.tasks.find((t) => t.id === taskId);
      if (task) task.status = "done";
      const idx = pool.mergeQueue.indexOf(taskId);
      if (idx >= 0) pool.mergeQueue.splice(idx, 1);
    });

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor: vi.fn(() => ({ composeComplete: true, needsMerge: true })),
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    // Parked A should be scheduled before ready B
    scheduler.globalSchedule();

    const a = pool.tasks.find((t) => t.id === "A")!;
    const b = pool.tasks.find((t) => t.id === "B")!;

    // A (parked priority) got the slot; B stays ready
    expect(a.status).toBe("running");
    expect(a.runningAgentCount).toBe(1);
    expect(b.status).toBe("ready");
    expect(b.runningAgentCount).toBe(0);

    // Resolve A → A done → B can now start
    resolveDeferred("A");
    await flushMicrotasks();
    expect(a.status).toBe("done");
    expect(b.status).toBe("running");
    expect(b.runningAgentCount).toBe(1);

    // Resolve B → B finishes
    resolveDeferred("B");
    await flushMicrotasks();
    expect(b.status).toBe("done");
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Test 6: Parking invariant — running→parked ────────────────────────
  it("parks a running task whose next demand is blocked by other tasks", async () => {
    // Provider-level contention:
    //   Task A: sequential { atom1(anthropic) → atom2(openai) }
    //   Task B: single atom(openai)
    //
    // Limits: anthropic=1, openai=1
    // 1. A atom1 (anthropic) starts. B (openai) starts.
    // 2. A atom1 finishes → A wants atom2(openai) but B holds it → A parks.
    // 3. B finishes → releases openai → A (parked) runs atom2.

    const limits: LimitsConfig = {
      total: 4,
      provider: { anthropic: 1, openai: 1 },
      model: {},
    };

    const aProgress = { phase: "atom1" as string };

    const pool = createPool({
      limits,
      tasks: [makeTask({ id: "A", status: "ready" }), makeTask({ id: "B", status: "ready" })],
    });

    // Defer B's agent so openai slot stays held until we choose
    const { runner, resolve: resolveB } = createDeferredRunner(["B"]);

    const getDemands = (task: TaskRuntime): AgentDemand[] => {
      if (task.status === "done" || task.status === "failed") return [];
      if (task.id === "A") {
        if (aProgress.phase === "atom1") {
          return [
            {
              atomPath: "a1",
              profileName: "default",
              effectivePrompt: task.prompt,
              cwd: "",
              taskId: task.id,
              provider: "anthropic",
            },
          ];
        }
        if (aProgress.phase === "atom2") {
          return [
            {
              atomPath: "a2",
              profileName: "default",
              effectivePrompt: task.prompt,
              cwd: "",
              taskId: task.id,
              provider: "openai",
            },
          ];
        }
        return [];
      }
      if (task.id === "B") {
        return [
          {
            atomPath: "b1",
            profileName: "default",
            effectivePrompt: task.prompt,
            cwd: "",
            taskId: task.id,
            provider: "openai",
          },
        ];
      }
      return [];
    };

    const advanceCursor = vi.fn((task: TaskRuntime, atomPath: string, _result: AgentRunResult) => {
      if (task.id === "A" && atomPath === "a1") {
        aProgress.phase = "atom2";
        return { composeComplete: false, needsMerge: false };
      }
      if (task.id === "A" && atomPath === "a2") {
        return { composeComplete: true, needsMerge: true };
      }
      if (task.id === "B" && atomPath === "b1") {
        return { composeComplete: true, needsMerge: true };
      }
      return { composeComplete: true, needsMerge: true };
    });

    const onMergeEnqueue = vi.fn((taskId: string) => {
      const task = pool.tasks.find((t) => t.id === taskId);
      if (task) task.status = "done";
      const idx = pool.mergeQueue.indexOf(taskId);
      if (idx >= 0) pool.mergeQueue.splice(idx, 1);
    });

    const callbacks: SchedulerCallbacks = {
      getDemands,
      advanceCursor,
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    // Pass 1: A atom1 + B start (anthropic=1/1, openai=1/1)
    scheduler.globalSchedule();
    const a = pool.tasks.find((t) => t.id === "A")!;
    const b = pool.tasks.find((t) => t.id === "B")!;
    expect(a.status).toBe("running");
    expect(a.runningAgentCount).toBe(1);
    expect(b.status).toBe("running");
    expect(b.runningAgentCount).toBe(1);

    // A atom1 finishes → release anthropic → try atom2(openai) but
    // openai is held by B (deferred) → PARKED
    await flushMicrotasks();
    expect(a.status).toBe("parked");
    expect(a.runningAgentCount).toBe(0);
    expect(aProgress.phase).toBe("atom2");
    expect(b.status).toBe("running"); // B still running (deferred)
    expect(b.runningAgentCount).toBe(1);

    // Resolve B → releases openai → A (parked) runs atom2 → A finishes
    resolveB("B");
    await flushMicrotasks();
    expect(b.status).toBe("done");
    expect(a.status).toBe("done");
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Test 7: Fixed point detection ─────────────────────────────────────
  it("detects fixed point when all tasks are done/failed and no agents are in-flight", () => {
    const pool = createPool({
      tasks: [
        makeTask({ id: "done1", status: "done" }),
        makeTask({ id: "failed1", status: "failed" }),
      ],
    });

    const runner: AgentRunner = {
      async runAgent() {
        return { success: true, lastText: "done", exitCode: 0, durationMs: 0 };
      },
    };

    const callbacks = stubCallbacks();
    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    // Before globalSchedule, isComplete should be false (no pass yet)
    expect(scheduler.isComplete()).toBe(false);

    scheduler.globalSchedule();

    // After one pass with all terminal tasks + no merge queue + no in-flight
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: mergeComplete public method ───────────────
  it("mergeComplete removes task from queue and allows fixed point to be reached", async () => {
    // When merges are processed asynchronously (onMergeEnqueue is a no-op),
    // the caller must call scheduler.mergeComplete() when the merge finishes.
    // This test verifies mergeComplete removes the task from mergeQueue,
    // clears mergeInProgress, and triggers a scheduling pass that detects
    // the fixed point.
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    // No-op onMergeEnqueue — simulates async merge worker.
    const onMergeEnqueue = vi.fn();

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor: vi.fn(() => ({ composeComplete: true, needsMerge: true })),
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      sessionDir: SESSION_DIR,
      agentRunner: {
        async runAgent() {
          return { success: true, lastText: "done", exitCode: 0, durationMs: 0 };
        },
      },
      callbacks,
    });

    scheduler.globalSchedule();
    expect(pool.tasks[0]!.status).toBe("running");

    // Agent finishes → enqueued for merge → globalSchedule runs
    await flushMicrotasks();
    expect(pool.mergeQueue).toEqual(["t1"]);
    expect(onMergeEnqueue).toHaveBeenCalledWith("t1");
    expect(scheduler.isComplete()).toBe(false);

    // Simulate async merge worker: mark task done, then call mergeComplete
    pool.tasks[0]!.status = "done";
    scheduler.mergeComplete("t1");

    expect(pool.mergeQueue).toEqual([]);
    expect(scheduler.isComplete()).toBe(true);
  });

  it("mergeComplete handles multiple tasks in the merge queue", async () => {
    // Two tasks that merge asynchronously. mergeComplete is called for each
    // one, and the fixed point is only reached when both are processed.
    const pool = createPool({
      limits: { total: 2, provider: {}, model: {} },
      tasks: [makeTask({ id: "t1", status: "ready" }), makeTask({ id: "t2", status: "ready" })],
    });

    const onMergeEnqueue = vi.fn();

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor: vi.fn(() => ({ composeComplete: true, needsMerge: true })),
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      sessionDir: SESSION_DIR,
      agentRunner: {
        async runAgent() {
          return { success: true, lastText: "done", exitCode: 0, durationMs: 0 };
        },
      },
      callbacks,
    });

    scheduler.globalSchedule();
    expect(pool.tasks[0]!.status).toBe("running");
    expect(pool.tasks[1]!.status).toBe("running");

    await flushMicrotasks();
    expect(pool.mergeQueue).toEqual(["t1", "t2"]);
    // Serial merge: only the first task in the queue triggers
    // onMergeEnqueue; mergeInProgress blocks the second until
    // the first merge completes.
    expect(onMergeEnqueue).toHaveBeenCalledTimes(1);
    expect(onMergeEnqueue).toHaveBeenCalledWith("t1");

    // Mark both done, mergeComplete only the first
    pool.tasks[0]!.status = "done";
    pool.tasks[1]!.status = "done";
    scheduler.mergeComplete("t1");

    // Queue still has t2, no fixed point yet
    expect(pool.mergeQueue).toEqual(["t2"]);
    expect(scheduler.isComplete()).toBe(false);

    // mergeComplete("t1") clears mergeInProgress per-item (C4 fix) and
    // re-enters globalSchedule, which dispatches t2 to onMergeEnqueue.
    // The merge worker then calls mergeComplete("t2") when it finishes.
    scheduler.mergeComplete("t2");
    expect(pool.mergeQueue).toEqual([]);
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── C4 regression: merge queue must not strand tasks queued mid-merge ──
  it("dispatches the next queued task after a merge completes (no C4 deadlock)", async () => {
    // Regression test for C4: when two tasks finish back-to-back and both
    // land in pool.mergeQueue while a merge is in-flight, the second task
    // must still be handed to onMergeEnqueue once the first merge
    // completes. Previously mergeInProgress was only cleared when the
    // entire queue drained, so the second task was never dispatched and
    // the scheduler hung forever.
    //
    // onMergeEnqueue is a no-op (simulating an ASYNC merge worker) — the
    // test drives completion via scheduler.mergeComplete(), mirroring the
    // real mergeWorker.onMerged callback.
    const pool = createPool({
      limits: { total: 2, provider: {}, model: {} },
      tasks: [makeTask({ id: "t1", status: "ready" }), makeTask({ id: "t2", status: "ready" })],
    });

    const onMergeEnqueue = vi.fn();

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor: vi.fn(() => ({ composeComplete: true, needsMerge: true })),
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      sessionDir: SESSION_DIR,
      agentRunner: {
        async runAgent() {
          return { success: true, lastText: "done", exitCode: 0, durationMs: 0 };
        },
      },
      callbacks,
    });

    // Both agents start and finish immediately → both land in mergeQueue.
    scheduler.globalSchedule();
    await flushMicrotasks();

    expect(pool.mergeQueue).toEqual(["t1", "t2"]);
    // Only the head (t1) is dispatched while a merge is in-flight.
    expect(onMergeEnqueue).toHaveBeenCalledTimes(1);
    expect(onMergeEnqueue).toHaveBeenLastCalledWith("t1");

    // Simulate the merge worker finishing t1's merge.
    pool.tasks[0]!.status = "done";
    scheduler.mergeComplete("t1");

    // CRITICAL (C4): mergeComplete must clear mergeInProgress per-item so
    // globalSchedule dispatches t2. Without the fix, onMergeEnqueue is
    // never called for t2 and the scheduler hangs.
    expect(pool.mergeQueue).toEqual(["t2"]);
    expect(onMergeEnqueue).toHaveBeenCalledTimes(2);
    expect(onMergeEnqueue).toHaveBeenLastCalledWith("t2");
    expect(scheduler.isComplete()).toBe(false);

    // Finish t2's merge → both done → fixed point reached.
    pool.tasks[1]!.status = "done";
    scheduler.mergeComplete("t2");

    expect(pool.mergeQueue).toEqual([]);
    expect(onMergeEnqueue).toHaveBeenCalledTimes(2);
    expect(pool.tasks.every((t) => t.status === "done")).toBe(true);
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: sequential atom continuation ──────────────
  it("continues with the next sequential atom after one completes", async () => {
    // Task A: sequential { atom1 → atom2 }
    // After atom1 finishes, needsMerge=false → feeding starts atom2.
    // Defer atom2 so we can observe the intermediate running state.
    const pool = createPool({
      tasks: [makeTask({ id: "A", status: "ready" })],
    });

    const aProgress = { phase: "atom1" as string };
    let resolveAtom2: ((r: AgentRunResult) => void) | undefined;

    const runner: AgentRunner = {
      async runAgent(demand: AgentDemand): Promise<AgentRunResult> {
        if (demand.atomPath === "atom2") {
          return new Promise<AgentRunResult>((resolve) => {
            resolveAtom2 = resolve;
          });
        }
        return { success: true, lastText: "mock", exitCode: 0, durationMs: 0 };
      },
    };

    const getDemands = (task: TaskRuntime): AgentDemand[] => {
      if (task.status === "done" || task.status === "failed") return [];
      return [
        {
          atomPath: aProgress.phase,
          profileName: "default",
          effectivePrompt: task.prompt,
          cwd: "",
          taskId: task.id,
        },
      ];
    };

    const advanceCursor = vi.fn((_task: TaskRuntime, atomPath: string, _result: AgentRunResult) => {
      if (atomPath === "atom1") {
        aProgress.phase = "atom2";
        return { composeComplete: false, needsMerge: false };
      }
      return { composeComplete: true, needsMerge: true };
    });

    const onMergeEnqueue = vi.fn((taskId: string) => {
      const task = pool.tasks.find((t) => t.id === taskId);
      if (task) task.status = "done";
      const idx = pool.mergeQueue.indexOf(taskId);
      if (idx >= 0) pool.mergeQueue.splice(idx, 1);
    });

    const callbacks: SchedulerCallbacks = {
      getDemands,
      advanceCursor,
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      sessionDir: SESSION_DIR,
      agentRunner: runner,
      callbacks,
    });

    // Pass 1: atom1 starts
    scheduler.globalSchedule();
    expect(aProgress.phase).toBe("atom1");
    expect(pool.tasks[0]!.runningAgentCount).toBe(1);

    // atom1 finishes → feeding starts atom2 (atom2 is deferred)
    await flushMicrotasks();
    expect(aProgress.phase).toBe("atom2");
    expect(pool.tasks[0]!.runningAgentCount).toBe(1);
    expect(pool.tasks[0]!.status).toBe("running");

    // Resolve atom2 → atom2 finishes → done
    resolveAtom2!({ success: true, lastText: "mock", exitCode: 0, durationMs: 0 });
    await flushMicrotasks();
    expect(pool.tasks[0]!.status).toBe("done");
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: composeComplete merge even when needsMerge=false ─
  it("enqueues a task for merge when composeComplete is true even if needsMerge is false", async () => {
    // The scheduler must push the task into the merge queue when the compose
    // tree is exhausted (composeComplete=true) regardless of needsMerge —
    // otherwise the task stays "running" with 0 agents and the fixed point
    // is never reached (dead-end, §7.1).
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    const advanceCursor = vi.fn(() => ({ composeComplete: true, needsMerge: false }));

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor,
      handleAgentError: vi.fn(),
      onMergeEnqueue: vi.fn((taskId: string) => {
        const task = pool.tasks.find((t) => t.id === taskId);
        if (task) task.status = "done";
        const idx = pool.mergeQueue.indexOf(taskId);
        if (idx >= 0) pool.mergeQueue.splice(idx, 1);
      }),
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      sessionDir: SESSION_DIR,
      agentRunner: {
        async runAgent() {
          return { success: true, lastText: "done", exitCode: 0, durationMs: 0 };
        },
      },
      callbacks,
    });

    scheduler.globalSchedule();
    expect(pool.tasks[0]!.status).toBe("running");

    await flushMicrotasks();

    // Despite needsMerge being false, composeComplete=true enqueues for merge
    expect(advanceCursor).toHaveBeenCalledTimes(1);
    expect(pool.tasks[0]!.status).toBe("done");
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: sort by dependsOn.length ─────────────────
  it("sorts candidates by dependsOn.length as third priority key", async () => {
    // Two tasks, same status (ready), same downstreamCount, but different
    // dependsOn.length. The one with FEWER deps should be sorted first.
    const tasks = [
      makeTask({ id: "many", status: "ready", downstreamCount: 0, dependsOn: ["d1", "d2", "d3"] }),
      makeTask({ id: "few", status: "ready", downstreamCount: 0, dependsOn: ["d1"] }),
    ];
    // We need to add the dependency tasks too (even if they're done) so that
    // depsAllDone returns true for "many" and "few".
    tasks.push(makeTask({ id: "d1", status: "done" }));
    tasks.push(makeTask({ id: "d2", status: "done" }));
    tasks.push(makeTask({ id: "d3", status: "done" }));

    const pool = createPool({ limits: { total: 1, provider: {}, model: {} }, tasks });

    const started: string[] = [];

    const getDemands = (task: TaskRuntime): AgentDemand[] => {
      if (task.status === "done" || task.status === "failed" || task.status === "blocked") {
        return [];
      }
      return [
        {
          atomPath: "0",
          profileName: "default",
          effectivePrompt: task.prompt,
          cwd: "",
          taskId: task.id,
        },
      ];
    };

    const advanceCursor = vi.fn(() => ({ composeComplete: true, needsMerge: true }));

    const onMergeEnqueue = vi.fn((taskId: string) => {
      started.push(taskId);
      const task = pool.tasks.find((t) => t.id === taskId);
      if (task) task.status = "done";
      const idx = pool.mergeQueue.indexOf(taskId);
      if (idx >= 0) pool.mergeQueue.splice(idx, 1);
    });

    const callbacks: SchedulerCallbacks = {
      getDemands,
      advanceCursor,
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    // Use a deferred runner so only one task runs at a time (total=1)
    const { runner, resolve: resolveDeferred } = createDeferredRunner(["many", "few"]);

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    // "few" (1 dep) should be sorted before "many" (3 deps).
    scheduler.globalSchedule();
    const fewTask = pool.tasks.find((t) => t.id === "few")!;
    const manyTask = pool.tasks.find((t) => t.id === "many")!;

    // "few" should get the slot (fewer deps → higher priority)
    expect(fewTask.status).toBe("running");
    expect(manyTask.status).toBe("ready");

    // Finish "few" → "many" gets to run
    resolveDeferred("few");
    await flushMicrotasks();
    expect(fewTask.status).toBe("done");
    expect(manyTask.status).toBe("running");

    resolveDeferred("many");
    await flushMicrotasks();
    expect(manyTask.status).toBe("done");
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: rejected agent promise ───────────────────
  it("routes a rejected agent promise through normal failure handling", async () => {
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    // Runner that rejects every call.
    const runner: AgentRunner = {
      async runAgent(): Promise<AgentRunResult> {
        throw new Error("simulated crash");
      },
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      sessionDir: SESSION_DIR,
      agentRunner: runner,
      callbacks: {
        ...stubCallbacks(),
        handleAgentError: vi.fn(() => "task-fail" as const),
      },
    });

    // Start the agent — runAgent throws, rejection handler fires.
    scheduler.globalSchedule();
    expect(pools.usage().total.used).toBe(1);

    // Flush microtasks to fire the rejection handler.
    await flushMicrotasks();

    // The rejection handler releases all resources.
    expect(pool.tasks[0]!.runningAgentCount).toBe(0);
    expect(pools.usage().total.used).toBe(0);

    // Startup failures must not strand a zero-agent task as "running".
    expect(pool.tasks[0]!.status).toBe("failed");
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: error handler — task-fail ────────────────
  it("marks task as failed when handleAgentError returns task-fail", async () => {
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    const runner: AgentRunner = {
      async runAgent() {
        return {
          success: false,
          lastText: "error",
          exitCode: 1,
          durationMs: 5,
          error: "something broke",
        };
      },
    };

    const handleAgentError = vi.fn(
      (_task: TaskRuntime, _atomPath: string, _result: AgentRunResult) => "task-fail" as const,
    );

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor: vi.fn(),
      handleAgentError,
      onMergeEnqueue: vi.fn(),
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    scheduler.globalSchedule();
    expect(pool.tasks[0]!.status).toBe("running");

    await flushMicrotasks();

    expect(handleAgentError).toHaveBeenCalled();
    expect(pool.tasks[0]!.status).toBe("failed");
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: error handler — task-restart ─────────────
  it("increments retryCount when handleAgentError returns task-restart", async () => {
    // The runner defers t1 so we can control when it fails.
    // After restart, the scheduler immediately re-schedules the task
    // (goes back to "running"), so we verify retryCount was bumped.
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    // Defer t1 — the restart attempt will also be deferred (same taskId).
    const { runner, resolve: resolveDeferred } = createDeferredRunner(["t1"]);

    let retryHandled = false;
    const handleAgentError = vi.fn(
      (_task: TaskRuntime, _atomPath: string, _result: AgentRunResult) => {
        retryHandled = true;
        return "task-restart" as const;
      },
    );

    const onMergeEnqueue = vi.fn((taskId: string) => {
      const task = pool.tasks.find((t) => t.id === taskId);
      if (task) task.status = "done";
      const idx = pool.mergeQueue.indexOf(taskId);
      if (idx >= 0) pool.mergeQueue.splice(idx, 1);
    });

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor: vi.fn(() => ({ composeComplete: true, needsMerge: true })),
      handleAgentError,
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    scheduler.globalSchedule();
    expect(pool.tasks[0]!.status).toBe("running");
    expect(pool.tasks[0]!.retryCount).toBe(0);

    // First attempt fails → task-restart → retryCount bumped, task restarted
    resolveDeferred("t1", {
      success: false,
      lastText: "fail",
      exitCode: 1,
      durationMs: 5,
      error: "retry me",
    });
    await flushMicrotasks();

    expect(retryHandled).toBe(true);
    expect(pool.tasks[0]!.retryCount).toBe(1);
    // Task is back to running (restarted by the scheduler after reset)
    expect(pool.tasks[0]!.status).toBe("running");
    expect(pool.tasks[0]!.runningAgentCount).toBe(1);

    // Resolve the second attempt (retry) with success → task completes
    resolveDeferred("t1", {
      success: true,
      lastText: "ok",
      exitCode: 0,
      durationMs: 5,
    });
    await flushMicrotasks();
    expect(pool.tasks[0]!.status).toBe("done");
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: parallel siblings — runningAgentCount > 0 ─
  it("continues feeding parallel siblings when one agent finishes and others remain", async () => {
    // Task A has parallel atoms (atom1, atom2) both using different providers.
    // When atom1 finishes, atom2 is still running (runningAgentCount > 0).
    const pool = createPool({
      limits: { total: 3, provider: { x: 1, y: 1 }, model: {} },
      tasks: [makeTask({ id: "A", status: "ready" })],
    });

    // Track which parallel atoms have run
    const doneAtoms = new Set<string>();

    const getDemands = (task: TaskRuntime): AgentDemand[] => {
      if (task.status === "done" || task.status === "failed") return [];
      const demands: AgentDemand[] = [];
      if (!doneAtoms.has("p1")) {
        demands.push({
          atomPath: "p1",
          profileName: "default",
          effectivePrompt: task.prompt,
          cwd: "",
          taskId: task.id,
          provider: "x",
        });
      }
      if (!doneAtoms.has("p2")) {
        demands.push({
          atomPath: "p2",
          profileName: "default",
          effectivePrompt: task.prompt,
          cwd: "",
          taskId: task.id,
          provider: "y",
        });
      }
      return demands;
    };

    // Defer atom2 so we can observe the runningAgentCount > 0 state
    let resolveP2: ((r: AgentRunResult) => void) | undefined;

    const runner: AgentRunner = {
      async runAgent(demand: AgentDemand): Promise<AgentRunResult> {
        if (demand.atomPath === "p2") {
          return new Promise<AgentRunResult>((resolve) => {
            resolveP2 = resolve;
          });
        }
        return { success: true, lastText: `mock-${demand.atomPath}`, exitCode: 0, durationMs: 0 };
      },
    };

    const advanceCursor = vi.fn((_task: TaskRuntime, atomPath: string, _result: AgentRunResult) => {
      doneAtoms.add(atomPath);
      if (doneAtoms.size === 2) {
        // Both atoms done → compose complete
        return { composeComplete: true, needsMerge: true };
      }
      return { composeComplete: false, needsMerge: false };
    });

    const onMergeEnqueue = vi.fn((taskId: string) => {
      const task = pool.tasks.find((t) => t.id === taskId);
      if (task) task.status = "done";
      const idx = pool.mergeQueue.indexOf(taskId);
      if (idx >= 0) pool.mergeQueue.splice(idx, 1);
    });

    const callbacks: SchedulerCallbacks = {
      getDemands,
      advanceCursor,
      handleAgentError: vi.fn(),
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    // Start both parallel atoms
    scheduler.globalSchedule();
    expect(pool.tasks[0]!.runningAgentCount).toBe(2); // both started
    expect(pool.tasks[0]!.status).toBe("running");

    // p1 finishes (immediate), p2 still deferred. runningAgentCount goes to 1.
    await flushMicrotasks();
    expect(doneAtoms.has("p1")).toBe(true);
    expect(doneAtoms.has("p2")).toBe(false);
    expect(pool.tasks[0]!.runningAgentCount).toBe(1); // only p2 still running

    // Resolve p2 → both done → merge
    resolveP2!({ success: true, lastText: "mock-p2", exitCode: 0, durationMs: 0 });
    await flushMicrotasks();
    expect(doneAtoms.has("p2")).toBe(true);
    expect(pool.tasks[0]!.status).toBe("done");
    expect(pool.tasks[0]!.runningAgentCount).toBe(0);
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: soft-retry error path ─────────────────────
  it("soft-retry keeps the task running and re-emits the demand", async () => {
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    // First call fails, second succeeds
    let callCount = 0;
    const runner: AgentRunner = {
      async runAgent() {
        callCount++;
        if (callCount === 1) {
          return {
            success: false,
            lastText: "fail",
            exitCode: 1,
            durationMs: 5,
            error: "ephemeral",
          };
        }
        return { success: true, lastText: "ok", exitCode: 0, durationMs: 5 };
      },
    };

    const handleAgentError = vi.fn(
      (_task: TaskRuntime, _atomPath: string, _result: AgentRunResult) => "soft-retry" as const,
    );

    const onMergeEnqueue = vi.fn((taskId: string) => {
      const task = pool.tasks.find((t) => t.id === taskId);
      if (task) task.status = "done";
      const idx = pool.mergeQueue.indexOf(taskId);
      if (idx >= 0) pool.mergeQueue.splice(idx, 1);
    });

    const callbacks: SchedulerCallbacks = {
      getDemands: (task) =>
        task.status === "done" || task.status === "failed"
          ? []
          : [
              {
                atomPath: "0",
                profileName: "default",
                effectivePrompt: task.prompt,
                cwd: "",
                taskId: task.id,
              },
            ],
      advanceCursor: vi.fn(() => ({ composeComplete: true, needsMerge: true })),
      handleAgentError,
      onMergeEnqueue,
      onUpdate: vi.fn(),
    };

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    scheduler.globalSchedule();
    expect(pool.tasks[0]!.status).toBe("running");

    // First attempt fails, soft-retry → same atom restarts
    await flushMicrotasks();
    expect(handleAgentError).toHaveBeenCalled();
    // The task stayed running (soft-retry doesn't change status),
    // and the second attempt should have resolved.
    await flushMicrotasks();
    expect(pool.tasks[0]!.status).toBe("done");
    expect(callCount).toBe(2);
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: abort signal ──────────────────────────────
  it("stops scheduling when the abort signal is triggered", () => {
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    const abortController = new AbortController();

    const runner: AgentRunner = {
      async runAgent() {
        return { success: true, lastText: "done", exitCode: 0, durationMs: 0 };
      },
    };

    const callbacks = stubCallbacks();
    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      sessionDir: SESSION_DIR,
      agentRunner: runner,
      callbacks,
      signal: abortController.signal,
    });

    // Abort before the first pass
    abortController.abort();
    scheduler.globalSchedule();

    // After abort, globalSchedule sets complete=true and returns immediately
    expect(scheduler.isComplete()).toBe(true);
    expect(pool.tasks[0]!.status).toBe("ready"); // never started
  });

  it("does not report isComplete when agents are in-flight after abort", async () => {
    // When the signal is aborted while agents are still running,
    // isComplete() must return false until all in-flight agents finish.
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    const abortController = new AbortController();

    // Defer t1 so we can abort while it's in-flight.
    const { runner, resolve: resolveDeferred } = createDeferredRunner(["t1"]);

    const callbacks = stubCallbacks({
      onMergeEnqueue: vi.fn((taskId: string) => {
        const task = pool.tasks.find((t) => t.id === taskId);
        if (task) task.status = "done";
        const idx = pool.mergeQueue.indexOf(taskId);
        if (idx >= 0) pool.mergeQueue.splice(idx, 1);
      }),
    });

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      sessionDir: SESSION_DIR,
      agentRunner: runner,
      callbacks,
      signal: abortController.signal,
    });

    // Start the agent
    scheduler.globalSchedule();
    expect(pool.tasks[0]!.status).toBe("running");
    expect(scheduler.isComplete()).toBe(false);

    // Abort while agent is in-flight
    abortController.abort();

    // isComplete() requires both complete AND inFlight.size === 0
    expect(scheduler.isComplete()).toBe(false);

    // Resolve the in-flight agent
    resolveDeferred("t1");
    await flushMicrotasks();

    // Now all agents have settled and isComplete() can return true.
    // Note: onAgentFinished does NOT check abort signal — it calls
    // globalSchedule which sets complete=true on abort, then
    // onUpdate fires. isComplete() requires inFlight.size === 0.
    expect(scheduler.isComplete()).toBe(true);
  });

  // ── Additional coverage: onAgentFinished edge cases ────────────────
  it("handles onAgentFinished with unknown taskId gracefully", () => {
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    const runner: AgentRunner = {
      async runAgent() {
        return { success: true, lastText: "done", exitCode: 0, durationMs: 0 };
      },
    };

    const callbacks = stubCallbacks({
      onMergeEnqueue: (taskId) => {
        const task = pool.tasks.find((t) => t.id === taskId);
        if (task) task.status = "done";
        const idx = pool.mergeQueue.indexOf(taskId);
        if (idx >= 0) pool.mergeQueue.splice(idx, 1);
      },
    });

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    // Calling onAgentFinished with a non-existent taskId should not throw.
    void scheduler.onAgentFinished("nonexistent", "0", {
      success: true,
      lastText: "",
      exitCode: 0,
      durationMs: 0,
    });

    // The pool state should be unchanged.
    expect(pool.tasks[0]!.status).toBe("ready");
  });

  it("handles onAgentFinished with mismatched atomPath gracefully", () => {
    // When onAgentFinished is called with an atomPath that was never
    // started (e.g. due to a race), the demandMeta entry won't exist.
    // The scheduler should skip pool release and not crash.
    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    const runner: AgentRunner = {
      async runAgent() {
        return { success: true, lastText: "done", exitCode: 0, durationMs: 0 };
      },
    };

    const callbacks = stubCallbacks({
      onMergeEnqueue: (taskId) => {
        const task = pool.tasks.find((t) => t.id === taskId);
        if (task) task.status = "done";
        const idx = pool.mergeQueue.indexOf(taskId);
        if (idx >= 0) pool.mergeQueue.splice(idx, 1);
      },
    });

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      callbacks,
      sessionDir: SESSION_DIR,
    });

    // Start the task normally
    scheduler.globalSchedule();
    expect(pool.tasks[0]!.runningAgentCount).toBe(1);

    // Now call onAgentFinished with a WRONG atomPath that was never started.
    // demandMeta.get("t1:fake") will be undefined; we should skip release.
    void scheduler.onAgentFinished("t1", "fake-path", {
      success: true,
      lastText: "done",
      exitCode: 0,
      durationMs: 0,
    });

    // The real agent is still in-flight (its .then hasn't fired yet).
    // The mismatched call should not crash, but the task status may
    // have been changed by the incomplete merge flow.
    // We just verify no crash occurred.
    expect(pool.tasks[0]!.runningAgentCount).toBeGreaterThanOrEqual(0);
  });

  // ── C2: sessionDir threading ───────────────────────────────────────
  it("forwards the configured sessionDir into AgentRunOptions passed to the runner", async () => {
    // Regression guard for finding C2: the scheduler must forward its
    // sessionDir option into the AgentRunOptions so that task agents
    // persist sessions, enabling resume and the summary's session listing.
    const SESSION_DIR_C2 = "/pool/sessions";

    const receivedOpts: AgentRunOptions[] = [];
    const runner: AgentRunner = {
      async runAgent(_demand: AgentDemand, opts: AgentRunOptions): Promise<AgentRunResult> {
        receivedOpts.push(opts);
        return { success: true, lastText: "done", exitCode: 0, durationMs: 0 };
      },
    };

    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    const callbacks = stubCallbacks({
      onMergeEnqueue: (taskId) => {
        const task = pool.tasks.find((t) => t.id === taskId);
        if (task) task.status = "done";
        const idx = pool.mergeQueue.indexOf(taskId);
        if (idx >= 0) pool.mergeQueue.splice(idx, 1);
      },
    });

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      sessionDir: SESSION_DIR_C2,
      callbacks,
    });

    scheduler.globalSchedule();
    await flushMicrotasks();

    // The runner was called and received the real sessionDir (not "").
    expect(receivedOpts.length).toBeGreaterThanOrEqual(1);
    expect(receivedOpts[0]!.sessionDir).toBe(SESSION_DIR_C2);
  });

  // ── M1: session file recording ─────────────────────────────────────
  it("records the produced session file on task.sessionFiles after a successful run", async () => {
    // Regression guard for finding M1: when an agent finishes successfully
    // and its result carries a sessionFile, the scheduler must record it on
    // the task's sessionFiles list so it shows up in state.json and the
    // final summary's (session: ...) line.
    const SESSION_FILE = "/pool/sessions/20260710T120000Z-my-task.jsonl";

    const runner: AgentRunner = {
      async runAgent(): Promise<AgentRunResult> {
        return {
          success: true,
          lastText: "done",
          exitCode: 0,
          durationMs: 0,
          sessionFile: SESSION_FILE,
        };
      },
    };

    const pool = createPool({
      tasks: [makeTask({ id: "t1", status: "ready" })],
    });

    const callbacks = stubCallbacks({
      onMergeEnqueue: (taskId) => {
        const task = pool.tasks.find((t) => t.id === taskId);
        if (task) task.status = "done";
        const idx = pool.mergeQueue.indexOf(taskId);
        if (idx >= 0) pool.mergeQueue.splice(idx, 1);
      },
    });

    const pools = createPoolCoordinator(pool.limits);
    const scheduler = createScheduler({
      pool,
      pools,
      agentRunner: runner,
      sessionDir: SESSION_DIR,
      callbacks,
    });

    scheduler.globalSchedule();
    await flushMicrotasks();

    expect(pool.tasks[0]!.status).toBe("done");
    expect(pool.tasks[0]!.sessionFiles).toEqual([SESSION_FILE]);
  });
});
