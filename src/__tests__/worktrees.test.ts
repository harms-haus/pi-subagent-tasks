/**
 * Tests for worktree lifecycle management.
 *
 * Covers: pool & task worktree creation, ordered removal, .git/info/exclude
 * guard, repo/capability detection, fallback path resolution, and worktree
 * verification against pool state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { GitOps } from "../git-op";
import type { PoolState } from "../types";

import {
  createPoolWorktree,
  createTaskWorktree,
  removeTaskWorktree,
  ensureExcludeEntry,
  fallbackWorktreeDir,
  isGitRepo,
  canUseWorktrees,
  verifyWorktrees,
} from "../worktrees";

// ── Mock factory ─────────────────────────────────────────────────────────────

/**
 * Create a mock {@link GitOps} where every method is a `vi.fn()`.
 *
 * Default `worktreeList` returns a single entry matching the main repo.
 * All ref-mutating methods resolve to a default `ExecResult` (code 0).
 * Tests that need custom behaviour override the relevant method.
 */
function createMockGitOps(): GitOps {
  const lock: GitOps["lock"] = <T>(fn: () => Promise<T>): Promise<T> => fn();

  return {
    gitExec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    lock,
    statusPorcelain: vi.fn().mockResolvedValue(""),
    conflictedFiles: vi.fn().mockResolvedValue([]),
    worktreeList: vi
      .fn()
      .mockResolvedValue([
        { path: "/repo", head: "aaa", branch: "refs/heads/main", branchName: "main" },
      ]),
    lsFiles: vi.fn().mockResolvedValue([]),
    revParseHead: vi.fn().mockResolvedValue("abc123"),
    symbolicRefHead: vi.fn().mockResolvedValue("refs/heads/main"),
    worktreeAdd: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    worktreeRemove: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    worktreePrune: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    branchDelete: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    mergeFF: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    mergeAbort: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    commitAll: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    checkoutIn: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A partial PoolState with just enough for verifyWorktrees. */
function makePoolState(overrides?: Partial<PoolState>): PoolState {
  return {
    id: "test-pool",
    name: "Test Pool",
    branch: "pi-task-pool/test",
    poolWorktree: "/wt/pool",
    baseBranch: "main",
    limits: { total: 4, provider: {}, model: {} },
    maxRetries: 2,
    createdAt: 1000,
    updatedAt: 1000,
    status: "running",
    tasks: [],
    mergeQueue: [],
    ...overrides,
  };
}

/** Create a temp directory and return its path. */
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "wt-test-"));
}

/** Remove a temp directory and everything inside it. */
function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createPoolWorktree", () => {
  it("calls worktreeAdd with correct path, branch, and startPoint", async () => {
    const git = createMockGitOps();

    const result = await createPoolWorktree(git, "/repo", "pool-1", "my-pool", "main-sha");

    expect(result.path).toBe("/repo/.pi/task-pools/pool-1/worktrees/pool");
    expect(result.branch).toBe("pi-task-pool/my-pool");
    expect(git.worktreeAdd).toHaveBeenCalledWith({
      path: "/repo/.pi/task-pools/pool-1/worktrees/pool",
      branch: "pi-task-pool/my-pool",
      startPoint: "main-sha",
      cwd: "/repo",
    });
  });

  it("returns the path and branch", async () => {
    const git = createMockGitOps();

    const { path, branch } = await createPoolWorktree(git, "/repo", "p1", "slug", "head");

    expect(path).toContain("/repo/.pi/task-pools/p1/worktrees/pool");
    expect(branch).toBe("pi-task-pool/slug");
  });
});

describe("createTaskWorktree", () => {
  it("calls worktreeAdd with task-specific path and branch", async () => {
    const git = createMockGitOps();

    const result = await createTaskWorktree(
      git,
      "/repo",
      "pool-1",
      "my-pool",
      "t-1",
      "pool-head-sha",
    );

    expect(result.path).toBe("/repo/.pi/task-pools/pool-1/worktrees/t-1");
    expect(result.branch).toBe("pi-task-pool/my-pool/t-1");
    expect(git.worktreeAdd).toHaveBeenCalledWith({
      path: "/repo/.pi/task-pools/pool-1/worktrees/t-1",
      branch: "pi-task-pool/my-pool/t-1",
      startPoint: "pool-head-sha",
      cwd: "/repo",
    });
  });

  it("returns the task-specific path and branch", async () => {
    const git = createMockGitOps();

    const { path, branch } = await createTaskWorktree(git, "/repo", "p1", "slug", "t-42", "h");

    expect(path).toContain("t-42");
    expect(branch).toContain("t-42");
  });
});

describe("removeTaskWorktree", () => {
  it("removes worktree first, then branch, then prunes", async () => {
    const git = createMockGitOps();
    const order: string[] = [];

    git.worktreeRemove = vi.fn().mockImplementation(async () => {
      order.push("worktreeRemove");
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    git.branchDelete = vi.fn().mockImplementation(async () => {
      order.push("branchDelete");
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    git.worktreePrune = vi.fn().mockImplementation(async () => {
      order.push("worktreePrune");
      return { stdout: "", stderr: "", code: 0, killed: false };
    });

    await removeTaskWorktree(git, "/wt/t-1", "pi-task-pool/slug/t-1", "/repo");

    expect(order).toEqual(["worktreeRemove", "branchDelete", "worktreePrune"]);
  });

  it("passes force:true and cwd to worktreeRemove", async () => {
    const git = createMockGitOps();

    await removeTaskWorktree(git, "/wt/t-1", "pi-task-pool/slug/t-1", "/repo");

    expect(git.worktreeRemove).toHaveBeenCalledWith({
      path: "/wt/t-1",
      force: true,
      cwd: "/repo",
    });
  });

  it("passes force:true and cwd to branchDelete", async () => {
    const git = createMockGitOps();

    await removeTaskWorktree(git, "/wt/t-1", "pi-task-pool/slug/t-1", "/repo");

    expect(git.branchDelete).toHaveBeenCalledWith({
      name: "pi-task-pool/slug/t-1",
      force: true,
      cwd: "/repo",
    });
  });

  it("works without cwd", async () => {
    const git = createMockGitOps();

    await removeTaskWorktree(git, "/wt/t-1", "pi-task-pool/slug/t-1");

    expect(git.worktreeRemove).toHaveBeenCalledWith({
      path: "/wt/t-1",
      force: true,
      cwd: undefined,
    });
    expect(git.branchDelete).toHaveBeenCalledWith({
      name: "pi-task-pool/slug/t-1",
      force: true,
      cwd: undefined,
    });
    expect(git.worktreePrune).toHaveBeenCalledWith(undefined);
  });
});

describe("ensureExcludeEntry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tmpDir);
  });

  it("appends .pi/task-pools/ to info/exclude when file exists without it", async () => {
    const git = createMockGitOps();

    // gitExec returns the temp dir as the common git dir
    git.gitExec = vi.fn().mockResolvedValue({
      stdout: tmpDir + "\n",
      stderr: "",
      code: 0,
      killed: false,
    });

    // Pre-create info/exclude with some content
    const excludeDir = join(tmpDir, "info");
    mkdirSync(excludeDir, { recursive: true });
    const excludeFile = join(excludeDir, "exclude");
    writeFileSync(excludeFile, "# git exclude\n", "utf-8");

    await ensureExcludeEntry(git, "/repo");

    const content = readFileSync(excludeFile, "utf-8");
    expect(content).toBe("# git exclude\n\n.pi/task-pools/\n");
  });

  it("creates info/exclude when it does not exist", async () => {
    const git = createMockGitOps();

    git.gitExec = vi.fn().mockResolvedValue({
      stdout: tmpDir + "\n",
      stderr: "",
      code: 0,
      killed: false,
    });

    await ensureExcludeEntry(git, "/repo");

    const excludeFile = join(tmpDir, "info", "exclude");
    expect(existsSync(excludeFile)).toBe(true);
    const content = readFileSync(excludeFile, "utf-8");
    expect(content).toBe("\n.pi/task-pools/\n");
  });

  it("is idempotent — does not append when entry already present", async () => {
    const git = createMockGitOps();

    git.gitExec = vi.fn().mockResolvedValue({
      stdout: tmpDir + "\n",
      stderr: "",
      code: 0,
      killed: false,
    });

    const excludeDir = join(tmpDir, "info");
    mkdirSync(excludeDir, { recursive: true });
    const excludeFile = join(excludeDir, "exclude");
    writeFileSync(excludeFile, ".pi/task-pools/\n", "utf-8");

    // First call — entry already present, should be a no-op.
    await ensureExcludeEntry(git, "/repo");

    const content = readFileSync(excludeFile, "utf-8");
    expect(content).toBe(".pi/task-pools/\n");
    expect(content.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("calls git rev-parse --git-common-dir with the given cwd", async () => {
    const git = createMockGitOps();
    git.gitExec = vi.fn().mockResolvedValue({
      stdout: tmpDir + "\n",
      stderr: "",
      code: 0,
      killed: false,
    });

    await ensureExcludeEntry(git, "/my-repo");

    expect(git.gitExec).toHaveBeenCalledWith(["rev-parse", "--git-common-dir"], "/my-repo");
  });
});

describe("fallbackWorktreeDir", () => {
  it("returns the fallback path under .git/pi-task-pools", () => {
    const result = fallbackWorktreeDir("/repo", "pool-1");

    expect(result).toBe("/repo/.git/pi-task-pools/pool-1/worktrees");
  });
});

describe("isGitRepo", () => {
  it("returns true when git rev-parse succeeds with code 0", async () => {
    const git = createMockGitOps();

    const result = await isGitRepo(git, "/repo");

    expect(result).toBe(true);
    expect(git.gitExec).toHaveBeenCalledWith(["rev-parse", "--is-inside-work-tree"], "/repo");
  });

  it("returns false when gitExec throws", async () => {
    const git = createMockGitOps();
    git.gitExec = vi.fn().mockRejectedValue(new Error("not a git repo"));

    const result = await isGitRepo(git, "/repo");

    expect(result).toBe(false);
  });

  it("returns false when git exits with non-zero code", async () => {
    const git = createMockGitOps();
    git.gitExec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
      killed: false,
    });

    const result = await isGitRepo(git, "/repo");

    expect(result).toBe(false);
  });
});

describe("canUseWorktrees", () => {
  it("returns true when worktree list succeeds with code 0", async () => {
    const git = createMockGitOps();

    const result = await canUseWorktrees(git, "/repo");

    expect(result).toBe(true);
    expect(git.gitExec).toHaveBeenCalledWith(["worktree", "list", "--porcelain"], "/repo");
  });

  it("returns false when gitExec throws", async () => {
    const git = createMockGitOps();
    git.gitExec = vi.fn().mockRejectedValue(new Error("git not found"));

    const result = await canUseWorktrees(git, "/repo");

    expect(result).toBe(false);
  });

  it("returns false when git exits with non-zero code", async () => {
    const git = createMockGitOps();
    git.gitExec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "fatal: this operation must be run in a work tree",
      code: 128,
      killed: false,
    });

    const result = await canUseWorktrees(git, "/repo");

    expect(result).toBe(false);
  });
});

describe("verifyWorktrees", () => {
  it("returns empty array when all task worktree paths exist", async () => {
    const git = createMockGitOps();
    // The default mock worktreeList returns [{ path: "/repo", ... }]
    // We need to also include the task worktree paths
    git.worktreeList = vi.fn().mockResolvedValue([
      { path: "/repo", head: "aaa", branch: "refs/heads/main", branchName: "main" },
      {
        path: "/wt/t-1",
        head: "bbb",
        branch: "refs/heads/pi-task-pool/slug/t-1",
        branchName: "pi-task-pool/slug/t-1",
      },
    ]);

    const pool = makePoolState({
      tasks: [
        {
          id: "t-1",
          title: "Task 1",
          prompt: "do stuff",
          profile: undefined,
          dependsOn: [],
          compose: { type: "agent" },
          cursor: {
            kind: "agent",
            path: "",
            state: "done",
          },
          status: "done",
          retryCount: 0,
          runningAgentCount: 0,
          worktreePath: "/wt/t-1",
          branch: "pi-task-pool/slug/t-1",
          sessionFiles: [],
          downstreamCount: 0,
        },
      ],
    });

    const missing = await verifyWorktrees(git, pool, "/repo");

    expect(missing).toEqual([]);
  });

  it("returns task ids whose worktreePath is missing from the list", async () => {
    const git = createMockGitOps();
    // Default worktreeList only has the main repo, not /wt/t-1 or /wt/t-2
    git.worktreeList = vi
      .fn()
      .mockResolvedValue([
        { path: "/repo", head: "aaa", branch: "refs/heads/main", branchName: "main" },
      ]);

    const pool = makePoolState({
      tasks: [
        {
          id: "t-1",
          title: "Task 1",
          prompt: "do stuff",
          profile: undefined,
          dependsOn: [],
          compose: { type: "agent" },
          cursor: {
            kind: "agent",
            path: "",
            state: "done",
          },
          status: "done",
          retryCount: 0,
          runningAgentCount: 0,
          worktreePath: "/wt/t-1",
          branch: "pi-task-pool/slug/t-1",
          sessionFiles: [],
          downstreamCount: 0,
        },
        {
          id: "t-2",
          title: "Task 2",
          prompt: "more stuff",
          profile: undefined,
          dependsOn: [],
          compose: { type: "agent" },
          cursor: {
            kind: "agent",
            path: "",
            state: "done",
          },
          status: "done",
          retryCount: 0,
          runningAgentCount: 0,
          worktreePath: "/wt/t-2",
          branch: "pi-task-pool/slug/t-2",
          sessionFiles: [],
          downstreamCount: 0,
        },
      ],
    });

    const missing = await verifyWorktrees(git, pool, "/repo");

    expect(missing).toEqual(["t-1", "t-2"]);
  });

  it("skips tasks with null worktreePath", async () => {
    const git = createMockGitOps();
    git.worktreeList = vi
      .fn()
      .mockResolvedValue([
        { path: "/repo", head: "aaa", branch: "refs/heads/main", branchName: "main" },
      ]);

    const pool = makePoolState({
      tasks: [
        {
          id: "t-1",
          title: "Task 1",
          prompt: "do stuff",
          profile: undefined,
          dependsOn: [],
          compose: { type: "agent" },
          cursor: {
            kind: "agent",
            path: "",
            state: "done",
          },
          status: "done",
          retryCount: 0,
          runningAgentCount: 0,
          worktreePath: null,
          branch: "pi-task-pool/slug/t-1",
          sessionFiles: [],
          downstreamCount: 0,
        },
        {
          id: "t-2",
          title: "Task 2",
          prompt: "more stuff",
          profile: undefined,
          dependsOn: [],
          compose: { type: "agent" },
          cursor: {
            kind: "agent",
            path: "",
            state: "done",
          },
          status: "done",
          retryCount: 0,
          runningAgentCount: 0,
          worktreePath: "/wt/t-2",
          branch: "pi-task-pool/slug/t-2",
          sessionFiles: [],
          downstreamCount: 0,
        },
      ],
    });

    const missing = await verifyWorktrees(git, pool, "/repo");

    // t-1 has null worktreePath so it's skipped
    expect(missing).toEqual(["t-2"]);
  });

  it("calls worktreeList with the given cwd", async () => {
    const git = createMockGitOps();
    const pool = makePoolState();

    await verifyWorktrees(git, pool, "/other-repo");

    expect(git.worktreeList).toHaveBeenCalledWith("/other-repo");
  });
});
