/**
 * Worktree lifecycle management for pi-task-pools.
 *
 * Handles creation, removal, and verification of pool & task worktrees,
 * plus the `.git/info/exclude` guard (§10.1, §10.4, §10.5).
 *
 * All ref-mutating git operations are delegated to {@link GitOps}, which
 * serialises them under a promise-chain mutex (see git-op.ts).
 *
 * @module
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { GitOps } from "./git-op";
import type { PoolState } from "./types";
import { BRANCH_PREFIX, FALLBACK_WT_DIR_REL } from "./constants";
import { poolDir } from "./utils";

// ── Worktree creation (§10.1) ────────────────────────────────────────────────

/**
 * Create the single pool worktree.
 *
 * Path: `<cwd>/.pi/task-pools/<poolId>/worktrees/pool`
 * Branch: `pi-task-pool/<slug>`
 *
 * The pool worktree is created once per pool and persists for the pool's
 * lifetime. It shares the common `.git/` directory with the primary working
 * tree so that all task worktrees derived from it share the same object store.
 */
export async function createPoolWorktree(
  git: GitOps,
  cwd: string,
  poolId: string,
  slug: string,
  baseHead: string,
): Promise<{ path: string; branch: string }> {
  const path = join(poolDir(cwd, poolId), "worktrees", "pool");
  const branch = `${BRANCH_PREFIX}/${slug}`;

  await git.worktreeAdd({ path, branch, startPoint: baseHead, cwd });

  return { path, branch };
}

/**
 * Create a task-specific worktree.
 *
 * Path: `<cwd>/.pi/task-pools/<poolId>/worktrees/<taskId>`
 * Branch: `pi-task-pool/<slug>/<taskId>`
 *
 * Task worktrees are ephemeral: they exist only while the task is running
 * and are removed when the task reaches a terminal state (§10.4).
 */
export async function createTaskWorktree(
  git: GitOps,
  cwd: string,
  poolId: string,
  slug: string,
  taskId: string,
  poolHead: string,
): Promise<{ path: string; branch: string }> {
  const path = join(poolDir(cwd, poolId), "worktrees", taskId);
  const branch = `${BRANCH_PREFIX}/${slug}/${taskId}`;

  await git.worktreeAdd({ path, branch, startPoint: poolHead, cwd });

  return { path, branch };
}

// ── Worktree removal (§10.4) ─────────────────────────────────────────────────

/**
 * Remove a task worktree and its associated branch.
 *
 * ORDER MATTERS — the worktree must be removed before the branch can be
 * deleted, and pruning should happen last to clean up any stale metadata
 * left by the removal.
 *
 * 1. `git worktree remove -f -f <path>`
 * 2. `git branch -D <branch>`
 * 3. `git worktree prune`
 */
export async function removeTaskWorktree(
  git: GitOps,
  path: string,
  branch: string,
  cwd?: string,
): Promise<void> {
  await git.worktreeRemove({ path, force: true, cwd });
  await git.branchDelete({ name: branch, force: true, cwd });
  await git.worktreePrune(cwd);
}

// ── .git/info/exclude guard (§10.5) ──────────────────────────────────────────

/**
 * Ensure the repository's `info/exclude` contains a `.pi/task-pools/` entry.
 *
 * Git worktrees that are _nested_ inside the main working tree (always the
 * case for pi-task-pools) must be excluded from the main tree's tracking so
 * that `git status` on the primary working tree does not show the pool
 * directories as untracked content.
 *
 * The approach:
 * 1. Resolve the common git directory via `git rev-parse --git-common-dir`.
 * 2. Read `<commonDir>/info/exclude` (if it exists).
 * 3. If a line containing `.pi/task-pools/` is already present, return
 *    immediately (idempotent).
 * 4. Otherwise, append `\n.pi/task-pools/\n` to the file.
 *
 * This is a LOCAL-only operation — the exclude file is private to the clone
 * and never committed.
 *
 * @throws {Error} If `gitExec` fails (non-existent / non-git directory).
 */
export async function ensureExcludeEntry(git: GitOps, cwd: string): Promise<void> {
  const r = await git.gitExec(["rev-parse", "--git-common-dir"], cwd);
  const commonDir = r.stdout.trim();
  const excludePath = join(commonDir, "info", "exclude");

  if (existsSync(excludePath)) {
    const content = readFileSync(excludePath, "utf-8");
    if (content.includes(".pi/task-pools/")) {
      return; // Already present — idempotent.
    }
  }

  // Ensure the info directory exists (it always should in a real repo, but
  // be defensive against manual deletion or partial repo state).
  mkdirSync(dirname(excludePath), { recursive: true });

  // Append the exclusion pattern.
  appendFileSync(excludePath, "\n.pi/task-pools/\n", "utf-8");
}

// ── Detection helpers ────────────────────────────────────────────────────────

/**
 * Fallback worktree directory when the primary tree is missing or unusable.
 *
 * Returns `<cwd>/.git/pi-task-pools/<poolId>/worktrees`.
 * Mirrors the convention from pi-worktrees (§10.5).
 */
export function fallbackWorktreeDir(cwd: string, poolId: string): string {
  return join(cwd, FALLBACK_WT_DIR_REL, poolId, "worktrees");
}

/**
 * Quick check: is `cwd` inside a git repository?
 *
 * Runs `git rev-parse --is-inside-work-tree` and returns `true` when the
 * exit code is 0. Any error (non-git directory, broken repo, etc.) returns
 * `false`.
 */
export async function isGitRepo(git: GitOps, cwd: string): Promise<boolean> {
  try {
    const r = await git.gitExec(["rev-parse", "--is-inside-work-tree"], cwd);
    return r.code === 0;
  } catch {
    return false;
  }
}

/**
 * Check whether the git version / repo supports worktree operations.
 *
 * Runs `git worktree list --porcelain` and returns `true` on exit code 0.
 * Older git versions or bare repos may not support worktrees.
 */
export async function canUseWorktrees(git: GitOps, cwd: string): Promise<boolean> {
  try {
    const r = await git.gitExec(["worktree", "list", "--porcelain"], cwd);
    return r.code === 0;
  } catch {
    return false;
  }
}

// ── Verification (§10.4) ─────────────────────────────────────────────────────

/**
 * Verify the state of pool worktrees against the on-disk git worktree list.
 *
 * Returns an array of task ids whose `worktreePath` (as stored in the pool
 * state) is **missing** from the actual `git worktree list` output. These
 * are tasks whose worktrees have been externally deleted or corrupted.
 *
 * This can be used on pool load / resume to detect stale state and trigger
 * cleanup or recreation.
 */
export async function verifyWorktrees(
  git: GitOps,
  pool: PoolState,
  cwd: string,
): Promise<string[]> {
  const list = await git.worktreeList(cwd);
  const existingPaths = new Set(list.map((w) => w.path));

  return pool.tasks
    .filter((t) => t.worktreePath !== null && !existingPaths.has(t.worktreePath))
    .map((t) => t.id);
}
