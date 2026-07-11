import { describe, it, expect } from "vitest";

import {
  canTransition,
  depsAllDone,
  recomputeInitialStatuses,
  propagateFailures,
  countByStatus,
  isFixedPoint,
} from "../status";
import type { TaskRuntime } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── canTransition ────────────────────────────────────────────────────────────

describe("canTransition", () => {
  it("allows blocked → ready", () => {
    expect(canTransition("blocked", "ready")).toBe(true);
  });

  it("allows blocked → failed", () => {
    expect(canTransition("blocked", "failed")).toBe(true);
  });

  it("allows ready → running", () => {
    expect(canTransition("ready", "running")).toBe(true);
  });

  it("allows running → running (self-loop)", () => {
    expect(canTransition("running", "running")).toBe(true);
  });

  it("allows running → parked", () => {
    expect(canTransition("running", "parked")).toBe(true);
  });

  it("allows running → done", () => {
    expect(canTransition("running", "done")).toBe(true);
  });

  it("allows running → failed", () => {
    expect(canTransition("running", "failed")).toBe(true);
  });

  it("allows parked → running", () => {
    expect(canTransition("parked", "running")).toBe(true);
  });

  it("allows parked → ready", () => {
    expect(canTransition("parked", "ready")).toBe(true);
  });

  it("allows failed → ready (resume)", () => {
    expect(canTransition("failed", "ready")).toBe(true);
  });

  it("rejects an unknown source status defensively", () => {
    expect(canTransition("unknown" as TaskRuntime["status"], "ready")).toBe(false);
  });

  it("rejects ready → parked (parking invariant)", () => {
    expect(canTransition("ready", "parked")).toBe(false);
  });

  it("rejects done → running (terminal)", () => {
    expect(canTransition("done", "running")).toBe(false);
  });

  it("rejects done → failed (terminal)", () => {
    expect(canTransition("done", "failed")).toBe(false);
  });

  it("rejects done → done (terminal — no self-loop)", () => {
    expect(canTransition("done", "done")).toBe(false);
  });

  it("rejects failed → running (only failed→ready allowed)", () => {
    expect(canTransition("failed", "running")).toBe(false);
  });

  it("rejects failed → done", () => {
    expect(canTransition("failed", "done")).toBe(false);
  });

  it("rejects failed → parked", () => {
    expect(canTransition("failed", "parked")).toBe(false);
  });

  it("rejects blocked → running (must go through ready first)", () => {
    expect(canTransition("blocked", "running")).toBe(false);
  });

  it("rejects blocked → done", () => {
    expect(canTransition("blocked", "done")).toBe(false);
  });

  it("rejects ready → failed (only blocked→failed for propagation)", () => {
    expect(canTransition("ready", "failed")).toBe(false);
  });

  it("rejects ready → done", () => {
    expect(canTransition("ready", "done")).toBe(false);
  });
});

// ── depsAllDone ──────────────────────────────────────────────────────────────

describe("depsAllDone", () => {
  it("returns true when task has no dependencies", () => {
    const task = makeTask({ id: "a" });
    expect(depsAllDone(task, new Map())).toBe(true);
  });

  it("returns true when all dependencies are done", () => {
    const a = makeTask({ id: "a", status: "done" });
    const b = makeTask({ id: "b", status: "done" });
    const c = makeTask({ id: "c", dependsOn: ["a", "b"] });
    const map = new Map<string, TaskRuntime>([
      ["a", a],
      ["b", b],
      ["c", c],
    ]);
    expect(depsAllDone(c, map)).toBe(true);
  });

  it("returns false when any dependency is not done", () => {
    const a = makeTask({ id: "a", status: "done" });
    const b = makeTask({ id: "b", status: "running" });
    const c = makeTask({ id: "c", dependsOn: ["a", "b"] });
    const map = new Map<string, TaskRuntime>([
      ["a", a],
      ["b", b],
      ["c", c],
    ]);
    expect(depsAllDone(c, map)).toBe(false);
  });

  it("returns false when any dependency is failed", () => {
    const a = makeTask({ id: "a", status: "failed" });
    const b = makeTask({ id: "b", dependsOn: ["a"] });
    const map = new Map<string, TaskRuntime>([
      ["a", a],
      ["b", b],
    ]);
    expect(depsAllDone(b, map)).toBe(false);
  });

  it("returns false when dependency is missing from the map", () => {
    const task = makeTask({ id: "c", dependsOn: ["ghost"] });
    expect(depsAllDone(task, new Map())).toBe(false);
  });

  it("returns false when any dependency is ready", () => {
    const a = makeTask({ id: "a", status: "ready" });
    const b = makeTask({ id: "b", dependsOn: ["a"] });
    const map = new Map<string, TaskRuntime>([["a", a]]);
    expect(depsAllDone(b, map)).toBe(false);
  });
});

// ── recomputeInitialStatuses ─────────────────────────────────────────────────

describe("recomputeInitialStatuses", () => {
  it("sets root tasks (no deps) to ready", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    recomputeInitialStatuses(tasks);
    expect(tasks[0]!.status).toBe("ready");
    expect(tasks[1]!.status).toBe("ready");
  });

  it("sets tasks with dependencies to blocked", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b", dependsOn: ["a"] })];
    recomputeInitialStatuses(tasks);
    expect(tasks[0]!.status).toBe("ready");
    expect(tasks[1]!.status).toBe("blocked");
  });

  it("handles a chain: root→ready, deps→blocked", () => {
    const tasks = [
      makeTask({ id: "a" }),
      makeTask({ id: "b", dependsOn: ["a"] }),
      makeTask({ id: "c", dependsOn: ["b"] }),
    ];
    recomputeInitialStatuses(tasks);
    expect(tasks[0]!.status).toBe("ready");
    expect(tasks[1]!.status).toBe("blocked");
    expect(tasks[2]!.status).toBe("blocked");
  });

  it("overwrites previous status values", () => {
    const tasks = [
      makeTask({ id: "a", status: "done" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "running" }),
    ];
    recomputeInitialStatuses(tasks);
    expect(tasks[0]!.status).toBe("ready");
    expect(tasks[1]!.status).toBe("blocked");
  });

  it("handles empty task list", () => {
    const tasks: TaskRuntime[] = [];
    recomputeInitialStatuses(tasks);
    expect(tasks).toEqual([]);
  });
});

// ── propagateFailures ───────────────────────────────────────────────────────

describe("propagateFailures", () => {
  it("fails a blocked task whose dependency is failed", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "blocked" }),
    ];
    const newlyFailed = propagateFailures(tasks);
    expect(newlyFailed).toEqual(["b"]);
    expect(tasks[1]!.status).toBe("failed");
    expect(tasks[1]!.lastError).toBe("depends on failed: a");
  });

  it("fails a ready task whose dependency is failed", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "ready" }),
    ];
    const newlyFailed = propagateFailures(tasks);
    expect(newlyFailed).toEqual(["b"]);
    expect(tasks[1]!.status).toBe("failed");
  });

  it("transitively propagates A→B→C: A failed → B fails → C fails", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "blocked" }),
      makeTask({ id: "c", dependsOn: ["b"], status: "blocked" }),
    ];
    const newlyFailed = propagateFailures(tasks);
    // Order of discovery: b first (depends on a), then c (depends on b)
    expect(newlyFailed).toEqual(["b", "c"]);
    expect(tasks[1]!.status).toBe("failed");
    expect(tasks[1]!.lastError).toBe("depends on failed: a");
    expect(tasks[2]!.status).toBe("failed");
    expect(tasks[2]!.lastError).toBe("depends on failed: b");
  });

  it("does not touch done tasks", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "done" }),
    ];
    const newlyFailed = propagateFailures(tasks);
    expect(newlyFailed).toEqual([]);
    expect(tasks[1]!.status).toBe("done");
  });

  it("does not touch running tasks", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "running" }),
    ];
    const newlyFailed = propagateFailures(tasks);
    expect(newlyFailed).toEqual([]);
    expect(tasks[1]!.status).toBe("running");
  });

  it("does not touch parked tasks", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "parked" }),
    ];
    const newlyFailed = propagateFailures(tasks);
    expect(newlyFailed).toEqual([]);
    expect(tasks[1]!.status).toBe("parked");
  });

  it("handles a diamond: A→B, A→C, B→D, C→D — A fails → B,C fail → D fails", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "blocked" }),
      makeTask({ id: "c", dependsOn: ["a"], status: "blocked" }),
      makeTask({ id: "d", dependsOn: ["b", "c"], status: "blocked" }),
    ];
    const newlyFailed = propagateFailures(tasks);
    // b and c fail first (depends on a), then d (depends on b and c)
    expect(newlyFailed).toEqual(["b", "c", "d"]);
    expect(tasks[1]!.status).toBe("failed");
    expect(tasks[2]!.status).toBe("failed");
    expect(tasks[3]!.status).toBe("failed");
    // d's first failed dep is 'b' (order of dependsOn array)
    expect(tasks[3]!.lastError).toBe("depends on failed: b");
  });

  it("returns empty when no tasks are affected", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", status: "done" }),
      makeTask({ id: "c", status: "running" }),
    ];
    const newlyFailed = propagateFailures(tasks);
    expect(newlyFailed).toEqual([]);
  });

  it("returns empty when there are no failed tasks", () => {
    const tasks = [
      makeTask({ id: "a", status: "done" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "blocked" }),
    ];
    const newlyFailed = propagateFailures(tasks);
    expect(newlyFailed).toEqual([]);
  });

  it("handles a chain where a middle task is done and stops propagation", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "done" }),
      makeTask({ id: "c", dependsOn: ["b"], status: "blocked" }),
    ];
    const newlyFailed = propagateFailures(tasks);
    // b is done (stays done), c depends on b (done, not failed) so c stays blocked
    expect(newlyFailed).toEqual([]);
    expect(tasks[1]!.status).toBe("done");
    expect(tasks[2]!.status).toBe("blocked");
  });

  it("does not double-count tasks that are already failed", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "blocked" }),
      makeTask({ id: "c", dependsOn: ["b"], status: "blocked" }),
    ];
    const first = propagateFailures(tasks);
    expect(first).toEqual(["b", "c"]);

    // Second call should return empty (already failed)
    const second = propagateFailures(tasks);
    expect(second).toEqual([]);
  });

  it("ignores dependencies on task ids absent from the graph", () => {
    const tasks = [makeTask({ id: "b", dependsOn: ["ghost"], status: "blocked" })];
    expect(propagateFailures(tasks)).toEqual([]);
    expect(tasks[0]!.status).toBe("blocked");
  });

  it("propagates from an explicitly failed entry even when ids are duplicated", () => {
    const tasks = [
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "a", status: "done" }),
      makeTask({ id: "b", dependsOn: ["a"], status: "blocked" }),
    ];
    expect(propagateFailures(tasks)).toEqual(["b"]);
    expect(tasks[2]!.lastError).toBe("depends on failed: a");
  });

  it("handles a self-referential dependsOn gracefully (no infinite loop)", () => {
    const tasks = [makeTask({ id: "a", dependsOn: ["a"], status: "blocked" })];
    const newlyFailed = propagateFailures(tasks);
    // a depends on itself but a is not failed, so no propagation
    expect(newlyFailed).toEqual([]);
    expect(tasks[0]!.status).toBe("blocked");
  });
});

// ── countByStatus ───────────────────────────────────────────────────────────

describe("countByStatus", () => {
  it("returns all six keys with zero for empty list", () => {
    const counts = countByStatus([]);
    expect(counts).toEqual({
      blocked: 0,
      ready: 0,
      running: 0,
      parked: 0,
      failed: 0,
      done: 0,
    });
  });

  it("tallies tasks by status", () => {
    const tasks = [
      makeTask({ id: "a", status: "done" }),
      makeTask({ id: "b", status: "done" }),
      makeTask({ id: "c", status: "running" }),
      makeTask({ id: "d", status: "blocked" }),
      makeTask({ id: "e", status: "ready" }),
      makeTask({ id: "f", status: "parked" }),
      makeTask({ id: "g", status: "failed" }),
      makeTask({ id: "h", status: "failed" }),
    ];
    expect(countByStatus(tasks)).toEqual({
      blocked: 1,
      ready: 1,
      running: 1,
      parked: 1,
      failed: 2,
      done: 2,
    });
  });

  it("works with a single task", () => {
    const tasks = [makeTask({ id: "x", status: "running" })];
    expect(countByStatus(tasks)).toEqual({
      blocked: 0,
      ready: 0,
      running: 1,
      parked: 0,
      failed: 0,
      done: 0,
    });
  });
});

// ── isFixedPoint ────────────────────────────────────────────────────────────

describe("isFixedPoint", () => {
  it("returns true when all tasks are done or failed and merge queue is empty", () => {
    const tasks = [makeTask({ id: "a", status: "done" }), makeTask({ id: "b", status: "failed" })];
    expect(isFixedPoint(tasks, [])).toBe(true);
  });

  it("returns false when any task is ready", () => {
    const tasks = [makeTask({ id: "a", status: "done" }), makeTask({ id: "b", status: "ready" })];
    expect(isFixedPoint(tasks, [])).toBe(false);
  });

  it("returns false when any task is running", () => {
    const tasks = [makeTask({ id: "a", status: "done" }), makeTask({ id: "b", status: "running" })];
    expect(isFixedPoint(tasks, [])).toBe(false);
  });

  it("returns false when any task is parked", () => {
    const tasks = [makeTask({ id: "a", status: "done" }), makeTask({ id: "b", status: "parked" })];
    expect(isFixedPoint(tasks, [])).toBe(false);
  });

  it("returns false when merge queue is not empty", () => {
    const tasks = [makeTask({ id: "a", status: "done" }), makeTask({ id: "b", status: "done" })];
    expect(isFixedPoint(tasks, ["a"])).toBe(false);
  });

  it("returns true when only blocked tasks remain (not ready/running/parked)", () => {
    const tasks = [makeTask({ id: "a", status: "done" }), makeTask({ id: "b", status: "blocked" })];
    // blocked alone doesn't prevent fixed point — only ready/running/parked do
    expect(isFixedPoint(tasks, [])).toBe(true);
  });

  it("returns true for empty task list and empty queue", () => {
    expect(isFixedPoint([], [])).toBe(true);
  });
});
