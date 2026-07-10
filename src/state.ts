/**
 * State persistence for pi-task-pools — state.json + audit.jsonl + resume (§12, §15, D12).
 *
 * This module provides:
 *   - Atomic read/write of the pool state file (state.json).
 *   - Append-only structured audit log (audit.jsonl) with convenience methods
 *     for every event type in the §15 taxonomy.
 *   - Pool directory scaffolding and discovery.
 *   - Resume reconciliation that recovers running/parked/failed tasks to ready
 *     and resets in-flight cursor nodes.
 *
 * References:
 *   §12   state persistence and on-disk layout.
 *   §15   audit event taxonomy.
 *   D12   resume semantics (failed → ready).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { STATE_FILE, AUDIT_FILE, CUSTOM_ENTRY_TYPE, STATE_DIR_REL } from "./constants";
import { serializeCursor, deserializeCursor } from "./cursor";
import { reconcileForResume } from "./retry";
import type { CursorNode, LimitsConfig, PoolState, TaskRuntime } from "./types";

// ── Serialization helpers ────────────────────────────────────────────────────

/**
 * Serialize a {@link TaskRuntime} into a plain JSON-safe object.
 *
 * Uses structural iteration over `Object.entries` (matching cursor.ts's
 * {@link deepCopyCursor} pattern) so any future fields added to
 * {@link TaskRuntime} are copied automatically. The `cursor` field is
 * serialized via {@link serializeCursor} so the full compose execution tree
 * is preserved losslessly.
 */
function serializeTask(t: TaskRuntime): object {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(t)) {
    if (value === undefined) continue;
    if (key === "cursor") {
      result[key] = serializeCursor(value as CursorNode);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Deserialize a plain object (parsed from state.json) into a {@link TaskRuntime}.
 *
 * Uses structural iteration over `Object.entries` (matching cursor.ts's
 * {@link deepCopyCursor} pattern) so any future fields added to
 * {@link TaskRuntime} are handled automatically. The `cursor` field is
 * reconstructed via {@link deserializeCursor} so the compose execution tree
 * is restored losslessly.
 */
function deserializeTask(obj: Record<string, unknown>): TaskRuntime {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (key === "cursor") {
      result[key] = deserializeCursor(value as object);
    } else {
      result[key] = value;
    }
  }
  return result as unknown as TaskRuntime;
}

// ── writeState / readState (§12) ─────────────────────────────────────────────

// ── Write counter for unique temp file names ─────────────────────────────────

let writeStateCounter = 0;

// ── writeState / readState (§12) ─────────────────────────────────────────────

/**
 * Atomically write the pool state to `state.json`.
 *
 * Writing is done via a temporary file (`<poolDir>/.state.json.tmp.<pid>.<n>`)
 * followed by an atomic `renameSync`. The pid + monotonic counter suffix
 * prevents collision between concurrent writers. If `renameSync` fails the
 * temp file is cleaned up to avoid orphans.
 *
 * @param poolDir  The pool's on-disk directory (e.g.
 *                 `<cwd>/.pi/task-pools/<poolId>`).
 * @param pool     The live pool state. Every task's cursor is serialized
 *                 losslessly via {@link serializeCursor}.
 */
export function writeState(poolDir: string, pool: PoolState): void {
  const serialized: object = {
    id: pool.id,
    name: pool.name,
    branch: pool.branch,
    poolWorktree: pool.poolWorktree,
    baseBranch: pool.baseBranch,
    limits: pool.limits,
    maxRetries: pool.maxRetries,
    createdAt: pool.createdAt,
    updatedAt: pool.updatedAt,
    status: pool.status,
    mergeQueue: pool.mergeQueue,
    tasks: pool.tasks.map(serializeTask),
  };

  const tmpPath = join(poolDir, `.state.json.tmp.${process.pid}.${writeStateCounter++}`);
  const finalPath = join(poolDir, STATE_FILE);

  try {
    writeFileSync(tmpPath, JSON.stringify(serialized, null, 2), "utf-8");
    renameSync(tmpPath, finalPath);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup — ignore unlink failures
    }
    throw e;
  }
}

/**
 * Read and deserialize the pool state from `state.json`.
 *
 * Returns `undefined` when the file is missing, the directory does not exist,
 * or the file content fails to parse (e.g. corrupt JSON, unexpected structure).
 * This is intentionally lenient — the caller is expected to handle a missing
 * state by creating a new pool rather than crashing.
 *
 * @param poolDir  The pool's on-disk directory.
 * @returns The deserialized {@link PoolState}, or `undefined`.
 */
export function readState(poolDir: string): PoolState | undefined {
  const statePath = join(poolDir, STATE_FILE);

  try {
    if (!existsSync(statePath)) return undefined;

    const raw = readFileSync(statePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.tasks)) return undefined;
    if (typeof obj.id !== "string") return undefined;
    if (!Array.isArray(obj.mergeQueue)) return undefined;
    if (typeof obj.status !== "string") return undefined;
    if (typeof obj.limits !== "object" || obj.limits === null) return undefined;

    const tasks = obj.tasks.map((t) => deserializeTask(t as Record<string, unknown>));

    return {
      id: obj.id,
      name: obj.name as string,
      branch: obj.branch as string,
      poolWorktree: obj.poolWorktree as string,
      baseBranch: obj.baseBranch as string,
      limits: obj.limits as LimitsConfig,
      maxRetries: obj.maxRetries as number,
      createdAt: obj.createdAt as number,
      updatedAt: obj.updatedAt as number,
      status: obj.status as PoolState["status"],
      mergeQueue: obj.mergeQueue as string[],
      tasks,
    };
  } catch {
    return undefined;
  }
}

// ── AuditLogger (§15) ────────────────────────────────────────────────────────

/**
 * Append-only structured audit logger for a single pool.
 *
 * The log is written to `<poolDir>/audit.jsonl` — one JSON object per line.
 * Each line contains `t` (ISO timestamp), `pool` (pool id), `type` (event
 * type from the §15 taxonomy), plus an arbitrary event-specific payload.
 *
 * The file descriptor is opened once in the constructor and closed via
 * {@link AuditLogger.close}. A single `AuditLogger` instance MUST NOT be
 * shared across pools (each pool gets its own).
 */
export class AuditLogger {
  private fd: number;
  private poolId: string;
  private closed = false;

  /**
   * Open the audit log file in append mode. Creates the file if it does not
   * exist.
   *
   * @param poolDir  The pool's on-disk directory.
   * @param poolId   The pool id (included in every log line).
   */
  constructor(poolDir: string, poolId: string) {
    const auditPath = join(poolDir, AUDIT_FILE);
    this.fd = openSync(auditPath, "a");
    this.poolId = poolId;
  }

  /**
   * Write one audit event line.
   *
   * The line is written via `writeSync` (efficient with a persistent fd). If
   * the logger has been closed, the write is silently dropped (no-op) to avoid
   * EBADF errors.
   *
   * @param type     Event type from the §15 taxonomy.
   * @param payload  Arbitrary event-specific fields merged into the JSON line.
   */
  log(type: string, payload: Record<string, unknown>): void {
    if (this.closed) return;
    const entry = {
      t: new Date().toISOString(),
      pool: this.poolId,
      type,
      ...payload,
    };
    const buf = Buffer.from(JSON.stringify(entry) + "\n", "utf-8");
    writeFileSync(this.fd, buf);
  }

  // ── Typed convenience methods (§15 taxonomy) ──────────────────────────────

  poolCreated(payload: Record<string, unknown>): void {
    this.log("pool_created", payload);
  }

  poolResumed(payload: Record<string, unknown>): void {
    this.log("pool_resumed", payload);
  }

  poolCompleted(payload: Record<string, unknown>): void {
    this.log("pool_completed", payload);
  }

  taskReady(payload: Record<string, unknown>): void {
    this.log("task_ready", payload);
  }

  taskRunning(payload: Record<string, unknown>): void {
    this.log("task_running", payload);
  }

  taskParked(payload: Record<string, unknown>): void {
    this.log("task_parked", payload);
  }

  taskFailed(payload: Record<string, unknown>): void {
    this.log("task_failed", payload);
  }

  taskDone(payload: Record<string, unknown>): void {
    this.log("task_done", payload);
  }

  taskSkipped(payload: Record<string, unknown>): void {
    this.log("task_skipped", payload);
  }

  taskRetry(payload: Record<string, unknown>): void {
    this.log("task_retry", payload);
  }

  agentStart(payload: Record<string, unknown>): void {
    this.log("agent_start", payload);
  }

  agentComplete(payload: Record<string, unknown>): void {
    this.log("agent_complete", payload);
  }

  agentError(payload: Record<string, unknown>): void {
    this.log("agent_error", payload);
  }

  agentResume(payload: Record<string, unknown>): void {
    this.log("agent_resume", payload);
  }

  agentRetry(payload: Record<string, unknown>): void {
    this.log("agent_retry", payload);
  }

  gateloopApproved(payload: Record<string, unknown>): void {
    this.log("gateloop_approved", payload);
  }

  gateloopRejected(payload: Record<string, unknown>): void {
    this.log("gateloop_rejected", payload);
  }

  worktreeCreated(payload: Record<string, unknown>): void {
    this.log("worktree_created", payload);
  }

  worktreeMerged(payload: Record<string, unknown>): void {
    this.log("worktree_merged", payload);
  }

  worktreeDeleted(payload: Record<string, unknown>): void {
    this.log("worktree_deleted", payload);
  }

  mergeStarted(payload: Record<string, unknown>): void {
    this.log("merge_started", payload);
  }

  mergeConflict(payload: Record<string, unknown>): void {
    this.log("merge_conflict", payload);
  }

  mergeResolved(payload: Record<string, unknown>): void {
    this.log("merge_resolved", payload);
  }

  mergeFailed(payload: Record<string, unknown>): void {
    this.log("merge_failed", payload);
  }

  limitBlocked(payload: Record<string, unknown>): void {
    this.log("limit_blocked", payload);
  }

  /**
   * Close the audit log file descriptor.
   *
   * Idempotent — subsequent calls are no-ops. Must be called when the pool
   * is shut down to avoid leaking file descriptors.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

// ── Pool hint (§12) ──────────────────────────────────────────────────────────

/**
 * Register a custom session entry of type `pi-task-pools` containing the pool
 * id. This allows pi's session browser to discover that a pool exists and link
 * to it.
 *
 * @param pi       An object with an `appendEntry` method (the pi extension API).
 * @param poolId   The pool id to embed in the entry.
 */
export function appendPoolHint(
  pi: { appendEntry: (type: string, data: unknown) => void },
  poolId: string,
): void {
  pi.appendEntry(CUSTOM_ENTRY_TYPE, { poolId });
}

// ── Directory scaffolding (§12) ──────────────────────────────────────────────

/**
 * Create the pool directory and its standard subdirectories.
 *
 * Creates:
 *   - `<poolDir>` (recursive)
 *   - `<poolDir>/sessions`
 *   - `<poolDir>/artifacts`
 *   - `<poolDir>/worktrees`
 *
 * Safe to call multiple times (idempotent via `recursive: true`).
 */
export function createPoolDirs(poolDir: string): void {
  mkdirSync(poolDir, { recursive: true });
  mkdirSync(join(poolDir, "sessions"), { recursive: true });
  mkdirSync(join(poolDir, "artifacts"), { recursive: true });
  mkdirSync(join(poolDir, "worktrees"), { recursive: true });
}

// ── Pool discovery (§12) ─────────────────────────────────────────────────────

/**
 * List all pool ids under `<cwd>/<STATE_DIR_REL>`.
 *
 * Scans the top-level directory for subdirectories; returns their basenames as
 * pool ids. Returns an empty array if the state directory does not exist.
 *
 * @param cwd  The working directory (typically the repo root).
 * @returns An array of pool id strings.
 */
export function listPools(cwd: string): string[] {
  const stateDir = join(cwd, STATE_DIR_REL);
  try {
    if (!existsSync(stateDir)) return [];
    const entries = readdirSync(stateDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ── Resume reconciliation (D12) ──────────────────────────────────────────────

/**
 * Reconcile a pool's state for resume after a crash or hard kill.
 *
 * This function:
 *   1. Calls {@link reconcileForResume} from `retry.ts` to reset
 *      running/parked/failed tasks to ready and reset in-flight cursor
 *      nodes to pending with zeroed execution counters.
 *   2. Forwards `opts.verifyWorktrees` to {@link reconcileForResume} which
 *      returns the list of task ids whose worktrees are missing.
 *
 * The pool object is mutated in place and returned alongside the
 * missing-worktree ids.
 *
 * @param pool   The live pool state (mutated in place).
 * @param opts   Optional hooks: `verifyWorktrees` to detect missing
 *               worktrees, `onAudit` to emit state-transition events.
 * @returns The (mutated) pool state and any missing worktree ids.
 */
export async function reconcilePoolOnResume(
  pool: PoolState,
  opts?: {
    verifyWorktrees?: (pool: PoolState) => Promise<string[]>;
    onAudit?: (type: string, payload: Record<string, unknown>) => void;
  },
): Promise<{ pool: PoolState; missingWorktrees: string[] }> {
  const missingWorktrees = await reconcileForResume(pool, opts);
  return { pool, missingWorktrees };
}
