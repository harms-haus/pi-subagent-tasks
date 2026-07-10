/**
 * Native session-file management for pi-task-pools.
 *
 * Handles the dual-search pattern for finding session files (flat vs. nested
 * `--<cwd>--` form), renaming raw pi output to canonical names, building
 * spawn arguments for the pi subagent CLI, and recording session paths into
 * the in-memory pool state.
 *
 * See §11 (agent spawning) and §12 (state persistence) of the extension spec.
 */

import { readdirSync, renameSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { Dirent } from "node:fs";

import { timecode, slugify } from "./utils";
import type { PoolState } from "./types";

// ── Regex patterns ───────────────────────────────────────────────────────────

/**
 * Match a canonical flat session file name: `<ts>_<uuid>.jsonl`
 * where ts = YYYYMMDDTHHMMSSZ and uuid is at least one character.
 */
const FLAT_SESSION_RE = /^\d{8}T\d{6}Z_.+\.jsonl$/;

/** Match a nested subdirectory created by `--<cwd>--`. */
const NESTED_DIR_RE = /^--.+--$/;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Find the newest session file in `sessionDir`.
 *
 * **Dual-search strategy:**
 *   1. Scan `sessionDir` for flat `<ts>_<uuid>.jsonl` files; return the newest
 *      by modification time.
 *   2. If none found flat, look for subdirectories matching `--<cwd>--` (the
 *      nested form pi may produce) and recurse one level for the newest
 *      `.jsonl` file.
 *
 * Returns `undefined` when no session file is found or the directory is
 * inaccessible.
 */
export function findSessionFile(sessionDir: string): string | undefined {
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  // Phase 1 — flat session files
  const flatFiles: { path: string; mtime: number }[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!FLAT_SESSION_RE.test(entry.name)) continue;
    const absPath = join(sessionDir, entry.name);
    try {
      const st = statSync(absPath);
      flatFiles.push({ path: absPath, mtime: st.mtimeMs });
    } catch {
      // race with deletion — skip
    }
  }

  if (flatFiles.length > 0) {
    flatFiles.sort((a, b) => b.mtime - a.mtime);
    return flatFiles[0]?.path;
  }

  // Phase 2 — nested fallback: look inside --<cwd>-- subdirectories
  const nestedDirs = entries.filter((e) => e.isDirectory() && NESTED_DIR_RE.test(e.name));

  let best: { path: string; mtime: number } | undefined;

  for (const dir of nestedDirs) {
    const dirPath = join(sessionDir, dir.name);
    let dirEntries: Dirent[];
    try {
      dirEntries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of dirEntries) {
      if (!file.isFile()) continue;
      if (extname(file.name) !== ".jsonl") continue;
      const filePath = join(dirPath, file.name);
      try {
        const st = statSync(filePath);
        if (!best || st.mtimeMs > best.mtime) {
          best = { path: filePath, mtime: st.mtimeMs };
        }
      } catch {
        // race — skip
      }
    }
  }

  return best?.path;
}

/**
 * Rename a raw pi session file to a canonical name and return its new
 * absolute path.
 *
 * The target name is `{timecode}-{slugified-label}.jsonl` (e.g.
 * `20260709T151730Z-my-task.jsonl`).
 */
export function renameSession(srcPath: string, sessionDir: string, name: string): string {
  const target = join(sessionDir, `${timecode()}-${slugify(name)}.jsonl`);
  renameSync(srcPath, target);
  return target;
}

/**
 * Build the `--session-dir` (and optionally `--session`) arguments for the
 * pi subagent spawn command.
 *
 * - Always emits `["--session-dir", sessionDir]`.
 * - When `resumeFile` is provided, also emits `["--session", resumeFile]`.
 *
 * Both flags MUST be present when resuming an existing session, otherwise pi
 * raises `MissingSessionCwdError` because the task worktree cwd differs from
 * the session header cwd.
 */
export function buildSpawnSessionArgs(sessionDir: string, resumeFile?: string): string[] {
  const args = ["--session-dir", sessionDir];
  if (resumeFile !== undefined && resumeFile !== "") {
    args.push("--session", resumeFile);
  }
  return args;
}

/**
 * Record a session file path in the pool state for the given task.
 *
 * Looks up `taskId` in `state.tasks` and appends `sessionFile` to the task's
 * `sessionFiles` array. Silently ignores unknown task ids.
 */
export function recordSessionPath(state: PoolState, taskId: string, sessionFile: string): void {
  const task = state.tasks.find((t) => t.id === taskId);
  if (task !== undefined) {
    task.sessionFiles.push(sessionFile);
  }
}
