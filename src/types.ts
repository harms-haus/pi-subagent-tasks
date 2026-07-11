/**
 * Core type definitions for pi-subagent-tasks.
 *
 * This module is TYPE-ONLY — it contains no runtime code. Every other module
 * in the extension imports its domain model from here.
 *
 * See the extension spec (TASK-POOLS-EXTENSION-PROMPT.md):
 *   §5  data model (statuses, limits, compose atoms, result flow)
 *   §7  scheduler state
 *   §12 state.json
 *   §15 audit event taxonomy
 *   §17 defaults
 */

// ── Task lifecycle ───────────────────────────────────────────────────────────

/** The six task statuses (§5.2). */
export type Status = "blocked" | "ready" | "running" | "parked" | "failed" | "done";

// ── Concurrency limits (§5.3, D7) ────────────────────────────────────────────

/**
 * Three independent, AND-gated concurrency pools. A session using
 * `anthropic/claude-sonnet-4-5` consumes 1 from `total`, 1 from
 * `provider.anthropic`, and 1 from `model["anthropic/claude-sonnet-4-5"]`.
 * An unset pool is unlimited.
 */
export interface LimitsConfig {
  /** Whole-pool cap (default 4). */
  total: number;
  /** Provider-only caps, counted across every model of that provider. */
  provider: Record<string, number>;
  /** Exact `<provider>/<model>` caps. */
  model: Record<string, number>;
}

// ── Compose atoms (§5.4, D2) ─────────────────────────────────────────────────

/** A single agent session: the task prompt (constant) + flow context + profile. */
export interface AgentAtom {
  type: "agent";
  /** Profile override; omitted → inherit the task's profile (§5.1). */
  profile?: string;
  /** Label used in parallel headers / TUI / audit. */
  title?: string;
}

/** Run atoms one after another in the same worktree (a pipeline). */
export interface SequentialAtom {
  type: "sequential";
  atoms: ComposeAtom[];
}

/** Start all child atoms concurrently (subject to limits); done when all complete. */
export interface ParallelAtom {
  type: "parallel";
  atoms: ComposeAtom[];
}

/**
 * Run `work`, then `review`; approved→exit, rejected→resume `work` with feedback;
 * cap `maxIterations`. Reviewer emits a {@link GateVerdict} via the terminating
 * `gate_verdict` tool (§9, D8).
 */
export interface GateLoopAtom {
  type: "gateLoop";
  work: ComposeAtom;
  review: ComposeAtom;
  maxIterations?: number;
}

/** Run `atom` exactly `count` times sequentially in the same worktree (§5.4). */
export interface LoopAtom {
  type: "loop";
  atom: ComposeAtom;
  count: number;
}

/** Discriminated union of all compose atom kinds (§5.4). */
export type ComposeAtom = AgentAtom | SequentialAtom | ParallelAtom | GateLoopAtom | LoopAtom;

// ── Task specification (§6.1) ────────────────────────────────────────────────

/**
 * A task as declared by the agent in `run_tasks`. A bare task with no `compose`
 * is equivalent to a single `{ type: "agent" }` using the task's profile.
 */
export interface TaskSpec {
  /** Optional id; else assigned `t-<N>`. Referenced by `dependsOn`. */
  id?: string;
  /** Optional human label. */
  title?: string;
  /** The singular task prompt — delivered verbatim to every agent (§5.1). */
  prompt: string;
  /** Default profile for this task's atoms (inheritance: §5.1). */
  profile?: string;
  /** Ids or titles of dependencies, resolved at creation (kanban-style). */
  dependsOn?: string[];
  /** Optional compose tree; omit → single `{ type: "agent" }`. */
  compose?: ComposeAtom;
}

/**
 * `run_tasks` parameters. `create` and `resume` are mutually exclusive — the
 * disambiguation is enforced at the tool layer.
 */
export type RunTasksParams =
  | {
      name: string;
      tasks: TaskSpec[];
      limits?: Partial<LimitsConfig>;
      maxRetries?: number;
      /** Run tasks in isolated git worktrees (default true). */
      worktree?: boolean;
    }
  | { resume: string };

// ── Compose execution cursor (§7.2) ──────────────────────────────────────────

/**
 * The mutable, per-atom execution cursor within a task's compose tree. One
 * {@link CursorNode} is created per atom node; fields are populated as the
 * scheduler advances (§7.2 `nextWantedAgents`). Recursive sub-cursors model
 * container atoms; optional atom-specific fields track gateLoop/loop state.
 */
export interface CursorNode {
  /** Discriminator mirroring the originating {@link ComposeAtom} kind. */
  kind: ComposeAtom["type"];
  /** Stable path within the compose tree (e.g. "sequential[0].parallel[2]"). */
  path: string;
  /** Lifecycle state of this node. */
  state: "pending" | "running" | "done" | "failed";
  /** Last assistant text emitted by this atom (flows downstream, §5.5). */
  lastText?: string;
  /** Flat session file produced/used by this atom (resume by path, §11). */
  sessionFile?: string;
  /** Per-agent soft-retry counter (cap = SOFT_RETRY_CAP, §8 level 1). */
  executionCount?: number;
  /** Atom label (from the atom's `title`). */
  title?: string;
  /** Resolved profile name for this atom (atom.profile ?? task.profile). */
  profile?: string;
  /** Child cursors for `sequential` / `parallel` nodes. */
  children?: CursorNode[];
  /** Index of the next child to run (sequential / parallel progress). */
  childIndex?: number;
  /** Work sub-cursor for `gateLoop` nodes. */
  workCursor?: CursorNode;
  /** Review sub-cursor for `gateLoop` nodes. */
  reviewCursor?: CursorNode;
  /** Child sub-cursor for `loop` nodes (the current iteration). */
  childCursor?: CursorNode;
  /** Current gateLoop iteration count (1-based). */
  iteration?: number;
  /** Which phase a `gateLoop` is in. */
  gatePhase?: "work" | "review";
  /** Prior work session file within this gateLoop (for resume, §9 step 1). */
  workSessionFile?: string;
  /** Most recent reviewer feedback (prepended to the next work run, §9 step 4). */
  lastFeedback?: string;
  /** Current loop iteration count (1-based). */
  loopIteration?: number;
  /** Previous iteration's last text (chained as context, §17.2). */
  prevIterationText?: string;
  /** Cap for `gateLoop` nodes (default DEFAULT_GATELOOP_MAX_ITERATIONS). */
  maxIterations?: number;
  /** Total iteration count for `loop` nodes. */
  count?: number;
}

// ── Task runtime state (§7, §12) ─────────────────────────────────────────────

/** The live, in-memory task record (mirrored into `state.json`, §12). */
export interface TaskRuntime {
  id: string;
  title?: string;
  prompt: string;
  profile?: string;
  /** Resolved dependency ids (titles resolved to ids at creation). */
  dependsOn: string[];
  compose: ComposeAtom;
  /** Root of the compose execution tree. */
  cursor: CursorNode;
  status: Status;
  /** Whole-task fresh-restart counter (cap = maxRetries, §8 level 2). */
  retryCount: number;
  /** Number of this task's agents currently executing. */
  runningAgentCount: number;
  /** Task worktree path; null after merge (worktree deleted, §10.2). */
  worktreePath: string | null;
  /** Task branch; null after merge. */
  branch: string | null;
  /** All flat session files produced for this task. */
  sessionFiles: string[];
  /** Transitive count of tasks depending on this one (priority, §7.3). */
  downstreamCount: number;
  /** Last error line (shown for failed tasks on the board). */
  lastError?: string;
  /** Epoch ms when the task first started running. */
  startedAt?: number;
  /** Rolling latest compact tool-call lines shown in the live board. */
  outputLines?: string[];
  /** Number of tool calls observed in the current whole-task attempt. */
  toolCallCount?: number;
}

// ── Concurrency-pool usage (§7) ──────────────────────────────────────────────

/** Used/capacity for one concurrency pool. */
export interface PoolSlot {
  used: number;
  cap: number;
}

/** Live usage across all three concurrency pools (§5.3). */
export interface PoolUsage {
  total: PoolSlot;
  provider: Record<string, PoolSlot>;
  model: Record<string, PoolSlot>;
}

// ── Agent execution seam (§7.2, §11) ─────────────────────────────────────────

/**
 * A demand to start one agent session, produced by `nextWantedAgents`. The
 * scheduler consumes it via the injectable {@link AgentRunner} seam.
 */
export interface AgentDemand {
  /** Stable path within the compose tree (for audit). */
  atomPath: string;
  /** Resolved profile name. */
  profileName: string;
  /** Flow context + the constant task prompt (§5.5), assembled at start time. */
  effectivePrompt: string;
  /** Session file to resume, if any (soft-retry / gateLoop work-loop, §11). */
  resumeSessionFile?: string;
  /** Working directory for the spawned agent (the task worktree, or pool wt). */
  cwd: string;
  taskId: string;
  /** Resolved provider (for limit accounting). */
  provider?: string;
  /** Resolved model (for limit accounting). */
  model?: string;
}

/** Structured verdict emitted by a gateLoop reviewer via the `gate_verdict` tool (§9). */
export interface GateVerdict {
  approved: boolean;
  feedback: string;
}

/** Outcome of a single agent run, returned by {@link AgentRunner.runAgent}. */
export interface AgentRunResult {
  success: boolean;
  /** Last assistant text (flows downstream, §5.5). */
  lastText: string;
  /** Flat session file produced by this run (post move+rename, §11). */
  sessionFile?: string;
  /** Process exit code (0 on success). */
  exitCode: number;
  /** Error message on failure. */
  error?: string;
  /** Parsed reviewer verdict (gateLoop review atoms only). */
  verdict?: GateVerdict;
  durationMs: number;
  /** True if loop detection fired (§11). */
  loopDetected?: boolean;
}

/** Options passed to {@link AgentRunner.runAgent}. */
export interface AgentRunOptions {
  /** AbortSignal to hard-kill the agent (D14). */
  signal?: AbortSignal;
  /** Pool sessions directory. */
  sessionDir: string;
  /** Pool id (for audit). */
  poolId: string;
  /** Called with the latest assistant text as it is emitted. */
  onOutput?: (text: string) => void;
}

/** Injectable seam the scheduler uses to spawn agents (enables testing). */
export interface AgentRunner {
  runAgent(demand: AgentDemand, opts: AgentRunOptions): Promise<AgentRunResult>;
}

// ── Audit & persistence (§12, §15) ───────────────────────────────────────────

/** One append-only audit event line in `audit.jsonl` (§15). */
export interface AuditEvent {
  /** ISO timestamp. */
  t: string;
  /** Pool id. */
  pool: string;
  /** Event type (see taxonomy §15). */
  type: string;
  /** Arbitrary event-specific payload. */
  [key: string]: unknown;
}

/**
 * Canonical, on-disk pool state written to `state.json` (§12). The agent may
 * `read` this file directly to inspect a pool without a dedicated tool (D13).
 */
export interface PoolState {
  id: string;
  name: string;
  /** Whether this pool uses isolated git worktrees. Defaults true for legacy state. */
  worktree?: boolean;
  branch: string;
  poolWorktree: string;
  baseBranch: string;
  limits: LimitsConfig;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
  status: "running" | "done" | "failed";
  tasks: TaskRuntime[];
  /** FIFO of task ids awaiting serial merge (§10.2). */
  mergeQueue: string[];
}

// ── Shared execution result ──────────────────────────────────────────────────

/**
 * Result of executing a shell command (e.g. git). Matches the platform's
 * `ExecResult` shape; used by the git layer.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}
