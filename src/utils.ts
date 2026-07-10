/**
 * Pure utility helpers for pi-subagent-tasks.
 *
 * No agent/spawn/git logic lives here — these are small, dependency-light,
 * easily testable functions used across the scheduler, state, and render layers.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import { STATE_DIR_REL } from "./constants";

// ── String helpers ───────────────────────────────────────────────────────────

/**
 * Slugify a string into a kebab pool id: lowercase, runs of non-`[a-z0-9]`
 * collapse to a single `-`, leading/trailing `-` trimmed. e.g. `"My Pool!"` →
 * `"my-pool"` (§6.1).
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Generate a UTC timecode of the form `YYYYMMDDTHHMMSSZ` (e.g.
 * `20260709T151730Z`). Used for canonical session-file names (§11, §12).
 */
export function timecode(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

// ── Durations ────────────────────────────────────────────────────────────────

/**
 * Format an elapsed duration compactly: `"<1s"` for sub-second, then `Ns`,
 * `Nm`, `Nh` (e.g. `"5s"`, `"2m"`, `"1h"`). Used for board timers (§13).
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(ms / 3600000);
  return `${h}h`;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the pi agent directory: honors `PI_AGENT_DIR`, else `~/.pi/agent`
 * (mirrors pi-subagents).
 */
export function getAgentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Global profiles directory: `<agentDir>/profiles` (decision D4 — NOT
 * `agent-profiles`).
 */
export function getGlobalProfilesDir(): string {
  return join(getAgentDir(), "profiles");
}

/**
 * Project profiles directory (overrides global): `<cwd>/.pi/profiles` (D4).
 */
export function getProjectProfilesDir(cwd: string): string {
  return join(cwd, ".pi", "profiles");
}

/**
 * Resolve the on-disk directory for a pool: `<cwd>/.pi/subagent-tasks/<id>` (§12).
 */
export function poolDir(cwd: string, id: string): string {
  return join(cwd, STATE_DIR_REL, id);
}

// ── Exhaustiveness ───────────────────────────────────────────────────────────

/**
 * Exhaustiveness check: argument typed as `never` at compile time, throws at
 * runtime if reached. Use as the `default` branch in discriminated-union
 * switches to catch unhandled variants at compile time and as a defense at
 * the `state.json` boundary against corrupt or future-variant data.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}
