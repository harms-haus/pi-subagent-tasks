/**
 * Tests for the FIFO merge queue and merge-helper agent.
 *
 * Covers: FF success path, conflict → merge-helper spawn, resolved/unresolved
 * outcomes, serial queue semantics, dirty worktree handling, guard clauses,
 * and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the profiles module so merge.ts's resolveProfile("merge-helper", cwd)
// call is controllable per-test. Default returns an empty profile (no
// provider/model) so existing conflict tests are unaffected.
vi.mock("../profiles", () => ({
  seedMergeHelperProfile: vi.fn(),
  resolveProfile: vi.fn(() => ({})),
}));

import type { GitOps } from "../git-op";
import type {
  AgentRunner,
  AgentDemand,
  AgentRunOptions,
  AgentRunResult,
  TaskRuntime,
} from "../types";
import type { PoolCoordinator } from "../pools";
import type { MergeWorkerOptions } from "../merge";
import { createMergeWorker, HELPER_ACQUIRE_POLL_MS, HELPER_ACQUIRE_TIMEOUT_MS } from "../merge";
import { resolveProfile } from "../profiles";

// ── Mock factory: GitOps ─────────────────────────────────────────────────────

/**
 * Create a mock {@link GitOps} where every method is a `vi.fn()`.
 *
 * Default `mergeFF` returns code 0 (success). All ref-mutating methods
 * resolve to a default `ExecResult` (code 0). The `lock` implementation
 * simply calls `fn()` directly (no serialization — we test serialization
 * behaviour separately).
 */
function createMockGitOps(): GitOps {
  let chain = Promise.resolve() as Promise<unknown>;
  const lock: GitOps["lock"] = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    gitExec: vi.fn().mockResolvedValue({ stdout: "", stderr: "conflict", code: 1, killed: false }),
    lock,
    statusPorcelain: vi.fn().mockResolvedValue(""),
    conflictedFiles: vi.fn().mockResolvedValue([]),
    worktreeList: vi
      .fn()
      .mockResolvedValue([
        { path: "/repo", head: "aaa", branch: "refs/heads/main", branchName: "main" },
      ]),
    revParseHead: vi.fn().mockResolvedValue("merged-sha"),
    worktreeAdd: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    worktreeRemove: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    worktreePrune: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    branchDelete: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    mergeFF: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    mergeAbort: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    commitAll: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
  };
}

// ── Mock factory: PoolCoordinator ────────────────────────────────────────────

/**
 * Create a mock {@link PoolCoordinator} where every method is a `vi.fn()`.
 *
 * Default `tryAcquire` returns `true` (infinite capacity).
 */
function createMockPoolCoordinator(): PoolCoordinator {
  return {
    tryAcquire: vi.fn().mockReturnValue(true),
    release: vi.fn(),
    hasRoom: vi.fn().mockReturnValue(true),
    usage: vi.fn().mockReturnValue({
      total: { used: 0, cap: 4 },
      provider: {},
      model: {},
    }),
    wakeWaiters: vi.fn(),
  };
}

// ── Mock factory: AgentRunner ────────────────────────────────────────────────

/**
 * Create a mock {@link AgentRunner}. Every demand/opts pair is recorded in
 * `received` / `receivedOpts`. By default each run returns a successful result.
 * Tests override via `setResult` (per-atomPath) or `setResultFn` (global).
 */
interface MockAgentRunner extends AgentRunner {
  received: AgentDemand[];
  receivedOpts: AgentRunOptions[];
  setResult(atomPath: string, result: Partial<AgentRunResult>): void;
  setResultFn(fn: (demand: AgentDemand, opts: AgentRunOptions) => AgentRunResult): void;
}

function createMockAgentRunner(): MockAgentRunner {
  const received: AgentDemand[] = [];
  const receivedOpts: AgentRunOptions[] = [];
  const results = new Map<string, Partial<AgentRunResult>>();
  let fn: ((demand: AgentDemand, opts: AgentRunOptions) => AgentRunResult) | undefined;

  return {
    received,
    receivedOpts,
    setResult(atomPath, result) {
      results.set(atomPath, result);
    },
    setResultFn(next) {
      fn = next;
    },
    async runAgent(demand: AgentDemand, opts: AgentRunOptions): Promise<AgentRunResult> {
      received.push(demand);
      receivedOpts.push(opts);
      if (fn) return fn(demand, opts);
      const override = results.get(demand.atomPath);
      const base: AgentRunResult = {
        success: true,
        lastText: `mock-output-for-${demand.atomPath}`,
        exitCode: 0,
        durationMs: 0,
      };
      const merged: AgentRunResult = { ...base, ...override };
      if (override && override.success === false && override.exitCode === undefined) {
        merged.exitCode = 1;
      }
      return merged;
    },
  };
}

// ── Task factory ─────────────────────────────────────────────────────────────

/** Create a minimal TaskRuntime for testing. */
function makeTask(overrides?: Partial<TaskRuntime>): TaskRuntime {
  return {
    id: "t-1",
    title: "Test Task",
    prompt: "Do the thing",
    profile: undefined,
    dependsOn: [],
    compose: { type: "agent" },
    cursor: {
      kind: "agent",
      path: "",
      state: "done",
    },
    status: "running",
    retryCount: 0,
    runningAgentCount: 0,
    worktreePath: "/wt/t-1",
    branch: "pi-subagent-task/test/t-1",
    sessionFiles: [],
    downstreamCount: 0,
    ...overrides,
  };
}

// ── Option factory ───────────────────────────────────────────────────────────

interface MockBundle {
  git: GitOps;
  pools: PoolCoordinator;
  agentRunner: MockAgentRunner;
  onMerged: ReturnType<typeof vi.fn>;
  onFailed: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  opts: MergeWorkerOptions;
}

function createBundle(): MockBundle {
  const git = createMockGitOps();
  const pools = createMockPoolCoordinator();
  const agentRunner = createMockAgentRunner();
  const onMerged = vi.fn();
  const onFailed = vi.fn();
  const audit = vi.fn();
  const getTask = vi.fn<(taskId: string) => TaskRuntime | undefined>();

  const opts: MergeWorkerOptions = {
    git,
    poolWorktree: "/wt/pool",
    agentRunner,
    sessionDir: "/sessions",
    pools,
    poolId: "test-pool",
    cwd: "/repo",
    getTask,
    onMerged,
    onFailed,
    audit,
  };

  return { git, pools, agentRunner, onMerged, onFailed, audit, getTask, opts };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("enqueue / getInProgress", () => {
  it("enqueue adds to the queue but does not immediately process", () => {
    const { opts } = createBundle();
    const worker = createMergeWorker(opts);

    worker.enqueue("t-1");
    worker.enqueue("t-2");

    // Nothing processed yet — getInProgress is false
    expect(worker.getInProgress()).toBe(false);
    expect(opts.git.mergeFF).not.toHaveBeenCalled();
  });

  it("getInProgress returns true while a merge is processing", async () => {
    const { opts, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    // Make mergeFF slow so we can observe in-progress state
    let resolveMerge: () => void;
    opts.git.mergeFF = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveMerge = () => {
          resolve({ stdout: "", stderr: "", code: 0, killed: false });
        };
      }),
    );

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");

    const processPromise = worker.processNext();

    // Give microtask queue a chance to start the merge
    await vi.waitFor(() => {
      expect(opts.git.mergeFF).toHaveBeenCalled();
    });

    expect(worker.getInProgress()).toBe(true);

    resolveMerge!();
    await processPromise;

    expect(worker.getInProgress()).toBe(false);
  });
});

describe("processNext — guard clauses", () => {
  it("is a no-op when a merge is already in progress", async () => {
    const { opts, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    let resolveMerge: () => void;
    opts.git.mergeFF = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveMerge = () => {
          resolve({ stdout: "", stderr: "", code: 0, killed: false });
        };
      }),
    );

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    worker.enqueue("t-2");

    const first = worker.processNext();

    // Wait for the first merge to start
    await vi.waitFor(() => {
      expect(opts.git.mergeFF).toHaveBeenCalledTimes(1);
    });

    // Second call to processNext should be a no-op (merge already in progress)
    await worker.processNext();

    // mergeFF should still only have been called once
    expect(opts.git.mergeFF).toHaveBeenCalledTimes(1);

    resolveMerge!();
    await first;
  });

  it("is a no-op when the queue is empty", async () => {
    const { opts } = createBundle();
    const worker = createMergeWorker(opts);

    await worker.processNext();

    expect(worker.getInProgress()).toBe(false);
    expect(opts.git.mergeFF).not.toHaveBeenCalled();
  });

  it("skips task when getTask returns undefined", async () => {
    const { opts, audit, onFailed, getTask } = createBundle();
    getTask.mockReturnValue(undefined);

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    expect(audit).toHaveBeenCalledWith("merge_skipped", {
      taskId: "t-1",
      reason: "task not found",
    });
    // N2b: onFailed MUST be called (not a bare return) so the scheduler's
    // mergeComplete fires and accounting never sticks.
    expect(onFailed).toHaveBeenCalledWith("t-1", "task not found");
    expect(opts.git.mergeFF).not.toHaveBeenCalled();
  });

  it("skips task when worktreePath is null", async () => {
    const { opts, audit, onFailed, getTask } = createBundle();
    getTask.mockReturnValue(makeTask({ worktreePath: null }));

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    expect(audit).toHaveBeenCalledWith("merge_skipped", {
      taskId: "t-1",
      reason: "no worktree or branch",
    });
    // N2b: onFailed MUST fire so accounting never sticks.
    expect(onFailed).toHaveBeenCalledWith("t-1", "no worktree or branch");
    expect(opts.git.mergeFF).not.toHaveBeenCalled();
  });

  it("skips task when branch is null", async () => {
    const { opts, audit, onFailed, getTask } = createBundle();
    getTask.mockReturnValue(makeTask({ branch: null }));

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    expect(audit).toHaveBeenCalledWith("merge_skipped", {
      taskId: "t-1",
      reason: "no worktree or branch",
    });
    // N2b: onFailed MUST fire so accounting never sticks.
    expect(onFailed).toHaveBeenCalledWith("t-1", "no worktree or branch");
    expect(opts.git.mergeFF).not.toHaveBeenCalled();
  });
});

describe("FF success path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges, cleans up worktree, refreshes pool, and calls onMerged", async () => {
    const { opts, git, onMerged, audit, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    // FF merge was attempted
    expect(git.mergeFF).toHaveBeenCalledWith("pi-subagent-task/test/t-1", "/wt/pool");

    // Success path: audit merge, remove worktree, audit deletion, re-FF pool
    expect(audit).toHaveBeenCalledWith("worktree_merged", { taskId: "t-1" });
    expect(git.worktreeRemove).toHaveBeenCalledWith({
      path: "/wt/t-1",
      force: true,
      cwd: "/wt/pool",
    });
    expect(git.branchDelete).toHaveBeenCalledWith({
      name: "pi-subagent-task/test/t-1",
      force: true,
      cwd: "/wt/pool",
    });
    expect(git.worktreePrune).toHaveBeenCalledWith("/wt/pool");
    expect(audit).toHaveBeenCalledWith("worktree_deleted", { taskId: "t-1" });

    // Callback
    expect(onMerged).toHaveBeenCalledWith("t-1");
    expect(opts.onFailed).not.toHaveBeenCalled();
  });

  it("does not report merge success when required cleanup fails", async () => {
    const { opts, git, onMerged, onFailed, audit, getTask } = createBundle();
    getTask.mockReturnValue(makeTask());
    git.worktreeRemove = vi.fn().mockRejectedValue(new Error("cleanup failed"));

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    expect(git.branchDelete).not.toHaveBeenCalled();
    expect(git.worktreePrune).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalledWith("worktree_deleted", { taskId: "t-1" });
    expect(onMerged).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith("t-1", "cleanup failed");
  });

  it("does NOT auto-commit when worktree is clean", async () => {
    const { opts, git, getTask } = createBundle();
    getTask.mockReturnValue(makeTask());
    git.statusPorcelain = vi.fn().mockResolvedValue("");

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    expect(git.commitAll).not.toHaveBeenCalled();
  });

  it("handles processNext recursion via setTimeout correctly", async () => {
    const { opts, git, onMerged, getTask } = createBundle();
    const task1 = makeTask({
      id: "t-1",
      worktreePath: "/wt/t-1",
      branch: "pi-subagent-task/test/t-1",
    });
    const task2 = makeTask({
      id: "t-2",
      worktreePath: "/wt/t-2",
      branch: "pi-subagent-task/test/t-2",
    });
    getTask.mockImplementation((id: string) =>
      id === "t-1" ? task1 : id === "t-2" ? task2 : undefined,
    );

    // Make mergeFF resolve after a tick so recursion has time to schedule
    git.mergeFF = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    worker.enqueue("t-2");

    // Process the first one
    await worker.processNext();

    // After the first completes, the recursive setTimeout should trigger
    // the second. Advance timers to let the setTimeout fire.
    vi.advanceTimersByTime(0);

    // Wait for the second merge to complete
    // The second processNext runs via setTimeout recursion
    await vi.waitFor(() => {
      expect(onMerged).toHaveBeenCalledWith("t-2");
    });

    expect(onMerged).toHaveBeenCalledWith("t-1");
    expect(onMerged).toHaveBeenCalledWith("t-2");
    expect(git.mergeFF).toHaveBeenCalledTimes(2);
  });
});

describe("dirty worktree", () => {
  it("auto-commits before FF merge when worktree has uncommitted changes", async () => {
    const { opts, git, getTask } = createBundle();
    getTask.mockReturnValue(makeTask());
    git.statusPorcelain = vi.fn().mockResolvedValue(" M src/index.ts\n");

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    // commitAll should be called before mergeFF
    expect(git.commitAll).toHaveBeenCalledWith("WIP: auto-commit before merge", "/wt/t-1");
    expect(git.mergeFF).toHaveBeenCalled();
  });
});

describe("merge conflict — FF failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns merge-helper with conflict context and acquires pool slot", async () => {
    const { opts, git, pools, agentRunner, audit, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    // FF merge fails (code 1)
    git.mergeFF = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });
    git.conflictedFiles = vi.fn().mockResolvedValue(["src/file1.ts", "src/file2.ts"]);

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    // Audit merge conflict
    expect(audit).toHaveBeenCalledWith("merge_conflict", { taskId: "t-1" });

    // Pool slot acquired
    expect(pools.tryAcquire).toHaveBeenCalledWith(undefined, undefined);

    // Merge-helper agent spawned with correct demand
    expect(agentRunner.received).toHaveLength(1);
    const demand = agentRunner.received[0]!;
    expect(demand.atomPath).toBe("merge-t-1");
    expect(demand.profileName).toBe("merge-helper");
    expect(demand.cwd).toBe("/wt/pool");
    expect(demand.taskId).toBe("t-1");
    expect(demand.effectivePrompt).toContain("Task goal: Do the thing");
    expect(demand.effectivePrompt).toContain("src/file1.ts");
    expect(demand.effectivePrompt).toContain("Resolve the merge conflicts, stage, and commit.");

    // Pool slot released
    expect(pools.release).toHaveBeenCalledWith(undefined, undefined);
  });

  it("waits for a slot when the pool is full, then runs the helper once freed", async () => {
    const { opts, pools, agentRunner, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);
    opts.git.mergeFF = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });
    // First conflictedFiles call (guard) reports a conflict; the second
    // (post-helper) reports none so the merge resolves cleanly.
    opts.git.conflictedFiles = vi
      .fn()
      .mockResolvedValueOnce(["src/file1.ts"])
      .mockResolvedValueOnce([]);

    // Pool starts full; flips to available once a slot is released.
    let slotFree = false;
    pools.tryAcquire = vi.fn(() => slotFree);
    pools.release = vi.fn(() => {
      slotFree = true;
    });

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    const processPromise = worker.processNext();

    // Flush the pre-acquire work (status/mergeFF/conflicts). The acquire
    // loop has started, found no slot, and parked on its poll delay — the
    // helper must NOT have run yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(agentRunner.received).toHaveLength(0);

    // Another agent finishes and frees a slot.
    pools.release(undefined, undefined);

    // Advance past one poll delay → the loop re-checks, acquires, spawns.
    await vi.advanceTimersByTimeAsync(HELPER_ACQUIRE_POLL_MS);
    await vi.waitFor(() => {
      expect(agentRunner.received).toHaveLength(1);
    });

    await processPromise;

    // Slot was acquired (eventually) and released after the helper ran.
    expect(pools.release).toHaveBeenCalledWith(undefined, undefined);
  });

  it("treats a permanently-full pool as a merge failure once the wait bound elapses", async () => {
    const { opts, pools, agentRunner, onFailed, audit, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);
    opts.git.mergeFF = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });
    opts.git.conflictedFiles = vi.fn().mockResolvedValue(["src/file1.ts"]);

    // Pool stays full forever.
    pools.tryAcquire = vi.fn().mockReturnValue(false);

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    const processPromise = worker.processNext();

    // Advance past the entire wait bound — the loop gives up.
    await vi.advanceTimersByTimeAsync(HELPER_ACQUIRE_TIMEOUT_MS + HELPER_ACQUIRE_POLL_MS);

    await processPromise;

    // Helper never ran.
    expect(agentRunner.received).toHaveLength(0);
    // Merge aborted and reported as failed.
    expect(opts.git.mergeAbort).toHaveBeenCalledWith("/wt/pool");
    expect(audit).toHaveBeenCalledWith("merge_failed", {
      taskId: "t-1",
      reason: "merge-helper could not acquire a concurrency slot",
    });
    expect(onFailed).toHaveBeenCalledWith(
      "t-1",
      "merge-helper could not acquire a concurrency slot",
    );
  });

  it("helper resolves conflicts → merge_resolved → success path", async () => {
    const { opts, git, onMerged, audit, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    // FF merge fails
    git.mergeFF = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });
    // First call returns conflicts, second call (after helper) returns empty
    git.conflictedFiles = vi.fn().mockResolvedValueOnce(["src/file1.ts"]).mockResolvedValueOnce([]);

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    // Resolved audit
    expect(audit).toHaveBeenCalledWith("merge_resolved", { taskId: "t-1" });

    // Success path should follow (worktree removed + onMerged)
    expect(git.worktreeRemove).toHaveBeenCalled();
    expect(onMerged).toHaveBeenCalledWith("t-1");
    expect(git.mergeAbort).not.toHaveBeenCalled();
  });

  it("helper fails → mergeAbort + onFailed", async () => {
    const { opts, git, onFailed, audit, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    // FF merge fails
    git.mergeFF = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });
    // Both calls return conflicts (helper didn't resolve them)
    git.conflictedFiles = vi.fn().mockResolvedValue(["src/file1.ts"]);

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    // Merge aborted
    expect(git.mergeAbort).toHaveBeenCalledWith("/wt/pool");

    // Failed audit + callback
    expect(audit).toHaveBeenCalledWith("merge_failed", { taskId: "t-1" });
    expect(onFailed).toHaveBeenCalledWith("t-1", "merge-helper could not resolve conflicts");

    // Success path should NOT have been followed
    expect(git.worktreeRemove).not.toHaveBeenCalled();
  });

  it("releases pool slot and aborts merge when agentRunner throws", async () => {
    const { opts, git, pools, agentRunner, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);
    opts.git.mergeFF = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });
    opts.git.conflictedFiles = vi.fn().mockResolvedValue(["src/file1.ts"]);

    // Agent runner throws
    agentRunner.runAgent = vi.fn().mockRejectedValue(new Error("agent crashed"));

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    // Pool slot should still be released (finally block)
    expect(pools.release).toHaveBeenCalledWith(undefined, undefined);

    // mergeAbort should be called so the pool worktree isn't left with
    // MERGE_HEAD
    expect(git.mergeAbort).toHaveBeenCalledWith("/wt/pool");
  });

  it("FF failure falls back to a regular merge and succeeds without conflicts", async () => {
    const { opts, git, onMerged, onFailed, audit, agentRunner, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    git.mergeFF = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });
    git.gitExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    expect(git.gitExec).toHaveBeenCalledWith(
      ["merge", "--no-edit", "pi-subagent-task/test/t-1"],
      "/wt/pool",
    );
    expect(audit).toHaveBeenCalledWith("merge_fallback", { taskId: "t-1" });
    expect(audit).toHaveBeenCalledWith("worktree_merged", { taskId: "t-1" });
    expect(onMerged).toHaveBeenCalledWith("t-1");
    expect(onFailed).not.toHaveBeenCalled();
    expect(git.mergeAbort).not.toHaveBeenCalled();
    expect(agentRunner.received).toHaveLength(0);
  });

  // ── N7: merge-helper consumes its real provider/model slots ────────

  it("N7: acquires and releases the helper slot against the merge-helper profile's provider/model", async () => {
    const { opts, git, pools, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    // FF merge fails → conflict path
    git.mergeFF = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });
    git.conflictedFiles = vi.fn().mockResolvedValueOnce(["src/file1.ts"]).mockResolvedValueOnce([]);

    // The merge-helper profile declares a real provider + model.
    vi.mocked(resolveProfile).mockReturnValueOnce({
      provider: "anthropic",
      model: "claude-sonnet",
    });

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    // The slot was acquired against the helper's real provider/model (not
    // undefined/undefined), so provider/model caps are honoured (N7).
    expect(pools.tryAcquire).toHaveBeenCalledWith("anthropic", "claude-sonnet");
    // Acquire and release MUST stay symmetric so accounting doesn't drift.
    expect(pools.release).toHaveBeenCalledWith("anthropic", "claude-sonnet");
  });

  it("N7: falls back to total-only when the merge-helper profile can't be resolved", async () => {
    const { opts, git, pools, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    git.mergeFF = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });
    git.conflictedFiles = vi.fn().mockResolvedValueOnce(["src/file1.ts"]).mockResolvedValueOnce([]);

    // Profile resolution throws → falls back to (undefined, undefined).
    vi.mocked(resolveProfile).mockImplementationOnce(() => {
      throw new Error("profile not found");
    });

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    // Only the total pool is touched.
    expect(pools.tryAcquire).toHaveBeenCalledWith(undefined, undefined);
    expect(pools.release).toHaveBeenCalledWith(undefined, undefined);
  });
});

describe("serial queue behaviour", () => {
  it("processes tasks one at a time — second starts after first completes", async () => {
    const { opts, git, onMerged, getTask } = createBundle();

    const task1 = makeTask({
      id: "t-1",
      worktreePath: "/wt/t-1",
      branch: "pi-subagent-task/test/t-1",
    });
    const task2 = makeTask({
      id: "t-2",
      worktreePath: "/wt/t-2",
      branch: "pi-subagent-task/test/t-2",
    });

    // getTask returns the appropriate task based on id
    getTask.mockImplementation((id: string) =>
      id === "t-1" ? task1 : id === "t-2" ? task2 : undefined,
    );

    // Track call order for mergeFF
    const callOrder: string[] = [];
    git.mergeFF = vi.fn().mockImplementation((branch: string) => {
      callOrder.push(branch);
      return Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false });
    });

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    worker.enqueue("t-2");

    // Start processing — this should process t-1, then recursively process t-2
    await worker.processNext();

    // Advance timers for the recursive setTimeout
    vi.useFakeTimers();
    vi.advanceTimersByTime(0);
    vi.useRealTimers();

    await vi.waitFor(() => {
      expect(onMerged).toHaveBeenCalledWith("t-2");
    });

    // Both tasks should be processed
    expect(onMerged).toHaveBeenCalledWith("t-1");
    expect(onMerged).toHaveBeenCalledWith("t-2");
    expect(git.mergeFF).toHaveBeenCalledTimes(2);

    // Tasks processed sequentially
    expect(callOrder).toEqual(["pi-subagent-task/test/t-1", "pi-subagent-task/test/t-2"]);
  });

  it("does not overlap merges — second enqueued task waits for first to complete", async () => {
    const { opts, git, onMerged, getTask } = createBundle();

    const task1 = makeTask({
      id: "t-1",
      worktreePath: "/wt/t-1",
      branch: "pi-subagent-task/test/t-1",
    });
    const task2 = makeTask({
      id: "t-2",
      worktreePath: "/wt/t-2",
      branch: "pi-subagent-task/test/t-2",
    });

    getTask.mockImplementation((id: string) =>
      id === "t-1" ? task1 : id === "t-2" ? task2 : undefined,
    );

    // Make the first merge slow
    let resolveMerge1!: () => void;
    const merge1Promise = new Promise<{
      stdout: string;
      stderr: string;
      code: number;
      killed: boolean;
    }>((resolve) => {
      resolveMerge1 = () => {
        resolve({ stdout: "", stderr: "", code: 0, killed: false });
      };
    });
    const merge2Promise = Promise.resolve({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    });

    const mergeCalls: string[] = [];
    git.mergeFF = vi.fn().mockImplementation((branch: string) => {
      mergeCalls.push(branch);
      if (branch === "pi-subagent-task/test/t-1") return merge1Promise;
      return merge2Promise;
    });

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    worker.enqueue("t-2");

    // Start processing
    const processPromise = worker.processNext();

    // Wait for t-1 merge to start
    await vi.waitFor(() => {
      expect(git.mergeFF).toHaveBeenCalledTimes(1);
    });

    // t-2 should NOT have started yet
    expect(git.mergeFF).toHaveBeenCalledTimes(1);
    expect(onMerged).not.toHaveBeenCalled();

    // Resolve t-1
    resolveMerge1();
    await processPromise;

    // Now t-2 should have been processed
    // (via the recursive setTimeout)
    vi.useFakeTimers();
    vi.advanceTimersByTime(0);
    vi.useRealTimers();

    await vi.waitFor(() => {
      expect(onMerged).toHaveBeenCalledWith("t-2");
    });

    expect(mergeCalls).toEqual(["pi-subagent-task/test/t-1", "pi-subagent-task/test/t-2"]);
  });
});

describe("error handling", () => {
  it("catches errors in processOne and calls onFailed + audit", async () => {
    const { opts, git, onFailed, audit, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    // Simulate a crash in statusPorcelain (which is the first operation
    // in processOne, after the guard clauses).
    git.statusPorcelain = vi.fn().mockRejectedValue(new Error("git explosion"));

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    expect(audit).toHaveBeenCalledWith("merge_error", {
      taskId: "t-1",
      reason: "git explosion",
    });
    expect(onFailed).toHaveBeenCalledWith("t-1", "git explosion");
  });

  it("catches non-Error throwables gracefully", async () => {
    const { opts, git, onFailed, audit, getTask } = createBundle();
    const task = makeTask();
    getTask.mockReturnValue(task);

    // Simulate a string throw from statusPorcelain
    git.statusPorcelain = vi.fn().mockRejectedValue("string error");

    const worker = createMergeWorker(opts);
    worker.enqueue("t-1");
    await worker.processNext();

    expect(audit).toHaveBeenCalledWith("merge_error", {
      taskId: "t-1",
      reason: "string error",
    });
    expect(onFailed).toHaveBeenCalledWith("t-1", "string error");
  });
});
