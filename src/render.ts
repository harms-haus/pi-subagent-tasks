/**
 * Board renderer + final summary for pi-subagent-tasks.
 *
 * Pure rendering functions that build pi-TUI component trees from pool state.
 * No I/O, no agent spawning — only UI construction.
 *
 * §13  TUI ALL rules
 * §6.2 final summary EXACT template
 */

import { Container, Text } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { COLLAPSED_ROW_CAP, STATUS_ICONS, TIER_ORDER } from "./constants";
import { formatElapsed } from "./utils";
import type { CursorNode, PoolState, PoolUsage, Status } from "./types";

/**
 * Declare the extension's keybinding so the "app.tools.expand" literal is a
 * valid {@link import("@earendil-works/pi-tui").Keybinding} for the
 * {@link keyHint} call in the collapsed-board footer.
 */
declare module "@earendil-works/pi-tui" {
  interface Keybindings {
    "app.tools.expand": true;
  }
}

// ── Recursive helpers ──────────────────────────────────────────────────────

/** Result of counting agent-leaf nodes in a cursor tree. */
interface AgentLeafCount {
  done: number;
  total: number;
}

/**
 * Walk the cursor tree rooted at `node` and count agent-leaf nodes.
 *
 * Only nodes with `kind: "agent"` are counted. Container nodes (sequential,
 * parallel, gateLoop, loop) delegate to their children / sub-cursors
 * recursively.
 */
function countAgentLeaves(node: CursorNode): AgentLeafCount {
  if (node.kind === "agent") {
    return { done: node.state === "done" ? 1 : 0, total: 1 };
  }

  let done = 0;
  let total = 0;

  if (node.children) {
    for (const child of node.children) {
      const r = countAgentLeaves(child);
      done += r.done;
      total += r.total;
    }
  }

  // For gateLoop nodes, count only the work sub-cursor — the review atom
  // is an internal review step, not a user-visible work leaf (L2).
  if (node.workCursor !== undefined) {
    const r = countAgentLeaves(node.workCursor);
    done += r.done;
    total += r.total;
  }

  // childCursor (loop) is a work leaf.
  if (node.childCursor !== undefined) {
    const r = countAgentLeaves(node.childCursor);
    done += r.done;
    total += r.total;
  }

  return { done, total };
}

/** Collect the distinct profiles of agent leaves that are currently running. */
function runningProfiles(node: CursorNode, profiles = new Set<string>()): Set<string> {
  if (node.kind === "agent") {
    if (node.state === "running" && node.profile) profiles.add(node.profile);
    return profiles;
  }
  for (const child of node.children ?? []) runningProfiles(child, profiles);
  if (node.workCursor) runningProfiles(node.workCursor, profiles);
  if (node.reviewCursor) runningProfiles(node.reviewCursor, profiles);
  if (node.childCursor) runningProfiles(node.childCursor, profiles);
  return profiles;
}

// ── Board renderer (§13) ───────────────────────────────────────────────────

/** Human-readable label for each status tier. */
const TIER_LABELS: Record<Status, string> = {
  running: "Running",
  parked: "Parked",
  ready: "Ready",
  failed: "Failed",
  blocked: "Blocked",
  done: "Done",
};

/** Theme colour token for each status tier header and icon. */
const TIER_TOKENS: Record<Status, ThemeColor> = {
  running: "warning",
  parked: "mdHeading",
  ready: "accent",
  failed: "error",
  blocked: "mdHeading",
  done: "success",
};

/**
 * Render the live subagent-task board as a {@link Container} component tree.
 *
 * Tiers are rendered in {@link TIER_ORDER}. In collapsed view the board caps
 * at {@link COLLAPSED_ROW_CAP} rows and shows a "+N more" hint.
 *
 * @param pool          the full pool state
 * @param options       expanded/collapsed flag and partial-update hint
 * @param theme         pi theme with 51 fixed tokens
 * @param poolsUsage    optional concurrency-pool usage for the footer
 * @param mergeInProgress  optional flag for the footer merge indicator
 * @returns a fresh Container ready to be mounted into the TUI
 */
export function renderBoard(
  pool: PoolState,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  poolsUsage?: PoolUsage,
  mergeInProgress?: boolean,
): Container {
  const container = new Container();
  let rowCount = 0;
  let displayedTasks = 0;
  let reachedCap = false;

  for (const status of TIER_ORDER) {
    const tasks = pool.tasks.filter((t) => t.status === status);
    if (tasks.length === 0) continue;

    // Tier header line: bold text in the tier's colour.
    const header = theme.fg(TIER_TOKENS[status], theme.bold(TIER_LABELS[status]));
    container.addChild(new Text(header, 0, 0));
    rowCount++;

    // Task rows within this tier.
    for (const task of tasks) {
      if (!options.expanded && rowCount >= COLLAPSED_ROW_CAP) {
        reachedCap = true;
        break;
      }

      const icon = STATUS_ICONS[task.status];
      const displayName = task.title ?? task.id;
      const { done, total } = countAgentLeaves(task.cursor);
      const headerParts = [`[${done}/${total}]`];
      const profiles = [...runningProfiles(task.cursor)];
      if (profiles.length > 0) headerParts.push(profiles.join(", "));
      if (task.runningAgentCount > 0) {
        headerParts.push(
          `${task.runningAgentCount} agent${task.runningAgentCount === 1 ? "" : "s"}`,
        );
      }
      if ((task.toolCallCount ?? 0) > 0) {
        headerParts.push(`${task.toolCallCount} tools`);
      }
      if (task.retryCount > 0) headerParts.push(`retry ${task.retryCount}`);
      if (task.startedAt !== undefined) {
        headerParts.push(formatElapsed(Date.now() - task.startedAt));
      }

      let errorStr = "";
      if (task.status === "failed" && task.lastError !== undefined) {
        errorStr = ` — ${task.lastError}`;
      }

      const token = TIER_TOKENS[task.status];
      const details = theme.fg("dim", ` • ${headerParts.join(" • ")}`);
      const row = `${theme.fg(token, icon)} ${theme.fg("accent", theme.bold(displayName))}${details}${errorStr}`;
      container.addChild(new Text(row, 0, 0));
      rowCount++;
      displayedTasks++;

      // Keep active task output inline with its header, using the same compact
      // rolling-window treatment as pi-subagents.
      if (task.status === "running" && task.runningAgentCount > 0) {
        const outputLines = task.outputLines ?? [];
        if (outputLines.length === 0) {
          container.addChild(new Text(theme.fg("muted", "  (starting...)"), 0, 0));
        } else {
          for (const line of outputLines.slice(-10)) {
            container.addChild(new Text(theme.fg("muted", `  ${line}`), 0, 0));
          }
        }
      }
    }

    if (reachedCap) break;
  }

  // "+N more" hint at the bottom of a collapsed board.
  if (reachedCap) {
    const remaining = pool.tasks.length - displayedTasks;
    const hint =
      remaining > 0
        ? `${remaining}+ more — press ${keyHint("app.tools.expand", "Ctrl+O")} for full board`
        : `press ${keyHint("app.tools.expand", "Ctrl+O")} for full board`;
    container.addChild(new Text(theme.fg("dim", hint), 0, 0));
  }

  // Footer: agent counts and merge indicator. Keep the board compact: the
  // output window itself provides the visual grouping for active tasks.
  const footer = buildBoardFooter(poolsUsage, mergeInProgress, theme);
  container.addChild(new Text(footer, 0, 0));

  return container;
}

/**
 * Build the single-line board footer from optional pool-usage stats.
 */
function buildBoardFooter(
  poolsUsage: PoolUsage | undefined,
  mergeInProgress: boolean | undefined,
  theme: Theme,
): string {
  if (poolsUsage === undefined) {
    return theme.fg("dim", `merges ${mergeInProgress ? 1 : 0}`);
  }

  const { total } = poolsUsage;
  const agentPart = `agents ${total.used}/${total.cap}`;

  let providerPart = "";
  const providerEntries = Object.entries(poolsUsage.provider);
  const firstEntry = providerEntries[0];
  if (firstEntry !== undefined) {
    const [name, slots] = firstEntry;
    providerPart = ` · ${name} ${slots.used}/${slots.cap}`;
  }

  const mergePart = ` · merges ${mergeInProgress ? 1 : 0}`;

  return theme.fg("dim", `${agentPart}${providerPart}${mergePart}`);
}

// ── Final summary (§6.2) ──────────────────────────────────────────────────

/**
 * Build the subagent-task final summary matching §6.2 **exactly**.
 *
 * Returns a `ToolRenderResult`-compatible object so the agent can emit it
 * directly as a tool result.
 *
 * Counts:
 *   - `done`: tasks with `status === "done"`
 *   - `failed`: tasks with `status === "failed"` whose `lastError` does NOT
 *     start with `"depends on failed"` (genuine failures)
 *   - `skipped`: tasks with `status === "failed"` whose `lastError` starts
 *     with `"depends on failed"` (transitive dependency failures)
 */
export function renderSummary(pool: PoolState): {
  content: Array<{ type: "text"; text: string }>;
  details: object;
} {
  const doneTasks = pool.tasks.filter((t) => t.status === "done");
  const skippedTasks = pool.tasks.filter(
    (t) =>
      t.status === "failed" &&
      t.lastError !== undefined &&
      t.lastError.startsWith("depends on failed"),
  );
  const failedTasks = pool.tasks.filter(
    (t) =>
      t.status === "failed" &&
      (t.lastError === undefined || !t.lastError.startsWith("depends on failed")),
  );

  const lines: string[] = [];

  // ── Pool identification ──
  lines.push(`Pool: ${pool.name}  (id: ${pool.id})`);
  if (pool.worktree === false) {
    lines.push(`Execution: shared cwd (${pool.poolWorktree})`);
  } else {
    lines.push(`Pool branch: ${pool.branch}   (worktree: ${pool.poolWorktree})`);
  }

  // ── Summary counts ──
  lines.push(
    `Tasks: ${doneTasks.length} done, ${failedTasks.length} failed, ${skippedTasks.length} skipped`,
  );
  lines.push(`Task IDs: ${pool.tasks.map((task) => task.id).join(", ")}`);

  // ── Per-task lines in creation order ──
  for (const t of pool.tasks) {
    if (t.status === "done") {
      // done → checkmark
      const titleSuffix = t.title !== undefined ? ` ${t.title}` : "";
      const session = t.sessionFiles[0] ?? "-";
      lines.push(`  ✓ ${t.id}${titleSuffix}  (session: ${session})`);
    } else if (
      t.status === "failed" &&
      t.lastError !== undefined &&
      t.lastError.startsWith("depends on failed")
    ) {
      // skipped → slashed circle
      const depMatch = t.lastError.match(/depends on failed:\s*(\S+)/);
      const depId = depMatch?.[1] ?? "unknown";
      lines.push(`  ⊘ ${t.id}  SKIPPED (depends on failed: ${depId})`);
    } else if (t.status === "failed") {
      // failed → cross mark
      const attempts = t.retryCount + 1;
      const errMsg = t.lastError ?? "unknown";
      lines.push(`  ✗ ${t.id}  FAILED after ${attempts} attempts — ${errMsg}  (resume to retry)`);
    }
    // (blocked / ready / running / parked tasks are omitted from the summary)
  }

  // ── On-disk paths ──
  lines.push(`Sessions: .pi/subagent-tasks/${pool.id}/sessions/`);
  lines.push(`Audit:    .pi/subagent-tasks/${pool.id}/audit.jsonl`);

  // ── Finalize instructions ──
  if (pool.worktree !== false) {
    lines.push(`Finalize: from your repo, e.g.  git merge --ff-only ${pool.branch}`);
    lines.push(`                              | gh pr create --head ${pool.branch}`);
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      poolId: pool.id,
      taskIds: pool.tasks.map((task) => task.id),
      counts: {
        done: doneTasks.length,
        failed: failedTasks.length,
        skipped: skippedTasks.length,
      },
    },
  };
}
