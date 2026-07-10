import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findSessionFileById,
  renameSession,
  buildSpawnSessionArgs,
  recordSessionPath,
} from "../sessions";
import type { PoolState, TaskRuntime } from "../types";

// ── Test-scoped temp-dir management ─────────────────────────────────────────

const tmpDirs = new Set<string>();

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.clear();
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
  tmpDirs.add(dir);
  return dir;
}

/** Write a file and return its absolute path. */
function touch(absPath: string, content = ""): string {
  writeFileSync(absPath, content, "utf-8");
  return absPath;
}

/** Set a file's mtime to a known value (seconds since epoch). */
function setMtime(absPath: string, epochSec: number): void {
  utimesSync(absPath, epochSec, epochSec);
}

/**
 * Create a flat session file at `dir/<ts>_<uuid>.jsonl` with optional mtime.
 * Returns the absolute path.
 */
function createFlatSession(
  dir: string,
  ts: string,
  uuid: string,
  mtimeSec: number,
  content = "",
): string {
  const p = join(dir, `${ts}_${uuid}.jsonl`);
  touch(p, content);
  setMtime(p, mtimeSec);
  return p;
}

/**
 * Create a nested session file at `dir/--<cwd>--/<ts>_<uuid>.jsonl` with
 * optional mtime. Returns the absolute path.
 */
function createNestedSession(
  dir: string,
  cwd: string,
  ts: string,
  uuid: string,
  mtimeSec: number,
  content = "",
): string {
  const sub = join(dir, `--${cwd}--`);
  mkdirSync(sub, { recursive: true });
  const p = join(sub, `${ts}_${uuid}.jsonl`);
  touch(p, content);
  setMtime(p, mtimeSec);
  return p;
}

// ── helpers for PoolState ────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskRuntime> & { id: string }): TaskRuntime {
  return {
    id: overrides.id,
    title: overrides.title,
    prompt: overrides.prompt ?? "do the thing",
    profile: overrides.profile,
    dependsOn: overrides.dependsOn ?? [],
    compose: overrides.compose ?? { type: "agent" as const },
    cursor: overrides.cursor ?? {
      kind: "agent" as const,
      path: "0",
      state: "pending" as const,
    },
    status: overrides.status ?? "ready",
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

function makePoolState(tasks: TaskRuntime[]): PoolState {
  return {
    id: "test-pool",
    name: "Test Pool",
    branch: "pi-subagent-task/test-pool",
    poolWorktree: "/tmp/test-pool-wt",
    baseBranch: "main",
    limits: { total: 4, provider: {}, model: {} },
    maxRetries: 2,
    createdAt: 1000,
    updatedAt: 1000,
    status: "running",
    tasks,
    mergeQueue: [],
  };
}

// ── findSessionFileById ─────────────────────────────────────────────────────

describe("findSessionFileById", () => {
  it("finds the flat <ts>_<sessionId>.jsonl matching the id", () => {
    const dir = makeTempDir();

    const target = createFlatSession(dir, "20260709T120000Z", "abc12345", 100_000);
    // Distractor with a different id
    createFlatSession(dir, "20260709T110000Z", "zzz99999", 200_000);

    const found = findSessionFileById(dir, "abc12345");
    expect(found).toBe(target);
  });

  it("finds the correct file regardless of mtime ordering (not globally-newest)", () => {
    const dir = makeTempDir();

    // The target has an OLDER mtime than the distractor, yet must still be
    // found because the lookup is by id — not by newest mtime (N1).
    const target = createFlatSession(dir, "20260709T100000Z", "target-id", 100_000);
    createFlatSession(dir, "20260709T120000Z", "newer-id", 300_000);

    const found = findSessionFileById(dir, "target-id");
    expect(found).toBe(target);
  });

  it("ignores non-session .jsonl files (without timestamp prefix)", () => {
    const dir = makeTempDir();
    touch(join(dir, "random.jsonl"));
    setMtime(join(dir, "random.jsonl"), 500_000);

    const session = createFlatSession(dir, "20260709T120000Z", "dddddddd", 100_000);

    const found = findSessionFileById(dir, "dddddddd");
    expect(found).toBe(session);
  });

  it("finds a nested --<cwd>--/<ts>_<sessionId>.jsonl by id", () => {
    const dir = makeTempDir();
    const nested = createNestedSession(dir, "my-repo", "20260709T120000Z", "eeeeeeee", 300_000);

    const found = findSessionFileById(dir, "eeeeeeee");
    expect(found).toBe(nested);
  });

  it("finds the correct nested file among multiple --<cwd>-- subdirs", () => {
    const dir = makeTempDir();
    createNestedSession(dir, "repo-a", "20260709T100000Z", "ffffffff", 100_000);
    const target = createNestedSession(dir, "repo-b", "20260709T120000Z", "gggggggg", 300_000);

    const found = findSessionFileById(dir, "gggggggg");
    expect(found).toBe(target);
  });

  it("returns undefined when no file matches the id", () => {
    const dir = makeTempDir();
    createFlatSession(dir, "20260709T120000Z", "aaaaaaaa", 100_000);

    expect(findSessionFileById(dir, "nonexistent")).toBeUndefined();
  });

  it("returns undefined on an empty directory", () => {
    const dir = makeTempDir();
    expect(findSessionFileById(dir, "some-id")).toBeUndefined();
  });

  it("returns undefined when the directory does not exist", () => {
    const result = findSessionFileById("/nonexistent/path/that/does/not/exist", "some-id");
    expect(result).toBeUndefined();
  });

  it("returns undefined when only non-matching files exist", () => {
    const dir = makeTempDir();
    createFlatSession(dir, "20260709T120000Z", "other-id", 100_000);
    touch(join(dir, "notes.txt"));
    expect(findSessionFileById(dir, "target-id")).toBeUndefined();
  });

  it("returns undefined when nested subdir has no matching file", () => {
    const dir = makeTempDir();
    const sub = join(dir, "--empty-cwd--");
    mkdirSync(sub, { recursive: true });
    touch(join(sub, "some.txt"));
    expect(findSessionFileById(dir, "target-id")).toBeUndefined();
  });

  // ── Concurrency safety (N1 regression test) ─────────────────────────

  it("attributes each agent its own file under concurrency (two flat files)", () => {
    // Simulates the N1 scenario: two agents finish concurrently, each with
    // a distinct session id in the same sessionDir. The old globally-newest
    // heuristic would hand both agents the same (newest) file; the id-based
    // lookup must return each agent its own.
    const dir = makeTempDir();

    const fileA = createFlatSession(dir, "20260709T120000Z", "agentA-id", 300_000);
    const fileB = createFlatSession(dir, "20260709T120001Z", "agentB-id", 200_000);

    // Agent A (newer mtime) and Agent B (older mtime) each get their own.
    const foundA = findSessionFileById(dir, "agentA-id");
    const foundB = findSessionFileById(dir, "agentB-id");

    expect(foundA).toBe(fileA);
    expect(foundB).toBe(fileB);
    expect(foundA).not.toBe(foundB);
  });

  it("attributes each agent its own file under concurrency (nested subdirs)", () => {
    // Two concurrent tasks have different worktrees → different --<cwd>--
    // nested dirs. The old heuristic returned the newest across both;
    // the id-based lookup must be correct per-task.
    const dir = makeTempDir();

    const fileA = createNestedSession(dir, "worktree-a", "20260709T120000Z", "taskA-id", 300_000);
    const fileB = createNestedSession(dir, "worktree-b", "20260709T120001Z", "taskB-id", 200_000);

    const foundA = findSessionFileById(dir, "taskA-id");
    const foundB = findSessionFileById(dir, "taskB-id");

    expect(foundA).toBe(fileA);
    expect(foundB).toBe(fileB);
    expect(foundA).not.toBe(foundB);
  });

  it("end-to-end: two concurrent runs each rename their own file", () => {
    // Full N1 regression: two mock-finishers go through the real
    // findSessionFileById → renameSession path and each ends up with its
    // own correctly-named file.
    const dir = makeTempDir();

    // Agent A and B finish "concurrently" — both raw files exist at once.
    const rawA = createFlatSession(dir, "20260709T120000Z", "concurA", 300_000);
    const rawB = createFlatSession(dir, "20260709T120001Z", "concurB", 200_000);

    // Each agent looks up its file by id and renames it.
    const foundA = findSessionFileById(dir, "concurA");
    const foundB = findSessionFileById(dir, "concurB");
    expect(foundA).toBeDefined();
    expect(foundB).toBeDefined();

    const renamedA = renameSession(foundA!, dir, "task-A");
    const renamedB = renameSession(foundB!, dir, "task-B");

    // Both renamed files exist and are distinct.
    expect(existsSync(renamedA)).toBe(true);
    expect(existsSync(renamedB)).toBe(true);
    expect(renamedA).not.toBe(renamedB);

    // Raw files are gone (moved, not copied).
    expect(existsSync(rawA)).toBe(false);
    expect(existsSync(rawB)).toBe(false);
  });
});

// ── renameSession ────────────────────────────────────────────────────────────

describe("renameSession", () => {
  it("produces a {timecode}-{slug}.jsonl name and removes the source", () => {
    const dir = makeTempDir();
    const src = join(dir, "raw_session.jsonl");
    touch(src, "some agent output");

    const result = renameSession(src, dir, "My Task");

    // Target matches the expected pattern
    expect(result).toMatch(new RegExp(`^${dir}/\\d{8}T\\d{6}Z-my-task\\.jsonl$`));
    // Source no longer exists
    expect(existsSync(src)).toBe(false);
    // Target exists and has content
    expect(existsSync(result)).toBe(true);
  });

  it("slugifies complex names", () => {
    const dir = makeTempDir();
    const src = join(dir, "raw.jsonl");
    touch(src);

    const result = renameSession(src, dir, "Hello World!!! Feature #123");

    expect(result).toMatch(new RegExp(`^${dir}/\\d{8}T\\d{6}Z-hello-world-feature-123\\.jsonl$`));
    expect(existsSync(src)).toBe(false);
  });
});

// ── buildSpawnSessionArgs ────────────────────────────────────────────────────

describe("buildSpawnSessionArgs", () => {
  it("returns ['--session-dir', dir] when no resume file is given", () => {
    const result = buildSpawnSessionArgs("/tmp/sessions");
    expect(result).toEqual(["--session-dir", "/tmp/sessions"]);
  });

  it("returns ['--session-dir', dir, '--session', file] when resume is given", () => {
    const result = buildSpawnSessionArgs("/tmp/sessions", "/tmp/sessions/prev.jsonl");
    expect(result).toEqual([
      "--session-dir",
      "/tmp/sessions",
      "--session",
      "/tmp/sessions/prev.jsonl",
    ]);
  });

  it("returns only --session-dir when resume is empty string", () => {
    const result = buildSpawnSessionArgs("/tmp/sessions", "");
    expect(result).toEqual(["--session-dir", "/tmp/sessions"]);
  });

  it("does not mutate arguments between calls", () => {
    const without = buildSpawnSessionArgs("/a");
    const with_ = buildSpawnSessionArgs("/a", "/b");
    expect(without).toEqual(["--session-dir", "/a"]);
    expect(with_).toEqual(["--session-dir", "/a", "--session", "/b"]);
  });
});

// ── recordSessionPath ────────────────────────────────────────────────────────

describe("recordSessionPath", () => {
  it("appends sessionFile to the correct task's sessionFiles", () => {
    const taskA = makeTask({ id: "a", sessionFiles: [] });
    const taskB = makeTask({ id: "b", sessionFiles: [] });
    const state = makePoolState([taskA, taskB]);

    recordSessionPath(state, "a", "/sessions/file1.jsonl");
    recordSessionPath(state, "a", "/sessions/file2.jsonl");

    expect(taskA.sessionFiles).toEqual(["/sessions/file1.jsonl", "/sessions/file2.jsonl"]);
    // Other task untouched
    expect(taskB.sessionFiles).toEqual([]);
  });

  it("silently ignores an unknown task id", () => {
    const task = makeTask({ id: "known", sessionFiles: [] });
    const state = makePoolState([task]);

    recordSessionPath(state, "ghost", "/sessions/ghost.jsonl");

    expect(task.sessionFiles).toEqual([]);
  });

  it("appends to a task that already has session files", () => {
    const task = makeTask({ id: "x", sessionFiles: ["/old/file.jsonl"] });
    const state = makePoolState([task]);

    recordSessionPath(state, "x", "/new/file.jsonl");

    expect(task.sessionFiles).toEqual(["/old/file.jsonl", "/new/file.jsonl"]);
  });
});
