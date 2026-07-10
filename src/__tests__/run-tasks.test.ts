/**
 * Integration tests for the run_tasks tool (§6, §7, §14).
 *
 * Tests mock git, worktree, and agent-runner dependencies so that the
 * wiring, validation, error handling, and result flow can be verified
 * without a real git repo or agent subprocesses.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";

import type { PoolState } from "../types";

// ── Module-level mocks ─────────────────────────────────────────────────────

vi.mock("../scheduler", () => ({
  createComposeScheduler: vi.fn(),
}));

vi.mock("../pools", () => ({
  createPoolCoordinator: vi.fn(),
}));

vi.mock("../merge", () => ({
  createMergeWorker: vi.fn(),
}));

vi.mock("../state", () => ({
  writeState: vi.fn(),
  readState: vi.fn(),
  appendPoolHint: vi.fn(),
  createPoolDirs: vi.fn(),
  listPools: vi.fn(),
  reconcilePoolOnResume: vi.fn(),
  AuditLogger: vi.fn(),
}));

vi.mock("../worktrees", () => ({
  createPoolWorktree: vi.fn(),
  createTaskWorktree: vi.fn(),
  ensureExcludeEntry: vi.fn(),
  isGitRepo: vi.fn(),
  canUseWorktrees: vi.fn(),
  verifyWorktrees: vi.fn(),
}));

vi.mock("../profiles", () => ({
  seedMergeHelperProfile: vi.fn(),
}));

vi.mock("tree-kill", () => ({
  default: vi.fn(),
}));

// ── Imports after mocks ────────────────────────────────────────────────────

import { createRunTasksTool } from "../run-tasks";
import type { CreateRunTasksToolOptions } from "../run-tasks";

import * as schedulerModule from "../scheduler";
import * as poolsModule from "../pools";
import * as mergeModule from "../merge";
import * as stateModule from "../state";
import * as worktreesModule from "../worktrees";
import * as profilesModule from "../profiles";

// ── Shared test values ─────────────────────────────────────────────────────

const MINIMAL_POOL_STATE: PoolState = {
  id: "my-pool",
  name: "My Pool",
  branch: "pi-task-pool/my-pool",
  poolWorktree: "/test/repo/.pi/task-pools/my-pool/worktrees/pool",
  baseBranch: "main",
  limits: { total: 4, provider: {}, model: {} },
  maxRetries: 2,
  createdAt: 1000,
  updatedAt: 1000,
  status: "running",
  tasks: [],
  mergeQueue: [],
};

// ── Mock factory helpers ───────────────────────────────────────────────────

function createMockScheduler() {
  let completed = false;

  return {
    globalSchedule: vi.fn(() => {
      completed = true;
    }),
    onAgentFinished: vi.fn(),
    ensureWorktrees: vi.fn(async () => {}),
    isComplete: vi.fn(() => completed),
    mergeComplete: vi.fn(() => {
      completed = true;
    }),
  };
}

function createMockMergeWorker() {
  let inProgress = false;

  return {
    enqueue: vi.fn(),
    processNext: vi.fn(async () => {
      inProgress = true;
      inProgress = false;
    }),
    getInProgress: vi.fn(() => inProgress),
  };
}

function createMockPoolCoordinator() {
  return {
    tryAcquire: vi.fn(() => true),
    release: vi.fn(),
    hasRoom: vi.fn(() => true),
    usage: vi.fn(() => ({
      total: { used: 0, cap: 4 },
      provider: {},
      model: {},
    })),
    wakeWaiters: vi.fn(),
  };
}

// ── Mock context ───────────────────────────────────────────────────────────

function createMockContext(cwd = "/test/repo") {
  return {
    cwd,
    mode: "tui",
    model: undefined,
    signal: undefined,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setToolsExpanded: vi.fn(),
      getToolsExpanded: vi.fn(() => false),
    },
    hasUI: false,
    sessionManager: {
      getBranch: vi.fn(() => []),
      getEntries: vi.fn(() => []),
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
}

// ── Tool factory helper ────────────────────────────────────────────────────

function createToolWithMocks() {
  const agentRunner = {
    runAgent: vi.fn().mockResolvedValue({
      success: true,
      lastText: "mock-output",
      exitCode: 0,
      durationMs: 0,
    }),
  };

  const gitOps = {
    gitExec: vi.fn(),
    lock: vi.fn(<T>(fn: () => Promise<T>) => fn()),
    statusPorcelain: vi.fn().mockResolvedValue(""),
    conflictedFiles: vi.fn().mockResolvedValue([]),
    worktreeList: vi.fn().mockResolvedValue([]),
    revParseHead: vi.fn().mockResolvedValue("abc123def"),
    worktreeAdd: vi.fn(),
    worktreeRemove: vi.fn(),
    worktreePrune: vi.fn(),
    branchDelete: vi.fn(),
    mergeFF: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    mergeAbort: vi.fn(),
    commitAll: vi.fn(),
  } as unknown as import("../git-op").GitOps;

  const childProcesses = new Set<import("node:child_process").ChildProcess>();

  const opts: CreateRunTasksToolOptions = {
    getAgentRunner: () => agentRunner,
    getGitOps: () => gitOps,
    childProcesses,
  };

  const pi = {
    registerTool: vi.fn(),
    on: vi.fn(),
    exec: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

  const tool = createRunTasksTool(pi, opts);

  return { tool, agentRunner, gitOps, childProcesses, pi, opts };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("run_tasks tool", () => {
  let tool: ReturnType<typeof createRunTasksTool>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations that make the CREATE path succeed.
    (schedulerModule.createComposeScheduler as ReturnType<typeof vi.fn>).mockReturnValue(
      createMockScheduler(),
    );

    (poolsModule.createPoolCoordinator as ReturnType<typeof vi.fn>).mockReturnValue(
      createMockPoolCoordinator(),
    );

    (mergeModule.createMergeWorker as ReturnType<typeof vi.fn>).mockReturnValue(
      createMockMergeWorker(),
    );

    // State mocks
    (stateModule.listPools as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (stateModule.readState as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (stateModule.AuditLogger as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function () {
        return {
          log: vi.fn(),
          poolCreated: vi.fn(),
          poolResumed: vi.fn(),
          poolCompleted: vi.fn(),
          worktreeMerged: vi.fn(),
          close: vi.fn(),
        };
      },
    );

    // Worktree mocks
    (worktreesModule.isGitRepo as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (worktreesModule.canUseWorktrees as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (worktreesModule.createPoolWorktree as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: "/mock/pool-worktree",
      branch: "pi-task-pool/my-pool",
    });
    (worktreesModule.createTaskWorktree as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: "/mock/task-worktree",
      branch: "pi-task-pool/my-pool/t-1",
    });

    // Build tool with mocks.
    const context = createToolWithMocks();
    tool = context.tool;
  });

  // ── Test 1: CREATE valid ──────────────────────────────────────────────
  it("CREATES a pool with 3 dependent tasks and resolves with all-done summary", async () => {
    const ctx = createMockContext();

    const result = await tool.execute(
      "call-1",
      {
        name: "My Pool",
        tasks: [
          { id: "plan", prompt: "Plan the project" },
          { id: "tests", prompt: "Write tests", dependsOn: ["plan"] },
          { id: "code", prompt: "Write code", dependsOn: ["tests"] },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content).toHaveLength(1);
    const content0 = result.content[0] as { text?: string } | undefined;
    const text = content0?.text ?? "";

    expect(text).toContain("Pool: My Pool");
    expect(text).toContain("id: my-pool");

    // Pipeline: worktree creation, pool creation, etc. were called.
    expect(worktreesModule.isGitRepo).toHaveBeenCalled();
    expect(worktreesModule.canUseWorktrees).toHaveBeenCalled();
    expect(worktreesModule.createPoolWorktree).toHaveBeenCalled();
    // H1: task worktrees are created lazily via ensureWorktrees() during
    // the run loop, not eagerly during CREATE. The mocked scheduler's
    // ensureWorktrees is a no-op, so createTaskWorktree is NOT called
    // here. Lazy creation is covered by scheduler-core / integration tests.
    expect(worktreesModule.ensureExcludeEntry).toHaveBeenCalled();
    expect(stateModule.writeState).toHaveBeenCalled();
    expect(schedulerModule.createComposeScheduler).toHaveBeenCalled();
    expect(mergeModule.createMergeWorker).toHaveBeenCalled();
    expect(profilesModule.seedMergeHelperProfile).toHaveBeenCalled();
  });

  // ── Test 2: Duplicate pool id ───────────────────────────────────────
  it("throws when a pool with the same slugified id already exists", async () => {
    (stateModule.listPools as ReturnType<typeof vi.fn>).mockReturnValue(["my-pool"]);
    const ctx = createMockContext();

    await expect(
      tool.execute(
        "call-2",
        {
          name: "My Pool",
          tasks: [{ prompt: "A task" }],
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/already exists/);
  });

  // ── Test 3: Non-git repo ────────────────────────────────────────────
  it("throws when the cwd is not a git repository", async () => {
    (worktreesModule.isGitRepo as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const ctx = createMockContext();

    await expect(
      tool.execute(
        "call-3",
        {
          name: "Test Pool",
          tasks: [{ prompt: "A task" }],
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/not a git repository/i);
  });

  // ── Test 4: Cycle detection ─────────────────────────────────────────
  it("throws when tasks form a dependency cycle", async () => {
    const ctx = createMockContext();

    await expect(
      tool.execute(
        "call-4",
        {
          name: "Cyclic Pool",
          tasks: [
            { id: "a", prompt: "A", dependsOn: ["b"] },
            { id: "b", prompt: "B", dependsOn: ["c"] },
            { id: "c", prompt: "C", dependsOn: ["a"] },
          ],
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/dependency cycle/i);
  });

  // ── Test 5: Empty prompt ────────────────────────────────────────────
  it("throws when a task has an empty prompt", async () => {
    const ctx = createMockContext();

    await expect(
      tool.execute(
        "call-5",
        {
          name: "Test Pool",
          tasks: [{ prompt: "Good prompt" }, { prompt: "" }],
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/empty.*prompt/i);
  });

  // ── Test 6: RESUME path ─────────────────────────────────────────────
  it("RESUMEs an existing pool from saved state", async () => {
    const savedState: PoolState = {
      ...MINIMAL_POOL_STATE,
      tasks: [
        {
          id: "t-1",
          title: undefined,
          prompt: "Do the thing",
          profile: undefined,
          dependsOn: [],
          compose: { type: "agent" },
          cursor: { kind: "agent" as const, path: "0", state: "pending" as const },
          status: "running" as const,
          retryCount: 0,
          runningAgentCount: 0,
          worktreePath: null,
          branch: null,
          sessionFiles: [],
          downstreamCount: 0,
          lastError: undefined,
          startedAt: undefined,
        },
      ],
      mergeQueue: [],
    };

    (stateModule.readState as ReturnType<typeof vi.fn>).mockReturnValue(savedState);
    (stateModule.reconcilePoolOnResume as ReturnType<typeof vi.fn>).mockResolvedValue({
      pool: savedState,
      missingWorktrees: [],
    });

    const ctx = createMockContext();
    const result = await tool.execute("call-6", { resume: "my-pool" }, undefined, undefined, ctx);

    expect(stateModule.readState).toHaveBeenCalled();
    expect(stateModule.reconcilePoolOnResume).toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
    const content0 = result.content[0] as { text?: string } | undefined;
    expect(content0?.text ?? "").toContain("Pool: My Pool");
  });

  // ── Test 7: ABORT signal ────────────────────────────────────────────
  it("handles an aborted signal and resolves with partial summary", async () => {
    const ac = new AbortController();
    ac.abort();

    const ctx = createMockContext();
    const result = await tool.execute(
      "call-7",
      { name: "Abort Test", tasks: [{ prompt: "Run this task" }] },
      ac.signal,
      undefined,
      ctx,
    );

    expect(result.content).toHaveLength(1);
    const content0 = result.content[0] as { text?: string } | undefined;
    expect(content0?.text ?? "").toContain("Pool: Abort Test");
  });

  // ── Test 7b: CREATE with onUpdate callback ────────────────────────────
  it("accepts an onUpdate callback for live board updates", async () => {
    const ctx = createMockContext();
    const onUpdate = vi.fn();

    const result = await tool.execute(
      "call-7b",
      { name: "Update Test", tasks: [{ prompt: "A task" }] },
      undefined,
      onUpdate,
      ctx,
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toBeDefined();
    // The interval is set up but may not fire before the scheduler
    // completes. The important thing is that execute doesn't throw.
  });

  // ── Test 7b2: Fake timers to exercise interval callback ────────────────
  it("exercises the interval callback with onUpdate", async () => {
    vi.useFakeTimers();

    // Use a delayed scheduler mock so the wait loop runs long enough
    // for the interval to fire.
    let schedulerCompleted = false;
    const delayedMock = {
      globalSchedule: vi.fn(() => {
        // Schedule completion in 2 seconds
        setTimeout(() => {
          schedulerCompleted = true;
        }, 2000);
      }),
      onAgentFinished: vi.fn(),
      ensureWorktrees: vi.fn(async () => {}),
      isComplete: vi.fn(() => schedulerCompleted),
      mergeComplete: vi.fn(),
    };
    (schedulerModule.createComposeScheduler as ReturnType<typeof vi.fn>).mockReturnValue(
      delayedMock,
    );

    // Rebuild tool with new mocks.
    const context = createToolWithMocks();
    tool = context.tool;

    const ctx = createMockContext();
    const onUpdate = vi.fn();

    const promise = tool.execute(
      "call-7b2",
      { name: "Delayed Pool", tasks: [{ prompt: "A task" }] },
      undefined,
      onUpdate,
      ctx,
    );

    // Advance past the 1s interval tick (the callback should fire).
    await vi.advanceTimersByTimeAsync(1100);

    // The update callback should have been called at least once.
    expect(onUpdate).toHaveBeenCalled();

    // Now advance past the scheduler completion (2s).
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.content).toHaveLength(1);

    vi.useRealTimers();
  });

  // ── Test 7c: Resume non-existent pool ───────────────────────────────
  it("throws when resuming a non-existent pool", async () => {
    (stateModule.readState as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const ctx = createMockContext();

    await expect(
      tool.execute("call-7c", { resume: "ghost-pool" }, undefined, undefined, ctx),
    ).rejects.toThrow(/not found/i);
  });

  // ── Test 8: renderResult ────────────────────────────────────────────
  it("renderResult returns a component for final (non-partial) results", async () => {
    const theme = {
      fg: vi.fn((_c: string, text: string) => text),
      bold: vi.fn((t: string) => t),
    } as unknown as Theme;

    const result = {
      content: [{ type: "text" as const, text: "Pool: Test\nTasks: 1 done" }],
      details: {
        poolId: "test",
        counts: { done: 1, failed: 0, skipped: 0 },
      },
    };

    const toolAny = tool as unknown as Record<string, unknown>;
    const component = toolAny.renderResult as (
      result: unknown,
      options: unknown,
      theme: unknown,
      context?: unknown,
    ) => unknown;
    const rendered = component(result, { isPartial: false, expanded: false }, theme);

    expect(rendered).toBeDefined();
    expect(typeof rendered).toBe("object");
  });

  it("renderResult returns a board for partial results with board data", async () => {
    const theme = {
      fg: vi.fn((_c: string, text: string) => text),
      bold: vi.fn((t: string) => t),
    } as unknown as Theme;

    const result = {
      content: [{ type: "text" as const, text: "in progress..." }],
      details: {
        poolId: "test",
        board: {
          ...MINIMAL_POOL_STATE,
          tasks: [
            {
              id: "t-1",
              title: undefined,
              prompt: "do it",
              profile: undefined,
              dependsOn: [],
              compose: { type: "agent" as const },
              cursor: { kind: "agent" as const, path: "0", state: "pending" as const },
              status: "running" as const,
              retryCount: 0,
              runningAgentCount: 0,
              worktreePath: null,
              branch: null,
              sessionFiles: [],
              downstreamCount: 0,
              lastError: undefined,
              startedAt: undefined,
            },
          ],
        },
        poolsUsage: { total: { used: 1, cap: 4 }, provider: {}, model: {} },
        mergeInProgress: false,
      },
    };

    const toolAny = tool as unknown as Record<string, unknown>;
    const component = toolAny.renderResult as (
      result: unknown,
      options: unknown,
      theme: unknown,
      context?: unknown,
    ) => unknown;
    const rendered = component(result, { isPartial: true, expanded: false }, theme);

    expect(rendered).toBeDefined();
    expect(typeof rendered).toBe("object");
  });

  // ── Test 9: CREATE/RESUME mutual exclusion ──────────────────────────
  it("throws when both resume and name/tasks are provided", async () => {
    const ctx = createMockContext();

    await expect(
      tool.execute(
        "call-9",
        {
          name: "Test",
          tasks: [{ prompt: "A" }],
          resume: "existing",
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/mutually exclusive/i);
  });

  // ── Test 10: Missing name for CREATE ────────────────────────────────
  it("throws when name is missing for CREATE", async () => {
    const ctx = createMockContext();

    await expect(
      tool.execute("call-10", { tasks: [{ prompt: "A" }] }, undefined, undefined, ctx),
    ).rejects.toThrow(/'name' is required/i);
  });

  // ── Test 11: Empty tasks array ──────────────────────────────────────
  it("throws when tasks array is empty", async () => {
    const ctx = createMockContext();

    await expect(
      tool.execute("call-11", { name: "Empty Pool", tasks: [] }, undefined, undefined, ctx),
    ).rejects.toThrow(/non-empty array/i);
  });

  // ── Test 12: limits validation ───────────────────────────────────────
  it("throws when limits.total is <= 0", async () => {
    const ctx = createMockContext();

    await expect(
      tool.execute(
        "call-12a",
        { name: "Bad Limits", tasks: [{ prompt: "A" }], limits: { total: 0 } },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/'limits.total' must be > 0/i);
  });

  it("throws when limits.total is > 32", async () => {
    const ctx = createMockContext();

    await expect(
      tool.execute(
        "call-12b",
        { name: "Bad Limits", tasks: [{ prompt: "A" }], limits: { total: 33 } },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/limits.total.*<= 32/i);
  });

  it("throws when maxRetries is > 10", async () => {
    const ctx = createMockContext();

    await expect(
      tool.execute(
        "call-12c",
        { name: "Bad Retries", tasks: [{ prompt: "A" }], maxRetries: 11 },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/maxRetries.*<= 10/i);
  });

  // ── Test 13: Git worktrees not supported ─────────────────────────────
  it("throws when worktrees are not supported", async () => {
    (worktreesModule.canUseWorktrees as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const ctx = createMockContext();

    await expect(
      tool.execute(
        "call-13",
        { name: "No WT", tasks: [{ prompt: "A" }] },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/not supported/i);
  });

  // ── Test 14: Limits with provider ────────────────────────────────────
  it("accepts optional limits with provider caps", async () => {
    const ctx = createMockContext();

    const result = await tool.execute(
      "call-14",
      {
        name: "Provider Limits",
        tasks: [{ prompt: "A task" }],
        limits: { total: 2, provider: { anthropic: 1 }, model: { "anthropic/claude": 1 } },
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toBeDefined();
  });

  // ── Test 15: resume with missing worktrees ──────────────────────────
  it("resume with missing worktrees recreates them", async () => {
    const savedState: PoolState = {
      ...MINIMAL_POOL_STATE,
      tasks: [
        {
          id: "t-1",
          title: undefined,
          prompt: "Do the thing",
          profile: undefined,
          dependsOn: [],
          compose: { type: "agent" },
          cursor: { kind: "agent" as const, path: "0", state: "pending" as const },
          status: "parked" as const,
          retryCount: 0,
          runningAgentCount: 0,
          worktreePath: "/old/path",
          branch: "old-branch",
          sessionFiles: [],
          downstreamCount: 0,
          lastError: undefined,
          startedAt: undefined,
        },
      ],
      mergeQueue: [],
    };

    (stateModule.readState as ReturnType<typeof vi.fn>).mockReturnValue(savedState);
    (stateModule.reconcilePoolOnResume as ReturnType<typeof vi.fn>).mockResolvedValue({
      pool: savedState,
      missingWorktrees: ["t-1"],
    });
    (worktreesModule.createTaskWorktree as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: "/new/task-worktree",
      branch: "pi-task-pool/my-pool/t-1",
    });

    const ctx = createMockContext();
    const result = await tool.execute("call-15", { resume: "my-pool" }, undefined, undefined, ctx);

    expect(stateModule.readState).toHaveBeenCalled();
    expect(stateModule.reconcilePoolOnResume).toHaveBeenCalled();
    expect(worktreesModule.createTaskWorktree).toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });

  // ── Test 16: Scheduler → merge-worker data flow ─────────────────────
  it("calls mergeWorker.processNext when onMergeEnqueue fires (CRITICAL hang fix)", async () => {
    // Capture the onMergeEnqueue callback that runPool passes to
    // createComposeScheduler so we can invoke it and verify the wiring.
    let capturedOnMergeEnqueue: ((taskId: string) => void) | undefined;

    (schedulerModule.createComposeScheduler as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, unknown>) => {
        capturedOnMergeEnqueue = opts.onMergeEnqueue as (taskId: string) => void;
        return createMockScheduler();
      },
    );

    const ctx = createMockContext();
    await tool.execute(
      "call-16",
      { name: "DataFlow Test", tasks: [{ prompt: "Test task" }] },
      undefined,
      undefined,
      ctx,
    );

    // The captured callback must be defined.
    expect(capturedOnMergeEnqueue).toBeDefined();

    // Retrieve the merge worker mock instance.
    const mergeWorkerInstance = (mergeModule.createMergeWorker as ReturnType<typeof vi.fn>).mock
      .results[0]?.value;
    expect(mergeWorkerInstance).toBeDefined();

    // Initially no calls.
    expect(mergeWorkerInstance.processNext).toHaveBeenCalledTimes(0);

    // Invoke the captured callback — this simulates the scheduler calling
    // onMergeEnqueue after a task completes.
    capturedOnMergeEnqueue!("t-1");

    // BUGFIX: onMergeEnqueue must call both enqueue (to push onto the
    // merge queue) AND processNext (to actually start the merge pipeline).
    expect(mergeWorkerInstance.enqueue).toHaveBeenCalledWith("t-1");
    expect(mergeWorkerInstance.processNext).toHaveBeenCalledTimes(1);
  });
});
