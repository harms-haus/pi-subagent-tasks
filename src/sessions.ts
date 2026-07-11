/**
 * Native session-file management for pi-subagent-tasks.
 *
 * Handles the dual-search pattern for finding session files (flat vs. nested
 * `--<cwd>--` form), renaming raw pi output to canonical names, building
 * spawn arguments for the pi subagent CLI, and recording session paths into
 * the in-memory pool state.
 *
 * See §11 (agent spawning) and §12 (state persistence) of the extension spec.
 */

import { linkSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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
 * Find a session file deterministically by its session id.
 *
 * pi names session files `<timestamp>_<sessionId>.jsonl`, where
 * `<sessionId>` is the UUID emitted in the `session` header (the first JSON
 * line, §11/docs/json.md: `{"type":"session","version":3,"id":"<uuid>",...}`).
 * The spawner captures this id; the caller passes it here to locate the
 * exact file — avoiding the racy "globally newest" heuristic that
 * misattributes files whenever ≥2 agents run concurrently (N1).
 *
 * **Search strategy** (first match wins):
 *   1. Scan `sessionDir` for a flat file matching `*_<sessionId>.jsonl`.
 *   2. Scan `--<cwd>--` subdirectories (the nested form pi may produce) for
 *      a `.jsonl` file matching `*_<sessionId>.jsonl`.
 *
 * Returns `undefined` when no matching file is found or the directory is
 * inaccessible.
 */
export function findSessionFileById(sessionDir: string, sessionId: string): string | undefined {
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const suffix = `_${sessionId}.jsonl`;

  // Phase 1 — flat session files
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(suffix)) continue;
    // Guard: must be a canonical flat name (<ts>_<uuid>.jsonl)
    if (!FLAT_SESSION_RE.test(entry.name)) continue;
    return join(sessionDir, entry.name);
  }

  // Phase 2 — nested --<cwd>-- subdirectories
  const nestedDirs = entries.filter((e) => e.isDirectory() && NESTED_DIR_RE.test(e.name));

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
      if (!file.name.endsWith(suffix)) continue;
      return join(dirPath, file.name);
    }
  }

  return undefined;
}

/**
 * Rename a raw pi session file to a canonical name and return its new
 * absolute path.
 *
 * The target name is `{timecode}-{slugified-label}.jsonl` (e.g.
 * `20260709T151730Z-my-task.jsonl`). Collisions receive deterministic numeric
 * suffixes (`-2`, `-3`, ...).
 *
 * Creating a hard link reserves each candidate atomically without replacing an
 * existing file. This avoids the check-then-rename race (and `rename`'s
 * overwrite semantics) while keeping the source intact until reservation has
 * succeeded.
 */
export function renameSession(srcPath: string, sessionDir: string, name: string): string {
  const stem = `${timecode()}-${slugify(name)}`;

  for (let suffix = 1; ; suffix += 1) {
    const target = join(sessionDir, `${stem}${suffix === 1 ? "" : `-${suffix}`}.jsonl`);
    try {
      linkSync(srcPath, target);
      unlinkSync(srcPath);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
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
