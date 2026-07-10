import { describe, it, expect, vi } from "vitest";

import { handleAgentError, reconcileForResume } from "../retry";
import { buildCursor } from "../cursor";
import { SOFT_RETRY_CAP, DEFAULT_MAX_RETRIES } from "../constants";
import type { AgentRunResult, CursorNode, PoolState, TaskRuntime } from "../types";

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a minimal {@link TaskRuntime} for retry tests.
 */
function task(cursor: CursorNode, overrides?: Partial<TaskRuntime>): TaskRuntime {
  return {
    id: "t-1",
    title: undefined,
    prompt: "Write the code",
    profile: undefined,
    dependsOn: [],
    compose: { type: "agent" },
    cursor,
    status: "ready",
    retryCount: 0,
    runningAgentCount: 0,
    worktreePath: "/tmp/worktree",
    branch: "pi-task-pool/test/t-1",
    sessionFiles: [],
    downstreamCount: 0,
    ...overrides,
  };
}

/** Build a minimal {@link PoolState} for resume reconciliation tests. */
function pool(tasks: TaskRuntime[], overrides?: Partial<PoolState>): PoolState {
  return {
    id: "pool-1",
    name: "Test Pool",
    branch: "pi-task-pool/test",
    poolWorktree: "/tmp/pool-wt",
    baseBranch: "main",
    limits: { total: 4, provider: {}, model: {} },
    maxRetries: DEFAULT_MAX_RETRIES,
    createdAt: 1000,
    updatedAt: 2000,
    status: "running",
    tasks,
    mergeQueue: [],
    ...overrides,
  };
}

/** A failed agent result for testing retry. */
function failResult(overrides?: Partial<AgentRunResult>): AgentRunResult {
  return {
    success: false,
    lastText: "",
    exitCode: 1,
    durationMs: 50,
    error: "agent crashed",
    ...overrides,
  };
}

/** Non-null child accessor. */
function child(node: CursorNode, i: number): CursorNode {
  const c = node.children;
  if (c === undefined) throw new Error("node has no children");
  return c[i]!;
}

// ── handleAgentError ─────────────────────────────────────────────────────────

describe("handleAgentError", () => {
  // ── L1: soft-retry ────────────────────────────────────────────────────────

  it("soft-retry: executionCount goes from 0→1 when first error occurs", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    const result = handleAgentError(t, "0", failResult(), { maxRetries: 2 });
    expect(result).toBe("soft-retry");
    expect(cursor.executionCount).toBe(1);
    expect(cursor.state).toBe("pending");
  });

  it("soft-retry: executionCount increments on each retry up to SOFT_RETRY_CAP", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);

    // SOFT_RETRY_CAP=4 soft-retries: 0→1, 1→2, 2→3, 3→4
    for (let i = 1; i <= SOFT_RETRY_CAP; i++) {
      const r = handleAgentError(t, "0", failResult(), { maxRetries: 2 });
      expect(r).toBe("soft-retry");
      expect(cursor.executionCount).toBe(i);
      expect(cursor.state).toBe("pending");
    }
  });

  it("soft-retry: sets node.sessionFile from result.sessionFile", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    handleAgentError(t, "0", failResult({ sessionFile: "/sessions/retry-1.jsonl" }), {
      maxRetries: 2,
    });
    expect(cursor.sessionFile).toBe("/sessions/retry-1.jsonl");
  });

  it("soft-retry: sessionFile is undefined when result has none", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    handleAgentError(t, "0", failResult({ sessionFile: undefined }), { maxRetries: 2 });
    expect(cursor.sessionFile).toBeUndefined();
  });

  it("soft-retry: calls onAudit with agent_retry and attempt number", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    const audit = vi.fn();

    handleAgentError(t, "0", failResult(), { maxRetries: 2, onAudit: audit });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith("agent_retry", {
      taskId: "t-1",
      atomPath: "0",
      attempt: 1,
    });
  });

  // ── L2: task-restart ───────────────────────────────────────────────────────

  it("task-restart: triggers when executionCount reaches SOFT_RETRY_CAP", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);

    // Exhaust L1 soft-retries: 4 calls (executionCount 0→1→2→3→4)
    for (let i = 0; i < SOFT_RETRY_CAP; i++) {
      handleAgentError(t, "0", failResult(), { maxRetries: 2 });
    }
    // executionCount = SOFT_RETRY_CAP (4); next error triggers L2

    const result = handleAgentError(t, "0", failResult(), { maxRetries: 2 });
    expect(result).toBe("task-restart");
  });

  it("task-restart: returns task-restart when retryCount < maxRetries", () => {
    const cursor = buildCursor(undefined, "0");
    cursor.executionCount = SOFT_RETRY_CAP;
    const t = task(cursor);

    t.retryCount = 0;
    expect(handleAgentError(t, "0", failResult(), { maxRetries: 2 })).toBe("task-restart");

    t.retryCount = 1;
    expect(handleAgentError(t, "0", failResult(), { maxRetries: 2 })).toBe("task-restart");
  });

  it("task-restart: calls onAudit with task_retry when L2 triggers", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    const audit = vi.fn();
    // Exhaust L1 (4 soft-retries)
    for (let i = 0; i < SOFT_RETRY_CAP; i++) {
      handleAgentError(t, "0", failResult(), { maxRetries: 2, onAudit: audit });
    }

    // Now triggers L2: task-restart
    // retryCount is 0, so attempt hint is 1
    handleAgentError(t, "0", failResult(), { maxRetries: 2, onAudit: audit });
    expect(audit).toHaveBeenCalledWith("task_retry", {
      taskId: "t-1",
      attempt: 1,
    });
  });

  it("task-restart: can trigger multiple times as retryCount increases", () => {
    const cursor = buildCursor(undefined, "0");
    cursor.executionCount = SOFT_RETRY_CAP;
    const t = task(cursor);

    // Simulate caller increments: start with retryCount=0 → task-restart
    t.retryCount = 0;
    expect(handleAgentError(t, "0", failResult(), { maxRetries: 2 })).toBe("task-restart");

    // Caller would increment to 1; next call also returns task-restart
    t.retryCount = 1;
    expect(handleAgentError(t, "0", failResult(), { maxRetries: 2 })).toBe("task-restart");

    // retryCount=2 equals maxRetries=2 → no longer eligible for L2
    t.retryCount = 2;
    expect(handleAgentError(t, "0", failResult(), { maxRetries: 2 })).toBe("task-fail");
  });

  // ── L3: task-fail ──────────────────────────────────────────────────────────

  it("task-fail: returns task-fail when retryCount >= maxRetries", () => {
    const cursor = buildCursor(undefined, "0");
    cursor.executionCount = SOFT_RETRY_CAP;
    const t = task(cursor);

    t.retryCount = 2;
    expect(handleAgentError(t, "0", failResult(), { maxRetries: 2 })).toBe("task-fail");

    t.retryCount = 3;
    expect(handleAgentError(t, "0", failResult(), { maxRetries: 2 })).toBe("task-fail");
  });

  it("task-fail: calls onAudit with task_failed", () => {
    const cursor = buildCursor(undefined, "0");
    cursor.executionCount = SOFT_RETRY_CAP;
    const t = task(cursor);
    t.retryCount = 3;
    const audit = vi.fn();

    handleAgentError(t, "0", failResult(), { maxRetries: 2, onAudit: audit });
    expect(audit).toHaveBeenCalledWith("task_failed", { taskId: "t-1" });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it("throws on missing atomPath", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    expect(() => handleAgentError(t, "nonexistent", failResult(), { maxRetries: 2 })).toThrow(
      'no cursor node at path "nonexistent"',
    );
  });

  it("handles errors on nested cursor paths (e.g. sequential child)", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
        ],
      },
      "0",
    );
    const t = task(cursor);

    const result = handleAgentError(t, "0.0", failResult(), { maxRetries: 2 });
    expect(result).toBe("soft-retry");
    expect(child(cursor, 0).executionCount).toBe(1);
    expect(child(cursor, 0).state).toBe("pending");
  });

  it("onAudit is optional — does not throw when absent", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    expect(() => handleAgentError(t, "0", failResult(), { maxRetries: 2 })).not.toThrow();
  });
});

// ── reconcileForResume ───────────────────────────────────────────────────────

describe("reconcileForResume", () => {
  // ── Task status transitions ────────────────────────────────────────────────

  it("running task → ready", async () => {
    const p = pool([task(buildCursor(undefined, "0"), { id: "t-1", status: "running" })]);
    await reconcileForResume(p);
    expect(p.tasks[0]!.status).toBe("ready");
  });

  it("parked task → ready", async () => {
    const p = pool([task(buildCursor(undefined, "0"), { id: "t-1", status: "parked" })]);
    await reconcileForResume(p);
    expect(p.tasks[0]!.status).toBe("ready");
  });

  it("failed task → ready (D12)", async () => {
    const p = pool([task(buildCursor(undefined, "0"), { id: "t-1", status: "failed" })]);
    await reconcileForResume(p);
    expect(p.tasks[0]!.status).toBe("ready");
  });

  it("ready task stays ready", async () => {
    const p = pool([task(buildCursor(undefined, "0"), { id: "t-1", status: "ready" })]);
    await reconcileForResume(p);
    expect(p.tasks[0]!.status).toBe("ready");
  });

  it("blocked task stays blocked", async () => {
    const p = pool([task(buildCursor(undefined, "0"), { id: "t-1", status: "blocked" })]);
    await reconcileForResume(p);
    expect(p.tasks[0]!.status).toBe("blocked");
  });

  it("done task stays done", async () => {
    const p = pool([task(buildCursor(undefined, "0"), { id: "t-1", status: "done" })]);
    await reconcileForResume(p);
    expect(p.tasks[0]!.status).toBe("done");
  });

  // ── In-flight atom reset ───────────────────────────────────────────────────

  it("resets running agent atom to pending + executionCount 0", async () => {
    const cursor = buildCursor(undefined, "0");
    cursor.state = "running";
    cursor.executionCount = 3;
    const p = pool([task(cursor, { id: "t-1", status: "running" })]);

    await reconcileForResume(p);
    expect(cursor.state).toBe("pending");
    expect(cursor.executionCount).toBe(0);
  });

  it("clears sessionFile and lastText on running atoms (start FRESH)", async () => {
    const cursor = buildCursor(undefined, "0");
    cursor.state = "running";
    cursor.executionCount = 3;
    cursor.sessionFile = "/crashed.jsonl";
    cursor.lastText = "some partial output";
    const p = pool([task(cursor, { id: "t-1", status: "running" })]);

    await reconcileForResume(p);

    expect(cursor.state).toBe("pending");
    expect(cursor.executionCount).toBe(0);
    expect(cursor.sessionFile).toBeUndefined();
    expect(cursor.lastText).toBeUndefined();
  });

  it("resets running atom inside a sequential container", async () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
        ],
      },
      "0",
    );
    cursor.state = "running";
    cursor.childIndex = 1;
    // First child is done, second child is running
    child(cursor, 0).state = "done";
    child(cursor, 0).executionCount = 0;
    child(cursor, 1).state = "running";
    child(cursor, 1).executionCount = 2;

    const p = pool([task(cursor, { id: "t-1", status: "running" })]);

    await reconcileForResume(p);

    // Done child preserved
    expect(child(cursor, 0).state).toBe("done");
    expect(child(cursor, 0).executionCount).toBe(0);

    // Running child reset
    expect(child(cursor, 1).state).toBe("pending");
    expect(child(cursor, 1).executionCount).toBe(0);

    // Sequential container itself was also running → reset to pending
    expect(cursor.state).toBe("pending");
  });

  it("resets multiple running atoms in a parallel tree", async () => {
    const cursor = buildCursor(
      {
        type: "parallel",
        atoms: [
          { type: "agent", title: "x" },
          { type: "agent", title: "y" },
          { type: "agent", title: "z" },
        ],
      },
      "0",
    );
    cursor.state = "running";
    // x is done, y and z are running
    child(cursor, 0).state = "done";
    child(cursor, 1).state = "running";
    child(cursor, 1).executionCount = 1;
    child(cursor, 2).state = "running";
    child(cursor, 2).executionCount = 3;

    const p = pool([task(cursor, { id: "t-1", status: "running" })]);

    await reconcileForResume(p);

    // Done preserved
    expect(child(cursor, 0).state).toBe("done");

    // Running children reset
    expect(child(cursor, 1).state).toBe("pending");
    expect(child(cursor, 1).executionCount).toBe(0);
    expect(child(cursor, 2).state).toBe("pending");
    expect(child(cursor, 2).executionCount).toBe(0);
  });

  it("resets running gateLoop agent (work or review)", async () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent", title: "w" },
        review: { type: "agent", title: "r" },
      },
      "g",
    );
    cursor.state = "running";
    cursor.gatePhase = "work";
    cursor.workCursor!.state = "running";
    cursor.workCursor!.executionCount = 2;

    const p = pool([task(cursor, { id: "t-1", status: "running" })]);

    await reconcileForResume(p);

    // The gateLoop container and its work agent were both "running"
    expect(cursor.state).toBe("pending");
    expect(cursor.workCursor!.state).toBe("pending");
    expect(cursor.workCursor!.executionCount).toBe(0);
    // Review cursor was not running (never started) — stays pending
    expect(cursor.reviewCursor!.state).toBe("pending");
  });

  it("resets running loop iteration agent", async () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: { type: "agent", title: "iter" },
        count: 3,
      },
      "L",
    );
    cursor.state = "running";
    cursor.loopIteration = 2;
    cursor.childCursor!.state = "running";
    cursor.childCursor!.executionCount = 1;

    const p = pool([task(cursor, { id: "t-1", status: "running" })]);

    await reconcileForResume(p);

    // Loop container was running → reset to pending
    expect(cursor.state).toBe("pending");
    // Child cursor was running → reset
    expect(cursor.childCursor!.state).toBe("pending");
    expect(cursor.childCursor!.executionCount).toBe(0);
  });

  // ── Multiple tasks ─────────────────────────────────────────────────────────

  it("handles multiple tasks with mixed states", async () => {
    const cursor1 = buildCursor(undefined, "0");
    cursor1.state = "done";
    const task1 = task(cursor1, { id: "t-done", status: "done" });

    const cursor2 = buildCursor(undefined, "0");
    cursor2.state = "running";
    const task2 = task(cursor2, { id: "t-running", status: "running" });

    const cursor3 = buildCursor(undefined, "0");
    cursor3.state = "failed";
    const task3 = task(cursor3, { id: "t-failed", status: "failed" });

    const p = pool([task1, task2, task3]);

    await reconcileForResume(p);

    expect(task1.status).toBe("done"); // unchanged
    expect(task2.status).toBe("ready"); // changed
    expect(task3.status).toBe("ready"); // changed (D12)
    expect(cursor2.state).toBe("pending"); // reset
    expect(cursor1.state).toBe("done"); // preserved
  });

  // ── onAudit ─────────────────────────────────────────────────────────────────

  it("calls onAudit for each task status transition", async () => {
    const audit = vi.fn();
    const p = pool([
      task(buildCursor(undefined, "0"), { id: "t-1", status: "running" }),
      task(buildCursor(undefined, "0"), { id: "t-2", status: "parked" }),
      task(buildCursor(undefined, "0"), { id: "t-3", status: "failed" }),
      task(buildCursor(undefined, "0"), { id: "t-4", status: "ready" }), // no transition
    ]);

    await reconcileForResume(p, { onAudit: audit });

    // Three tasks transitioned → three audit events
    expect(audit).toHaveBeenCalledTimes(3);
    expect(audit).toHaveBeenCalledWith("task_ready", { taskId: "t-1" });
    expect(audit).toHaveBeenCalledWith("task_ready", { taskId: "t-2" });
    expect(audit).toHaveBeenCalledWith("task_ready", { taskId: "t-3" });
  });

  it("onAudit is optional — does not throw when absent", async () => {
    const p = pool([task(buildCursor(undefined, "0"), { id: "t-1", status: "running" })]);
    await expect(reconcileForResume(p)).resolves.not.toThrow();
  });

  // ── verifyWorktrees ────────────────────────────────────────────────────────

  it("returns empty array when no verifyWorktrees is provided", async () => {
    const p = pool([]);
    const missing = await reconcileForResume(p);
    expect(missing).toEqual([]);
  });

  it("returns verifyWorktrees result when provided", async () => {
    const p = pool([task(buildCursor(undefined, "0"), { id: "t-1", status: "running" })]);
    const verifyWorktrees = vi.fn((_: PoolState) => ["t-1"]);

    const missing = await reconcileForResume(p, { verifyWorktrees });
    expect(missing).toEqual(["t-1"]);
    expect(verifyWorktrees).toHaveBeenCalledTimes(1);
    expect(verifyWorktrees).toHaveBeenCalledWith(p);
  });

  it("calls verifyWorktrees with the pool even when no tasks exist", async () => {
    const p = pool([]);
    const verifyWorktrees = vi.fn((_: PoolState) => []);

    const missing = await reconcileForResume(p, { verifyWorktrees });
    expect(missing).toEqual([]);
    expect(verifyWorktrees).toHaveBeenCalledWith(p);
  });

  // ── No running atoms ───────────────────────────────────────────────────────

  it("handles tasks with no running atoms (all pending)", async () => {
    const cursor = buildCursor(undefined, "0");
    cursor.state = "pending";
    const p = pool([task(cursor, { id: "t-1", status: "ready" })]);

    await reconcileForResume(p);
    expect(cursor.state).toBe("pending");
    expect(p.tasks[0]!.status).toBe("ready");
  });

  it("handles tasks with no running atoms (all done)", async () => {
    const cursor = buildCursor(undefined, "0");
    cursor.state = "done";
    const p = pool([task(cursor, { id: "t-1", status: "done" })]);

    await reconcileForResume(p);
    expect(cursor.state).toBe("done");
    expect(p.tasks[0]!.status).toBe("done");
  });

  it("handles empty task list", async () => {
    const p = pool([]);
    await expect(reconcileForResume(p)).resolves.toEqual([]);
    expect(p.tasks).toEqual([]);
  });
});
