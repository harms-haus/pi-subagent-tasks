/**
 * Tests for the git operation primitives and serialization mutex.
 *
 * Covers: read-only operations, ref-mutating operations (each wrapped in
 * the promise-chain mutex), parseWorktreePorcelain, lock serialization
 * semantics, and the guarantee that read-only ops bypass the mutex.
 */

import { describe, it, expect, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createGitOps, parseWorktreePorcelain } from "../git-op";
import type { GitOps } from "../git-op";

// ── Fixture ──────────────────────────────────────────────────────────────────

interface Fixture {
  gitOps: GitOps;
  exec: ReturnType<typeof vi.fn>;
}

function createFixture(): Fixture {
  const exec = vi.fn();
  exec.mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });
  const api = { exec } as unknown as ExtensionAPI;
  const gitOps = createGitOps(api);
  return { gitOps, exec };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("gitExec", () => {
  it("calls pi.exec with command, args, and cwd when provided", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.gitExec(["status", "--porcelain"], "/repo");

    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"], {
      cwd: "/repo",
    });
  });

  it("calls pi.exec without options when cwd is omitted", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.gitExec(["rev-parse", "HEAD"]);

    expect(exec).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"]);
  });

  it("surfaces stdout, stderr, code, and killed from pi.exec", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({
      stdout: "abc123\n",
      stderr: "",
      code: 0,
      killed: false,
    });

    const result = await gitOps.gitExec(["rev-parse", "HEAD"]);
    expect(result.stdout).toBe("abc123\n");
    expect(result.code).toBe(0);
    expect(result.killed).toBe(false);
  });

  it("passes through error results", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
      killed: false,
    });

    const result = await gitOps.gitExec(["rev-parse", "HEAD"]);
    expect(result.code).toBe(128);
    expect(result.stderr).toContain("not a git repository");
  });
});

// ── parseWorktreePorcelain ───────────────────────────────────────────────────

describe("parseWorktreePorcelain", () => {
  it("parses a multi-worktree porcelain block with detached worktree", () => {
    const output = [
      "worktree /main/repo",
      "HEAD a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b",
      "branch refs/heads/main",
      "",
      "worktree /other/feature",
      "HEAD f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e",
      "branch refs/heads/feature-x",
      "",
      "worktree /other/detached",
      "HEAD 0000111122223333444455556666777788889999",
      "detached",
    ].join("\n");

    const result = parseWorktreePorcelain(output);

    expect(result).toHaveLength(3);

    // Main worktree
    expect(result[0]!.path).toBe("/main/repo");
    expect(result[0]!.head).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b");
    expect(result[0]!.branch).toBe("refs/heads/main");
    expect(result[0]!.branchName).toBe("main");

    // Feature worktree
    expect(result[1]!.path).toBe("/other/feature");
    expect(result[1]!.branch).toBe("refs/heads/feature-x");
    expect(result[1]!.branchName).toBe("feature-x");

    // Detached worktree
    expect(result[2]!.path).toBe("/other/detached");
    expect(result[2]!.head).toBe("0000111122223333444455556666777788889999");
    expect(result[2]!.branch).toBe("detached");
    expect(result[2]!.branchName).toBe("");
  });

  it("returns empty array for empty output", () => {
    expect(parseWorktreePorcelain("")).toHaveLength(0);
    expect(parseWorktreePorcelain("   ")).toHaveLength(0);
    expect(parseWorktreePorcelain("\n\n\n")).toHaveLength(0);
  });

  it("parses a single main worktree", () => {
    const output = [
      "worktree /repo",
      "HEAD abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      "branch refs/heads/main",
    ].join("\n");

    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("/repo");
    expect(result[0]!.branchName).toBe("main");
  });

  it("handles trailing and leading whitespace", () => {
    const output = "\n  \nworktree /repo\nHEAD aaa\nbranch refs/heads/main\n\n";

    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("/repo");
  });

  it("falls back to raw branchName when branch is not refs/heads/ prefixed", () => {
    const output = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /other/wt",
      "HEAD bbb",
      "branch some-custom-ref",
    ].join("\n");

    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(2);
    expect(result[0]!.branchName).toBe("main");
    expect(result[1]!.branchName).toBe("some-custom-ref");
  });

  it("ignores non-standard lines like bare", () => {
    const output = ["worktree /repo", "HEAD aaa", "branch refs/heads/main", "bare"].join("\n");

    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("/repo");
  });

  it("handles CRLF line endings", () => {
    const output =
      "worktree /repo\r\nHEAD aaa\r\nbranch refs/heads/main\r\n\r\nworktree /other\r\nHEAD bbb\r\ndetached";

    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(2);
    expect(result[0]!.path).toBe("/repo");
    expect(result[0]!.branchName).toBe("main");
    expect(result[1]!.path).toBe("/other");
    expect(result[1]!.branch).toBe("detached");
    expect(result[1]!.branchName).toBe("");
  });
});

// ── Read-only operations ─────────────────────────────────────────────────────

describe("read-only operations", () => {
  it("statusPorcelain returns stdout", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({
      stdout: "M  src/index.ts\n",
      stderr: "",
      code: 0,
      killed: false,
    });

    const out = await gitOps.statusPorcelain("/repo");
    expect(out).toBe("M  src/index.ts\n");
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"], {
      cwd: "/repo",
    });
  });

  it("statusPorcelain works without cwd", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.statusPorcelain();
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"]);
  });

  it("conflictedFiles splits diff-filter output", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({
      stdout: "src/file1.ts\nsrc/file2.ts\n",
      stderr: "",
      code: 0,
      killed: false,
    });

    const files = await gitOps.conflictedFiles("/repo");
    expect(files).toEqual(["src/file1.ts", "src/file2.ts"]);
    expect(exec).toHaveBeenCalledWith("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: "/repo",
    });
  });

  it("conflictedFiles returns empty array when no conflicts", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    });

    const files = await gitOps.conflictedFiles();
    expect(files).toEqual([]);
    expect(exec).toHaveBeenCalledWith("git", ["diff", "--name-only", "--diff-filter=U"]);
  });

  it("conflictedFiles returns single file", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({
      stdout: "package.json\n",
      stderr: "",
      code: 0,
      killed: false,
    });

    const files = await gitOps.conflictedFiles();
    expect(files).toEqual(["package.json"]);
  });

  it("worktreeList calls porcelain and parses result", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({
      stdout: ["worktree /repo", "HEAD aaa", "branch refs/heads/main"].join("\n"),
      stderr: "",
      code: 0,
      killed: false,
    });

    const list = await gitOps.worktreeList("/repo");
    expect(list).toHaveLength(1);
    expect(list[0]!.path).toBe("/repo");
    expect(exec).toHaveBeenCalledWith("git", ["worktree", "list", "--porcelain"], { cwd: "/repo" });
  });

  it("revParseHead returns trimmed SHA", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({
      stdout: "abc123\n",
      stderr: "",
      code: 0,
      killed: false,
    });

    const sha = await gitOps.revParseHead("/repo");
    expect(sha).toBe("abc123");
  });
});

// ── checkCode (read-only ops throw on non-zero exit) ─────────────────────────

describe("read-only ops throw on git error", () => {
  function makeFixture(exec: ReturnType<typeof vi.fn>) {
    const api = { exec } as unknown as ExtensionAPI;
    return createGitOps(api);
  }

  it("statusPorcelain throws when git exits non-zero", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
      killed: false,
    });
    const gitOps = makeFixture(exec);

    await expect(gitOps.statusPorcelain()).rejects.toThrow(
      "git exited 128: fatal: not a git repository",
    );
  });

  it("conflictedFiles throws when git exits non-zero", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "fatal: ambiguous argument",
      code: 128,
      killed: false,
    });
    const gitOps = makeFixture(exec);

    await expect(gitOps.conflictedFiles()).rejects.toThrow(
      "git exited 128: fatal: ambiguous argument",
    );
  });

  it("worktreeList throws when git exits non-zero", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "fatal: this operation must be run in a work tree",
      code: 128,
      killed: false,
    });
    const gitOps = makeFixture(exec);

    await expect(gitOps.worktreeList()).rejects.toThrow(
      "git exited 128: fatal: this operation must be run in a work tree",
    );
  });

  it("revParseHead throws when git exits non-zero", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
      killed: false,
    });
    const gitOps = makeFixture(exec);

    await expect(gitOps.revParseHead()).rejects.toThrow(
      "git exited 128: fatal: not a git repository",
    );
  });
});

// ── Ref-mutating operations (under mutex) ────────────────────────────────────

describe("ref-mutating operations", () => {
  it("worktreeAdd builds correct args without startPoint", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.worktreeAdd({ path: "/wt/feat", branch: "feat-x" });

    expect(exec).toHaveBeenCalledWith("git", ["worktree", "add", "-b", "feat-x", "/wt/feat"]);
  });

  it("worktreeAdd rejects when git cannot create the branch or directory", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({
      stdout: "",
      stderr: "fatal: cannot lock ref",
      code: 128,
      killed: false,
    });

    await expect(gitOps.worktreeAdd({ path: "/wt/feat", branch: "feat-x" })).rejects.toThrow(
      "git exited 128: fatal: cannot lock ref",
    );
  });

  it("worktreeAdd includes startPoint when provided", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.worktreeAdd({
      path: "/wt/feat",
      branch: "feat-x",
      startPoint: "main",
      cwd: "/repo",
    });

    expect(exec).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "feat-x", "/wt/feat", "main"],
      { cwd: "/repo" },
    );
  });

  it("worktreeRemove passes path without force", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.worktreeRemove({ path: "/wt/feat" });

    expect(exec).toHaveBeenCalledWith("git", ["worktree", "remove", "/wt/feat"]);
  });

  it("worktreeRemove rejects when git fails", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({ stdout: "", stderr: "worktree is locked", code: 128, killed: false });

    await expect(gitOps.worktreeRemove({ path: "/wt/feat" })).rejects.toThrow(
      "git exited 128: worktree is locked",
    );
  });

  it("worktreeRemove passes force flags when force is true", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.worktreeRemove({ path: "/wt/feat", force: true });

    expect(exec).toHaveBeenCalledWith("git", ["worktree", "remove", "-f", "-f", "/wt/feat"]);
  });

  it("worktreeRemove passes cwd when provided", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.worktreeRemove({ path: "/wt/feat", cwd: "/repo" });

    expect(exec).toHaveBeenCalledWith("git", ["worktree", "remove", "/wt/feat"], { cwd: "/repo" });
  });

  it("worktreePrune calls prune", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.worktreePrune();

    expect(exec).toHaveBeenCalledWith("git", ["worktree", "prune"]);
  });

  it("worktreePrune rejects when git fails", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({ stdout: "", stderr: "prune failed", code: 1, killed: false });

    await expect(gitOps.worktreePrune()).rejects.toThrow("git exited 1: prune failed");
  });

  it("branchDelete uses -d without force", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.branchDelete({ name: "old-branch" });

    expect(exec).toHaveBeenCalledWith("git", ["branch", "-d", "old-branch"]);
  });

  it("branchDelete uses -D with force", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.branchDelete({ name: "old-branch", force: true });

    expect(exec).toHaveBeenCalledWith("git", ["branch", "-D", "old-branch"]);
  });

  it("branchDelete passes cwd when provided", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.branchDelete({ name: "old-branch", cwd: "/repo" });

    expect(exec).toHaveBeenCalledWith("git", ["branch", "-d", "old-branch"], { cwd: "/repo" });
  });

  it("branchDelete rejects when git fails", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({ stdout: "", stderr: "branch not found", code: 1, killed: false });

    await expect(gitOps.branchDelete({ name: "old-branch" })).rejects.toThrow(
      "git exited 1: branch not found",
    );
  });

  it("mergeFF calls merge --ff-only with cwd", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.mergeFF("feature-branch", "/repo");

    expect(exec).toHaveBeenCalledWith("git", ["merge", "--ff-only", "feature-branch"], {
      cwd: "/repo",
    });
  });

  it("mergeFF works without cwd", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.mergeFF("feature-branch");

    expect(exec).toHaveBeenCalledWith("git", ["merge", "--ff-only", "feature-branch"]);
  });

  it("mergeFF preserves a non-zero result for fallback handling", async () => {
    const { gitOps, exec } = createFixture();
    const failure = { stdout: "", stderr: "not a fast-forward", code: 1, killed: false };
    exec.mockResolvedValue(failure);

    await expect(gitOps.mergeFF("feature-branch")).resolves.toEqual(failure);
  });

  it("mergeAbort calls merge --abort", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.mergeAbort("/repo");

    expect(exec).toHaveBeenCalledWith("git", ["merge", "--abort"], {
      cwd: "/repo",
    });
  });

  it("mergeAbort rejects when git fails", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValue({ stdout: "", stderr: "no merge to abort", code: 128, killed: false });

    await expect(gitOps.mergeAbort()).rejects.toThrow("git exited 128: no merge to abort");
  });

  it("commitAll stages then commits and returns the commit result", async () => {
    const { gitOps, exec } = createFixture();
    const staged = { stdout: "", stderr: "", code: 0, killed: false };
    const committed = { stdout: "[main abc123] my message\n", stderr: "", code: 0, killed: false };
    exec.mockResolvedValueOnce(staged).mockResolvedValueOnce(committed);

    await expect(gitOps.commitAll("my message", "/repo")).resolves.toBe(committed);

    expect(exec).toHaveBeenNthCalledWith(1, "git", ["add", "-A"], {
      cwd: "/repo",
    });
    expect(exec).toHaveBeenNthCalledWith(2, "git", ["commit", "-m", "my message"], {
      cwd: "/repo",
    });
  });

  it("commitAll works without cwd", async () => {
    const { gitOps, exec } = createFixture();

    await gitOps.commitAll("quick fix");

    expect(exec).toHaveBeenNthCalledWith(1, "git", ["add", "-A"]);
    expect(exec).toHaveBeenNthCalledWith(2, "git", ["commit", "-m", "quick fix"]);
  });

  it("commitAll rejects a staging failure without attempting commit", async () => {
    const { gitOps, exec } = createFixture();
    exec.mockResolvedValueOnce({
      stdout: "",
      stderr: "fatal: unable to index file",
      code: 128,
      killed: false,
    });

    await expect(gitOps.commitAll("my message", "/repo")).rejects.toThrow(
      "git exited 128: fatal: unable to index file",
    );

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("git", ["add", "-A"], { cwd: "/repo" });
  });

  it("commitAll rejects when commit fails", async () => {
    const { gitOps, exec } = createFixture();
    exec
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, killed: false })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "nothing to commit",
        code: 1,
        killed: false,
      });

    await expect(gitOps.commitAll("my message")).rejects.toThrow("git exited 1: nothing to commit");

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(2, "git", ["commit", "-m", "my message"]);
  });
});

// ── Mutex (lock) ─────────────────────────────────────────────────────────────

describe("lock", () => {
  it("serializes concurrent calls", async () => {
    const { gitOps } = createFixture();
    const order: number[] = [];

    const p1 = gitOps.lock(async () => {
      order.push(1);
      await Promise.resolve(); // yield to microtask queue
      order.push(2);
      return "a";
    });

    const p2 = gitOps.lock(async () => {
      order.push(3);
      return "b";
    });

    expect(await p1).toBe("a");
    expect(await p2).toBe("b");
    expect(order).toEqual([1, 2, 3]);
  });

  it("chains after a rejection (error does not break serialization)", async () => {
    const { gitOps } = createFixture();
    const order: number[] = [];

    const p1 = gitOps.lock(async () => {
      order.push(1);
      throw new Error("first failed");
    });

    const p2 = gitOps.lock(async () => {
      order.push(2);
      return "ok";
    });

    await expect(p1).rejects.toThrow("first failed");
    expect(await p2).toBe("ok");
    expect(order).toEqual([1, 2]);
  });

  it("returns the resolved value from the inner function", async () => {
    const { gitOps } = createFixture();

    const result = await gitOps.lock(async () => 42);
    expect(result).toBe(42);
  });

  it("serializes three concurrent lock calls", async () => {
    const { gitOps } = createFixture();
    const order: number[] = [];

    await Promise.all([
      gitOps.lock(async () => {
        order.push(1);
        await Promise.resolve();
        order.push(2);
      }),
      gitOps.lock(async () => {
        order.push(3);
        await Promise.resolve();
        order.push(4);
      }),
      gitOps.lock(async () => {
        order.push(5);
      }),
    ]);

    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("maintains ordering even with varying durations", async () => {
    const { gitOps } = createFixture();
    const order: string[] = [];

    // Deliberately resolve out of order: slowest first, but lock should
    // enforce sequential execution.
    await Promise.all([
      gitOps.lock(async () => {
        order.push("first-start");
        await Promise.resolve();
        await Promise.resolve();
        order.push("first-end");
      }),
      gitOps.lock(async () => {
        order.push("second-start");
        order.push("second-end");
      }),
    ]);

    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });
});

// ── Mutex bypass (read-only ops do NOT go through lock) ──────────────────────

describe("read-only ops bypass the mutex", () => {
  it("statusPorcelain calls exec synchronously while mutex op is queued", () => {
    const { gitOps, exec } = createFixture();

    // Start a mutex op first – its exec call is queued as a microtask.
    void gitOps.worktreeAdd({ path: "/wt", branch: "fb" });

    // Immediately call a read-only op – its exec call is synchronous.
    void gitOps.statusPorcelain();

    // The read-only op's exec call happens before the mutex op's exec call.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"]);
  });

  it("conflictedFiles calls exec synchronously while mutex op queued", () => {
    const { gitOps, exec } = createFixture();

    void gitOps.branchDelete({ name: "old" });
    void gitOps.conflictedFiles();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("git", ["diff", "--name-only", "--diff-filter=U"]);
  });

  it("worktreeList calls exec synchronously while mutex op queued", () => {
    const { gitOps, exec } = createFixture();

    void gitOps.mergeAbort();
    void gitOps.worktreeList();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("git", ["worktree", "list", "--porcelain"]);
  });

  it("read-only ops complete independently of the lock chain", async () => {
    const { gitOps, exec } = createFixture();

    // Queue a slow mutex op
    const mutexPromise = gitOps.worktreeAdd({ path: "/wt", branch: "fb" });

    // Read-only op should resolve without waiting for the mutex
    const readPromise = gitOps.statusPorcelain();

    await readPromise;
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"]);

    await mutexPromise;
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
