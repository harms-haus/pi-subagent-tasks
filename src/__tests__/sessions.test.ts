import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findSessionFile,
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
    branch: "pi-task-pool/test-pool",
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

// ── findSessionFile ──────────────────────────────────────────────────────────

describe("findSessionFile", () => {
  it("returns the NEWEST flat <ts>_<uuid>.jsonl when several exist", () => {
    const dir = makeTempDir();

    // Create three flat sessions with descending mtime
    const oldest = createFlatSession(dir, "20260709T100000Z", "aaaaaaaa", 100_000);
    const middle = createFlatSession(dir, "20260709T110000Z", "bbbbbbbb", 200_000);
    const newest = createFlatSession(dir, "20260709T120000Z", "cccccccc", 300_000);

    const found = findSessionFile(dir);
    expect(found).toBe(newest);
    // Sanity: path is absolute
    expect(found).toMatch(/^\//);

    // Files themselves still exist
    expect(existsSync(oldest)).toBe(true);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it("ignores non-session .jsonl files (without timestamp prefix)", () => {
    const dir = makeTempDir();
    // A plain .jsonl that doesn't match the pattern
    touch(join(dir, "random.jsonl"));
    setMtime(join(dir, "random.jsonl"), 500_000);

    // A real session file
    const session = createFlatSession(dir, "20260709T120000Z", "dddddddd", 100_000);

    const found = findSessionFile(dir);
    expect(found).toBe(session);
  });

  it("falls back to a nested --<cwd>--/<ts>_<uuid>.jsonl when no flat file exists", () => {
    const dir = makeTempDir();
    // Only a nested session, no flat files
    const nested = createNestedSession(dir, "my-repo", "20260709T120000Z", "eeeeeeee", 300_000);

    const found = findSessionFile(dir);
    expect(found).toBe(nested);
  });

  it("returns the newest nested session among multiple --<cwd>-- subdirs", () => {
    const dir = makeTempDir();
    createNestedSession(dir, "repo-a", "20260709T100000Z", "ffffffff", 100_000);
    const newerNested = createNestedSession(dir, "repo-b", "20260709T120000Z", "gggggggg", 300_000);

    const found = findSessionFile(dir);
    expect(found).toBe(newerNested);
  });

  it("prefers flat sessions over nested when both exist", () => {
    const dir = makeTempDir();
    // Flat session (older mtime)
    const flat = createFlatSession(dir, "20260709T090000Z", "hhhhhhhh", 50_000);
    // Nested session (newer mtime but flat takes precedence)
    createNestedSession(dir, "my-repo", "20260709T120000Z", "iiiiiiii", 300_000);

    const found = findSessionFile(dir);
    expect(found).toBe(flat);
  });

  it("returns undefined on an empty directory", () => {
    const dir = makeTempDir();
    expect(findSessionFile(dir)).toBeUndefined();
  });

  it("returns undefined when the directory does not exist", () => {
    const result = findSessionFile("/nonexistent/path/that/does/not/exist");
    expect(result).toBeUndefined();
  });

  it("returns undefined when only non-session files exist", () => {
    const dir = makeTempDir();
    touch(join(dir, "notes.txt"));
    touch(join(dir, "data.csv"));
    touch(join(dir, "build.log"));
    expect(findSessionFile(dir)).toBeUndefined();
  });

  it("returns undefined when nested subdir has no .jsonl files", () => {
    const dir = makeTempDir();
    const sub = join(dir, "--empty-cwd--");
    mkdirSync(sub, { recursive: true });
    touch(join(sub, "some.txt"));
    touch(join(sub, "other.csv"));
    expect(findSessionFile(dir)).toBeUndefined();
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
