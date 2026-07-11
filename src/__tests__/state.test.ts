/**
 * Tests for state persistence module — state.json + audit.jsonl + resume.
 *
 * Covers every exported function in state.ts with both happy-path and
 * edge-case scenarios.
 *
 * References:
 *   §12  state persistence (state.json, writeState/readState, createPoolDirs)
 *   §15  audit event taxonomy (AuditLogger typed methods)
 *   D12  resume semantics (reconcilePoolOnResume)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  writeState,
  readState,
  AuditLogger,
  appendPoolHint,
  createPoolDirs,
  listPools,
  reconcilePoolOnResume,
} from "../state";
import { buildCursor } from "../cursor";
import type { CursorNode, PoolState, TaskRuntime } from "../types";
import { STATE_FILE, AUDIT_FILE, CUSTOM_ENTRY_TYPE, STATE_DIR_REL } from "../constants";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temporary directory that is cleaned up on test teardown. */
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "state-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

/** Build a minimal TaskRuntime for testing. */
function makeTask(cursor: CursorNode, overrides?: Partial<TaskRuntime>): TaskRuntime {
  return {
    id: "t-1",
    title: undefined,
    prompt: "Fix the bug",
    profile: undefined,
    dependsOn: [],
    compose: { type: "agent" },
    cursor,
    status: "ready",
    retryCount: 0,
    runningAgentCount: 0,
    worktreePath: "/tmp/wt",
    branch: "pi-subagent-task/test/t-1",
    sessionFiles: [],
    downstreamCount: 0,
    ...overrides,
  };
}

/** Build a minimal PoolState for testing. */
function makePool(tasks: TaskRuntime[], overrides?: Partial<PoolState>): PoolState {
  return {
    id: "pool-1",
    name: "Test Pool",
    branch: "pi-subagent-task/test",
    poolWorktree: "/tmp/pool-wt",
    baseBranch: "main",
    limits: { total: 4, provider: {}, model: {} },
    maxRetries: 2,
    createdAt: 1000,
    updatedAt: 2000,
    status: "running",
    tasks,
    mergeQueue: [],
    ...overrides,
  };
}

/** Non-null children accessor. */
function child(node: CursorNode, i: number): CursorNode {
  const c = node.children;
  if (c === undefined) throw new Error("node has no children");
  return c[i]!;
}

// ── writeState / readState ─────────────────────────────────────────────────

describe("writeState / readState", () => {
  it("round-trips a PoolState with multiple tasks and full cursor trees (§12)", () => {
    const dir = makeTempDir();

    // Build two tasks with rich compose trees.
    const task1Cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          {
            type: "gateLoop",
            work: { type: "agent", title: "implement" },
            review: { type: "agent", title: "review" },
            maxIterations: 3,
          },
          { type: "agent", title: "finalize" },
        ],
      },
      "t1",
    );

    // Mutate task1 cursor to simulate execution state.
    task1Cursor.state = "running";
    task1Cursor.childIndex = 1;
    const gate = child(task1Cursor, 0);
    gate.state = "done";
    gate.iteration = 2;
    gate.gatePhase = "review";
    gate.workCursor!.state = "done";
    gate.workCursor!.lastText = "implemented";
    gate.reviewCursor!.state = "done";
    gate.reviewCursor!.lastText = "approved";
    gate.lastFeedback = "looks good";

    const task2Cursor = buildCursor(
      {
        type: "parallel",
        atoms: [{ type: "agent", profile: "p1" }, { type: "agent" }],
      },
      "t2",
    );
    task2Cursor.state = "done";
    child(task2Cursor, 0).state = "done";
    child(task2Cursor, 0).sessionFile = "/sessions/a.jsonl";
    child(task2Cursor, 1).state = "done";

    const t1 = makeTask(task1Cursor, {
      id: "t-1",
      status: "running",
      retryCount: 1,
      runningAgentCount: 1,
      sessionFiles: ["/sessions/t1-s1.jsonl"],
      downstreamCount: 2,
      startedAt: 1500,
    });

    const t2 = makeTask(task2Cursor, {
      id: "t-2",
      title: "second task",
      status: "done",
      worktreePath: null,
      branch: null,
      downstreamCount: 0,
      lastError: undefined,
    });

    const pool = makePool([t1, t2]);

    // Write
    writeState(dir, pool);

    // Verify no temp file remains (atomic write)
    expect(existsSync(join(dir, ".state.json.tmp"))).toBe(false);

    // Verify state.json exists
    expect(existsSync(join(dir, STATE_FILE))).toBe(true);

    // Read back
    const loaded = readState(dir);
    expect(loaded).toBeDefined();

    // Deep equality of top-level fields
    expect(loaded!.id).toBe(pool.id);
    expect(loaded!.name).toBe(pool.name);
    expect(loaded!.branch).toBe(pool.branch);
    expect(loaded!.poolWorktree).toBe(pool.poolWorktree);
    expect(loaded!.baseBranch).toBe(pool.baseBranch);
    expect(loaded!.limits).toEqual(pool.limits);
    expect(loaded!.maxRetries).toBe(pool.maxRetries);
    expect(loaded!.createdAt).toBe(pool.createdAt);
    expect(loaded!.updatedAt).toBe(pool.updatedAt);
    expect(loaded!.status).toBe(pool.status);
    expect(loaded!.mergeQueue).toEqual(pool.mergeQueue);
    expect(loaded!.tasks).toHaveLength(2);

    // ── Task 1 verification ─────────────────────────────────────────────
    const loadedT1 = loaded!.tasks[0]!;
    expect(loadedT1.id).toBe("t-1");
    expect(loadedT1.title).toBeUndefined();
    expect(loadedT1.prompt).toBe("Fix the bug");
    expect(loadedT1.profile).toBeUndefined();
    expect(loadedT1.dependsOn).toEqual([]);
    expect(loadedT1.status).toBe("running");
    expect(loadedT1.retryCount).toBe(1);
    expect(loadedT1.runningAgentCount).toBe(1);
    expect(loadedT1.worktreePath).toBe("/tmp/wt");
    expect(loadedT1.branch).toBe("pi-subagent-task/test/t-1");
    expect(loadedT1.sessionFiles).toEqual(["/sessions/t1-s1.jsonl"]);
    expect(loadedT1.downstreamCount).toBe(2);
    expect(loadedT1.startedAt).toBe(1500);
    expect(loadedT1.compose).toEqual(t1.compose);

    // Cursor tree integrity
    expect(loadedT1.cursor.kind).toBe("sequential");
    expect(loadedT1.cursor.path).toBe("t1");
    expect(loadedT1.cursor.state).toBe("running");
    expect(loadedT1.cursor.childIndex).toBe(1);

    const loadedGate = child(loadedT1.cursor, 0);
    expect(loadedGate.kind).toBe("gateLoop");
    expect(loadedGate.state).toBe("done");
    expect(loadedGate.iteration).toBe(2);
    expect(loadedGate.gatePhase).toBe("review");
    expect(loadedGate.lastFeedback).toBe("looks good");
    expect(loadedGate.workCursor!.state).toBe("done");
    expect(loadedGate.workCursor!.lastText).toBe("implemented");
    expect(loadedGate.reviewCursor!.state).toBe("done");
    expect(loadedGate.reviewCursor!.lastText).toBe("approved");

    const loadedFinalize = child(loadedT1.cursor, 1);
    expect(loadedFinalize.kind).toBe("agent");
    expect(loadedFinalize.title).toBe("finalize");

    // ── Task 2 verification ─────────────────────────────────────────────
    const loadedT2 = loaded!.tasks[1]!;
    expect(loadedT2.id).toBe("t-2");
    expect(loadedT2.title).toBe("second task");
    expect(loadedT2.status).toBe("done");
    expect(loadedT2.worktreePath).toBeNull();
    expect(loadedT2.branch).toBeNull();
    expect(loadedT2.downstreamCount).toBe(0);

    expect(loadedT2.cursor.kind).toBe("parallel");
    expect(loadedT2.cursor.state).toBe("done");
    const pChild0 = child(loadedT2.cursor, 0);
    expect(pChild0.state).toBe("done");
    expect(pChild0.sessionFile).toBe("/sessions/a.jsonl");
    expect(pChild0.profile).toBe("p1");
    const pChild1 = child(loadedT2.cursor, 1);
    expect(pChild1.state).toBe("done");
  });

  it("writeState is atomic: no .state.json.tmp remains after write", () => {
    const dir = makeTempDir();
    const pool = makePool([]);

    writeState(dir, pool);
    expect(existsSync(join(dir, ".state.json.tmp"))).toBe(false);
    expect(existsSync(join(dir, STATE_FILE))).toBe(true);
  });

  it("readState returns undefined when state.json does not exist", () => {
    const dir = makeTempDir();
    const result = readState(dir);
    expect(result).toBeUndefined();
  });

  it("readState returns undefined when directory does not exist", () => {
    const result = readState("/nonexistent/pool-dir");
    expect(result).toBeUndefined();
  });

  it("readState returns undefined on corrupt JSON", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, STATE_FILE), "{invalid json", "utf-8");
    const result = readState(dir);
    expect(result).toBeUndefined();
  });

  it("readState returns undefined on missing tasks array", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ id: "pool-1", name: "Test" }), "utf-8");
    const result = readState(dir);
    expect(result).toBeUndefined();
  });

  it("readState returns undefined on non-object parsed value", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, STATE_FILE), '"just a string"', "utf-8");
    const result = readState(dir);
    expect(result).toBeUndefined();
  });

  it("readState returns undefined on null parsed value", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, STATE_FILE), "null", "utf-8");
    const result = readState(dir);
    expect(result).toBeUndefined();
  });

  it.each([
    ["mergeQueue", { id: "pool-1", tasks: [], status: "running", limits: {} }],
    ["status", { id: "pool-1", tasks: [], mergeQueue: [], limits: {} }],
    ["limits", { id: "pool-1", tasks: [], mergeQueue: [], status: "running", limits: null }],
  ])("readState rejects malformed %s metadata", (_field, value) => {
    const dir = makeTempDir();
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(value));
    expect(readState(dir)).toBeUndefined();
  });

  it("writeState rethrows rename errors and removes its written temporary file", () => {
    const poolDir = makeTempDir();
    mkdirSync(join(poolDir, STATE_FILE));

    let thrown: unknown;
    try {
      writeState(poolDir, makePool([]));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ code: "EISDIR", syscall: "rename" });
    expect(readdirSync(poolDir)).toEqual([STATE_FILE]);
    expect(readdirSync(poolDir).filter((entry) => entry.startsWith(`.${STATE_FILE}.tmp.`))).toEqual(
      [],
    );
  });

  it("readState returns undefined when id is not a string", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({ id: 123, name: "Test", tasks: [] }),
      "utf-8",
    );
    const result = readState(dir);
    expect(result).toBeUndefined();
  });
});

// ── AuditLogger ────────────────────────────────────────────────────────────

describe("AuditLogger", () => {
  it("logs events and produces valid JSONL (§15)", () => {
    const dir = makeTempDir();
    const logger = new AuditLogger(dir, "pool-1");

    logger.log("test_event", { key: "value", num: 42 });
    logger.log("another_event", { flag: true });
    logger.log("third_event", {});

    logger.close();

    const lines = readFileSync(join(dir, AUDIT_FILE), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("t");
      expect(parsed).toHaveProperty("pool");
      expect(parsed).toHaveProperty("type");
    }

    // First line
    const first = JSON.parse(lines[0]!);
    expect(first.pool).toBe("pool-1");
    expect(first.type).toBe("test_event");
    expect(first.key).toBe("value");
    expect(first.num).toBe(42);

    // Second line
    const second = JSON.parse(lines[1]!);
    expect(second.type).toBe("another_event");
    expect(second.flag).toBe(true);

    // Third line
    const third = JSON.parse(lines[2]!);
    expect(third.type).toBe("third_event");
  });

  it("every typed convenience method produces the correct event type (§15 taxonomy)", () => {
    const dir = makeTempDir();
    const logger = new AuditLogger(dir, "pool-1");

    // Call every typed method
    logger.poolCreated({});
    logger.poolResumed({});
    logger.poolCompleted({});

    logger.close();

    const lines = readFileSync(join(dir, AUDIT_FILE), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);

    const expectedTypes = ["pool_created", "pool_resumed", "pool_completed"];

    for (let i = 0; i < expectedTypes.length; i++) {
      const parsed = JSON.parse(lines[i]!);
      expect(parsed.type).toBe(expectedTypes[i]);
      expect(parsed.pool).toBe("pool-1");
      expect(typeof parsed.t).toBe("string");
    }
  });

  it("includes pool id and ISO timestamp in every line", () => {
    const dir = makeTempDir();
    const logger = new AuditLogger(dir, "my-pool");
    logger.log("some_event", {});
    logger.close();

    const line = readFileSync(join(dir, AUDIT_FILE), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.pool).toBe("my-pool");
    expect(typeof parsed.t).toBe("string");
    // ISO 8601 check: starts with 4-digit year
    expect(parsed.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("close is idempotent and logging after close is a no-op", () => {
    const dir = makeTempDir();
    const logger = new AuditLogger(dir, "pool-1");
    logger.log("before", {});
    logger.close();
    logger.close();
    logger.log("after", {});

    expect(readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("payload fields are merged into the log line", () => {
    const dir = makeTempDir();
    const logger = new AuditLogger(dir, "pool-1");
    logger.log("custom", { taskId: "t-1", detail: "something happened" });
    logger.close();

    const parsed = JSON.parse(readFileSync(join(dir, AUDIT_FILE), "utf-8").trim());
    expect(parsed.taskId).toBe("t-1");
    expect(parsed.detail).toBe("something happened");
  });
});

// ── appendPoolHint ──────────────────────────────────────────────────────────

describe("appendPoolHint", () => {
  it("calls pi.appendEntry with CUSTOM_ENTRY_TYPE and poolId", () => {
    const appendEntry = vi.fn();
    const pi = { appendEntry };

    appendPoolHint(pi, "pool-42");
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith(CUSTOM_ENTRY_TYPE, {
      poolId: "pool-42",
    });
  });
});

// ── createPoolDirs ──────────────────────────────────────────────────────────

describe("createPoolDirs", () => {
  it("creates pool dir, sessions, artifacts, and worktrees subdirs", () => {
    const dir = makeTempDir();
    const poolDir = join(dir, "my-pool");

    createPoolDirs(poolDir);

    expect(existsSync(poolDir)).toBe(true);
    expect(existsSync(join(poolDir, "sessions"))).toBe(true);
    expect(existsSync(join(poolDir, "artifacts"))).toBe(true);
    expect(existsSync(join(poolDir, "worktrees"))).toBe(true);
  });

  it("is idempotent when called multiple times", () => {
    const dir = makeTempDir();
    const poolDir = join(dir, "my-pool");

    createPoolDirs(poolDir);
    createPoolDirs(poolDir); // second call

    expect(existsSync(poolDir)).toBe(true);
    expect(existsSync(join(poolDir, "sessions"))).toBe(true);
    expect(existsSync(join(poolDir, "artifacts"))).toBe(true);
    expect(existsSync(join(poolDir, "worktrees"))).toBe(true);
  });
});

// ── listPools ───────────────────────────────────────────────────────────────

describe("listPools", () => {
  it("finds pool directories under .pi/subagent-tasks/", () => {
    const cwd = makeTempDir();
    // Create .pi/subagent-tasks/ with two pool dirs
    const stateDir = join(cwd, STATE_DIR_REL);
    mkdirSync(join(stateDir, "pool-alpha"), { recursive: true });
    mkdirSync(join(stateDir, "pool-beta"), { recursive: true });

    const pools = listPools(cwd);
    expect(pools).toEqual(expect.arrayContaining(["pool-alpha", "pool-beta"]));
    expect(pools).toHaveLength(2);
  });

  it("ignores files (non-directories) in the state directory", () => {
    const cwd = makeTempDir();
    const stateDir = join(cwd, STATE_DIR_REL);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "not-a-pool.txt"), "hello", "utf-8");
    mkdirSync(join(stateDir, "real-pool"), { recursive: true });

    const pools = listPools(cwd);
    expect(pools).toEqual(["real-pool"]);
    expect(pools).not.toContain("not-a-pool.txt");
  });

  it("returns empty array when state dir does not exist", () => {
    const cwd = makeTempDir();
    const pools = listPools(cwd);
    expect(pools).toEqual([]);
  });

  it("returns empty array when state dir is empty", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, STATE_DIR_REL), { recursive: true });
    const pools = listPools(cwd);
    expect(pools).toEqual([]);
  });

  it("returns empty array when readdirSync throws (e.g. non-directory at state dir path)", () => {
    const cwd = makeTempDir();
    const stateDir = join(cwd, STATE_DIR_REL);
    // First create the dir, then replace it with a file → readdirSync throws.
    mkdirSync(stateDir, { recursive: true });
    rmSync(stateDir, { recursive: true, force: true });
    writeFileSync(stateDir, "this is a file, not a dir", "utf-8");
    const pools = listPools(cwd);
    expect(pools).toEqual([]);
  });
});

// ── reconcilePoolOnResume ──────────────────────────────────────────────────

describe("reconcilePoolOnResume", () => {
  it("resets running tasks to ready (D12)", async () => {
    const cursor = buildCursor(undefined, "0");
    cursor.state = "running";
    const t = makeTask(cursor, { id: "t-1", status: "running" });
    const pool = makePool([t]);

    const { pool: result, missingWorktrees } = await reconcilePoolOnResume(pool);
    expect(result.tasks[0]!.status).toBe("ready");
    expect(missingWorktrees).toEqual([]);
  });

  it("resets failed tasks to ready (D12)", async () => {
    const cursor = buildCursor(undefined, "0");
    const t = makeTask(cursor, { id: "t-1", status: "failed" });
    const pool = makePool([t]);

    const { pool: result, missingWorktrees } = await reconcilePoolOnResume(pool);
    expect(result.tasks[0]!.status).toBe("ready");
    expect(missingWorktrees).toEqual([]);
  });

  it("resets parked tasks to ready (D12)", async () => {
    const cursor = buildCursor(undefined, "0");
    const t = makeTask(cursor, { id: "t-1", status: "parked" });
    const pool = makePool([t]);

    const { pool: result, missingWorktrees } = await reconcilePoolOnResume(pool);
    expect(result.tasks[0]!.status).toBe("ready");
    expect(missingWorktrees).toEqual([]);
  });

  it("leaves done and ready tasks unchanged", async () => {
    const doneCursor = buildCursor(undefined, "0");
    doneCursor.state = "done";
    const doneTask = makeTask(doneCursor, {
      id: "t-1",
      status: "done",
    });

    const readyCursor = buildCursor(undefined, "1");
    const readyTask = makeTask(readyCursor, {
      id: "t-2",
      status: "ready",
    });

    const pool = makePool([doneTask, readyTask]);
    const { missingWorktrees } = await reconcilePoolOnResume(pool);

    const tDone = pool.tasks.find((t) => t.id === "t-1")!;
    const tReady = pool.tasks.find((t) => t.id === "t-2")!;
    expect(tDone.status).toBe("done");
    expect(tReady.status).toBe("ready");
    expect(missingWorktrees).toEqual([]);
  });

  it("resets in-flight running cursor nodes to pending with zeroed executionCount (§8)", async () => {
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

    // First child is running with executionCount
    child(cursor, 0).state = "running";
    child(cursor, 0).executionCount = 3;
    child(cursor, 0).sessionFile = "/sessions/partial.jsonl";
    child(cursor, 0).lastText = "partial output";

    // Second child is done (must be preserved)
    child(cursor, 1).state = "done";
    child(cursor, 1).lastText = "complete output";

    const t = makeTask(cursor, {
      id: "t-1",
      status: "running",
    });

    const pool = makePool([t]);
    const { missingWorktrees } = await reconcilePoolOnResume(pool);

    const reloaded = pool.tasks[0]!.cursor;

    // Running child → pending with zeroed executionCount
    expect(child(reloaded, 0).state).toBe("pending");
    expect(child(reloaded, 0).executionCount).toBe(0);
    expect(child(reloaded, 0).sessionFile).toBeUndefined();
    expect(child(reloaded, 0).lastText).toBeUndefined();

    // Done child preserved
    expect(child(reloaded, 1).state).toBe("done");
    expect(child(reloaded, 1).lastText).toBe("complete output");
    expect(missingWorktrees).toEqual([]);
  });

  it("preserves completed atoms unchanged", async () => {
    const cursor = buildCursor(
      {
        type: "parallel",
        atoms: [{ type: "agent", profile: "worker" }, { type: "agent" }],
      },
      "0",
    );

    cursor.state = "done";
    child(cursor, 0).state = "done";
    child(cursor, 0).sessionFile = "/sessions/complete.jsonl";
    child(cursor, 1).state = "done";

    const t = makeTask(cursor, { id: "t-1", status: "done" });
    const pool = makePool([t]);

    const { missingWorktrees } = await reconcilePoolOnResume(pool);

    const reloaded = pool.tasks[0]!.cursor;
    expect(reloaded.state).toBe("done");
    expect(child(reloaded, 0).state).toBe("done");
    expect(child(reloaded, 0).sessionFile).toBe("/sessions/complete.jsonl");
    expect(child(reloaded, 1).state).toBe("done");
    expect(missingWorktrees).toEqual([]);
  });

  it("calls onAudit for state transitions when provided", async () => {
    const onAudit = vi.fn();
    const cursor = buildCursor(undefined, "0");
    const t = makeTask(cursor, { id: "t-1", status: "running" });
    const pool = makePool([t]);

    const { missingWorktrees } = await reconcilePoolOnResume(pool, { onAudit });
    expect(onAudit).toHaveBeenCalledWith("task_ready", { taskId: "t-1" });
    expect(missingWorktrees).toEqual([]);
  });

  it("awaits verifyWorktrees when provided and surfaces missingWorktrees", async () => {
    const cursor = buildCursor(undefined, "0");
    const t = makeTask(cursor, { id: "t-1", status: "running", worktreePath: "/tmp/wt-1" });
    const pool = makePool([t]);
    const verifyWorktrees = vi.fn(async (_p: PoolState) => ["t-1"]);

    const { pool: result, missingWorktrees } = await reconcilePoolOnResume(pool, {
      verifyWorktrees,
    });
    expect(verifyWorktrees).toHaveBeenCalledTimes(1);
    expect(verifyWorktrees).toHaveBeenCalledWith(pool);
    // Pool state is mutated in place
    expect(result.tasks[0]!.status).toBe("ready");
    expect(missingWorktrees).toEqual(["t-1"]);
  });

  it("returns the mutated pool state and missingWorktrees", async () => {
    const cursor = buildCursor(undefined, "0");
    const t = makeTask(cursor, { id: "t-1", status: "running" });
    const pool = makePool([t]);

    const { pool: result, missingWorktrees } = await reconcilePoolOnResume(pool);
    expect(result).toBe(pool); // Same reference, mutated in place
    expect(result.tasks[0]!.status).toBe("ready");
    expect(missingWorktrees).toEqual([]);
  });
});
