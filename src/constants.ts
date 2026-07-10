/**
 * Runtime constants for pi-task-pools.
 *
 * Defaults are confirmed in the spec decisions log (§4) and §17. Importing this
 * module is side-effect-free (plain declarations only).
 */

import type { Status } from "./types";

// ── Defaults / caps (§17) ────────────────────────────────────────────────────

/** Default whole-pool concurrency cap (D7, §17). */
export const DEFAULT_TOTAL_LIMIT = 4;

/** Default whole-task fresh-restart cap (D6, §17). */
export const DEFAULT_MAX_RETRIES = 2;

/** Per-agent soft-retry cap: allows up to 5 re-executions (resumes) before escalating to L2; total worst-case executions per atom = SOFT_RETRY_CAP + 1 = 6 (§8 level 1). */
export const SOFT_RETRY_CAP = 5;

/** Default gateLoop iteration cap (D8, §17). */
export const DEFAULT_GATELOOP_MAX_ITERATIONS = 3;

// ── Branching / layout (§17, §12) ────────────────────────────────────────────

/** Pool/task branch prefix (§17.4). */
export const BRANCH_PREFIX = "pi-task-pool";

/** Primary on-disk state directory (relative to repo root, §12). */
export const STATE_DIR_REL = ".pi/task-pools";

/** Worktree directory fallback (inside the git dir, §10.5). */
export const FALLBACK_WT_DIR_REL = ".git/pi-task-pools";

// ── TUI (§13, §17.7) ─────────────────────────────────────────────────────────

/** Max rows rendered in the collapsed board (§13, §17.7). */
export const COLLAPSED_ROW_CAP = 20;

// ── Agent spawner tuning (§11) ───────────────────────────────────────────────

/** Repetition count that triggers loop detection (mirrors pi-subagents). */
export const LOOP_DETECT_COUNT = 5;

/** Idle-timeout before a spawned agent is considered stuck (ms). */
export const IDLE_TIMEOUT_MS = 600_000;

/** Debounce window for idle-timeout auto-extend (ms). */
export const IDLE_DEBOUNCE_MS = 30_000;

/** Grace window before escalating an abort to SIGKILL (ms, D14). */
export const ABORT_GRACE_MS = 5_000;

/** Force-kill delay after a grace escalation (ms, D14). */
export const ABORT_FORCE_MS = 5_000;

/** Idle-check interval (ms) for the spawned agent timeout checker. */
export const IDLE_CHECK_INTERVAL_MS = 1_000;

// ── On-disk file names (§12) ─────────────────────────────────────────────────

/** Sub-directory holding native pi session files (§12). */
export const SESSION_DIR_NAME = "sessions";

/** Append-only audit log file name (§12, §15). */
export const AUDIT_FILE = "audit.jsonl";

/** Canonical pool state file name (§12). */
export const STATE_FILE = "state.json";

/** Custom session-entry type registered via `pi.appendEntry` (§12). */
export const CUSTOM_ENTRY_TYPE = "pi-task-pools";

// ── Status lookup maps (§13, §5.2) ───────────────────────────────────────────

/** All valid task statuses, in canonical order. */
export const VALID_STATUSES: readonly Status[] = [
  "blocked",
  "ready",
  "running",
  "parked",
  "failed",
  "done",
] as const;

/** Status → board icon (§13). */
export const STATUS_ICONS: Record<Status, string> = {
  running: "⏳",
  parked: "⏸",
  ready: "▶",
  failed: "✗",
  blocked: "⊘",
  done: "✓",
};

/** Display tier order, top → bottom (§13). */
export const TIER_ORDER: Status[] = ["running", "parked", "ready", "failed", "blocked", "done"];
