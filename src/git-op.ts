/**
 * Git operation primitives with a promise-chain serialization mutex.
 *
 * IMPORTANT — git's single-process model for shared .git/ means ALL
 * ref-mutating operations MUST be serialized under one mutex.  Read-only
 * operations bypass the mutex and can run concurrently.
 *
 * Imported by the worktree/pool layer.
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExecResult } from "./types";

// ── Module-level constants ───────────────────────────────────────────────────

const WORKTREE_PREFIX = "worktree ";
const HEAD_PREFIX = "HEAD ";
const BRANCH_PREFIX = "branch ";
const REFS_HEADS_PREFIX = "refs/heads/";
const DETACHED = "detached";

// ── Data model ───────────────────────────────────────────────────────────────

/** Parsed entry from `git worktree list --porcelain`. */
export interface WorktreeInfo {
  /** Absolute path to the worktree. */
  path: string;
  /** Full SHA of HEAD. */
  head: string;
  /** Full ref (e.g. `refs/heads/main`) or `"detached"`. */
  branch: string;
  /** Short branch name (e.g. `main`) or empty string when detached. */
  branchName: string;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface GitOps {
  // ── Low-level exec ─────────────────────────────────────────────────────

  /**
   * Execute a git command through the extension API.
   *
   * NOTE — This raw exec bypasses the promise-chain mutex.  Callers that
   * perform ref-mutating operations must self-serialise, for example by
   * wrapping the call in {@link GitOps.lock}.
   */
  gitExec(args: string[], cwd?: string): Promise<ExecResult>;

  // ── Mutex ──────────────────────────────────────────────────────────────

  /**
   * Run `fn` under the promise-chain mutex.  Returns its result.
   * Multiple concurrent calls are queued and run strictly sequentially.
   */
  lock<T>(fn: () => Promise<T>): Promise<T>;

  // ── Read-only (no mutex) ───────────────────────────────────────────────

  /** `git status --porcelain` output. */
  statusPorcelain(cwd?: string): Promise<string>;

  /** Paths with unmerged conflicts via `git diff --name-only --diff-filter=U`. */
  conflictedFiles(cwd?: string): Promise<string[]>;

  /** Parsed `git worktree list --porcelain`. */
  worktreeList(cwd?: string): Promise<WorktreeInfo[]>;

  /** `git rev-parse HEAD` (trimmed). */
  revParseHead(cwd?: string): Promise<string>;

  // ── Ref-mutating (under mutex) ─────────────────────────────────────────

  /** Create a new worktree with a new branch (`worktree add -b`). */
  worktreeAdd(opts: {
    path: string;
    branch: string;
    startPoint?: string;
    cwd?: string;
  }): Promise<ExecResult>;

  /**
   * Remove a worktree.  Pass `opts.force = true` to delete dirty or locked
   * worktrees (sends `-f -f`).
   */
  worktreeRemove(opts: { path: string; force?: boolean; cwd?: string }): Promise<ExecResult>;

  /** Prune stale worktree administrative data. */
  worktreePrune(cwd?: string): Promise<ExecResult>;

  /** Delete a branch (`-d` or `-D`). */
  branchDelete(opts: { name: string; force?: boolean; cwd?: string }): Promise<ExecResult>;

  /** Fast-forward merge (`merge --ff-only`). */
  mergeFF(branch: string, cwd?: string): Promise<ExecResult>;

  /** Abort an in-progress merge. */
  mergeAbort(cwd?: string): Promise<ExecResult>;

  /** Stage all changes and commit (`add -A` + `commit -m`). */
  commitAll(message: string, cwd?: string): Promise<ExecResult>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate the exit code from a git command.
 *
 * Throws when `code !== 0` so callers that expect a clean exit don't
 * silently treat error stdout as valid data.  Returns the result untouched
 * when code is 0, allowing `.then(checkCode).then(...)` chaining.
 */
function checkCode(r: ExecResult): ExecResult {
  if (r.code !== 0) {
    throw new Error(`git exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a {@link GitOps} instance bound to the pi extension API.
 *
 * @param pi - The extension API (provides `exec` for shell commands).
 */
export function createGitOps(pi: ExtensionAPI): GitOps {
  // ── Promise-chain mutex ────────────────────────────────────────────────
  let chain: Promise<undefined> = Promise.resolve(undefined);

  function lock<T>(fn: () => Promise<T>): Promise<T> {
    // chain never rejects (see the error-swallowing .then on the next line),
    // so the onRejected handler on .then() is dead — .then(fn) is sufficient.
    const result = chain.then(fn);
    // Swallow errors on the tracking chain so a single rejection
    // doesn't permanently break serialization.
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ── Low-level exec ─────────────────────────────────────────────────────

  function gitExec(args: string[], cwd?: string): Promise<ExecResult> {
    return cwd !== undefined ? pi.exec("git", args, { cwd }) : pi.exec("git", args);
  }

  // ── Read-only operations ───────────────────────────────────────────────

  function statusPorcelain(cwd?: string): Promise<string> {
    return gitExec(["status", "--porcelain"], cwd)
      .then(checkCode)
      .then((r) => r.stdout);
  }

  function conflictedFiles(cwd?: string): Promise<string[]> {
    return gitExec(["diff", "--name-only", "--diff-filter=U"], cwd)
      .then(checkCode)
      .then((r) => {
        const trimmed = r.stdout.trim();
        return trimmed.length > 0 ? trimmed.split("\n") : [];
      });
  }

  function worktreeList(cwd?: string): Promise<WorktreeInfo[]> {
    return gitExec(["worktree", "list", "--porcelain"], cwd)
      .then(checkCode)
      .then((r) => parseWorktreePorcelain(r.stdout));
  }

  function revParseHead(cwd?: string): Promise<string> {
    return gitExec(["rev-parse", "HEAD"], cwd)
      .then(checkCode)
      .then((r) => r.stdout.trim());
  }

  // ── Ref-mutating operations (each wrapped in lock) ─────────────────────

  function worktreeAdd(opts: {
    path: string;
    branch: string;
    startPoint?: string;
    cwd?: string;
  }): Promise<ExecResult> {
    return lock(() => {
      const args = ["worktree", "add", "-b", opts.branch, opts.path];
      if (opts.startPoint) {
        args.push(opts.startPoint);
      }
      // Never report a worktree as created when git rejected the branch/path.
      return gitExec(args, opts.cwd).then(checkCode);
    });
  }

  function worktreeRemove(opts: {
    path: string;
    force?: boolean;
    cwd?: string;
  }): Promise<ExecResult> {
    return lock(() => {
      const args = ["worktree", "remove"];
      if (opts.force) {
        args.push("-f", "-f");
      }
      args.push(opts.path);
      return gitExec(args, opts.cwd).then(checkCode);
    });
  }

  function worktreePrune(cwd?: string): Promise<ExecResult> {
    return lock(() => gitExec(["worktree", "prune"], cwd).then(checkCode));
  }

  function branchDelete(opts: {
    name: string;
    force?: boolean;
    cwd?: string;
  }): Promise<ExecResult> {
    return lock(() => {
      const args = ["branch"];
      args.push(opts.force ? "-D" : "-d");
      args.push(opts.name);
      return gitExec(args, opts.cwd).then(checkCode);
    });
  }

  function mergeFF(branch: string, cwd?: string): Promise<ExecResult> {
    return lock(() => gitExec(["merge", "--ff-only", branch], cwd));
  }

  function mergeAbort(cwd?: string): Promise<ExecResult> {
    return lock(() => gitExec(["merge", "--abort"], cwd).then(checkCode));
  }

  function commitAll(message: string, cwd?: string): Promise<ExecResult> {
    return lock(async () => {
      checkCode(await gitExec(["add", "-A"], cwd));
      return gitExec(["commit", "-m", message], cwd).then(checkCode);
    });
  }

  // ── Assemble ───────────────────────────────────────────────────────────

  return {
    gitExec,
    lock,
    statusPorcelain,
    conflictedFiles,
    worktreeList,
    revParseHead,
    worktreeAdd,
    worktreeRemove,
    worktreePrune,
    branchDelete,
    mergeFF,
    mergeAbort,
    commitAll,
  };
}

// ── Standalone parser ────────────────────────────────────────────────────────

/**
 * Parse the output of `git worktree list --porcelain`.
 *
 * Blocks are separated by blank lines; each block contains:
 * ```
 * worktree <path>
 * HEAD <sha>
 * branch refs/heads/<name>   | detached
 * ```
 */
export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  // Normalise CRLF so Windows porcelain doesn't leave stray \r on paths/SHAs.
  const normalised = output.replace(/\r\n/g, "\n");
  const blocks = normalised.split(/\n{2,}/);
  const result: WorktreeInfo[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;

    const lines = trimmed.split("\n");
    let path = "";
    let head = "";
    let branch = "";
    let branchName = "";

    for (const line of lines) {
      if (line.startsWith(WORKTREE_PREFIX)) {
        path = line.slice(WORKTREE_PREFIX.length);
      } else if (line.startsWith(HEAD_PREFIX)) {
        head = line.slice(HEAD_PREFIX.length);
      } else if (line === DETACHED) {
        branch = DETACHED;
        branchName = "";
      } else if (line.startsWith(BRANCH_PREFIX)) {
        branch = line.slice(BRANCH_PREFIX.length);
        branchName = branch.startsWith(REFS_HEADS_PREFIX)
          ? branch.slice(REFS_HEADS_PREFIX.length)
          : branch;
      }
      // Other lines (e.g. "bare") are silently ignored.
    }

    result.push({ path, head, branch, branchName });
  }

  return result;
}
