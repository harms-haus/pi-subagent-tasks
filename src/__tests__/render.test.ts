/**
 * Tests for {@link renderBoard} and {@link renderSummary}.
 *
 * §13  TUI — board layout, tier ordering, collapsed/expanded, footer
 * §6.2 final summary — exact template match (FIX B4)
 */

import { describe, it, expect, vi } from "vitest";

import { Text } from "@earendil-works/pi-tui";

// Mock keyHint for deterministic output — hoisted by vitest before all imports.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), keyHint: vi.fn(() => "Ctrl+O") };
});

import { renderBoard, renderSummary } from "../render";
import { buildCursor } from "../cursor";
import { createMockTheme } from "./helpers/mock-api";
import { COLLAPSED_ROW_CAP, STATUS_ICONS } from "../constants";
import type { ComposeAtom, PoolState, PoolUsage, Status, TaskRuntime } from "../types";

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the text content from a Text component (works with the pi-tui mock
 * where `render()` returns `[content]`).
 */
function textContent(comp: unknown): string {
  const text = comp as Text;
  const lines = text.render(80);
  return lines[0] ?? "";
}

/** Build a minimal PoolState with supplied overrides. */
function makePool(tasks: TaskRuntime[], overrides?: Partial<PoolState>): PoolState {
  return {
    id: "test-pool",
    name: "Test Pool",
    branch: "pi-subagent-task/test-pool",
    poolWorktree: "/tmp/pi-subagent-task/test-pool",
    baseBranch: "main",
    limits: { total: 4, provider: {}, model: {} },
    maxRetries: 2,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    status: "running",
    tasks,
    mergeQueue: [],
    ...overrides,
  };
}

/** Build a minimal TaskRuntime. */
function makeTask(id: string, status: Status, overrides?: Partial<TaskRuntime>): TaskRuntime {
  const cursor = buildCursor(undefined, id);
  if (status === "done") {
    cursor.state = "done";
  }
  return {
    id,
    prompt: "Do the thing",
    dependsOn: [],
    compose: { type: "agent" },
    cursor,
    status,
    retryCount: 0,
    runningAgentCount: 0,
    worktreePath: `/tmp/wt/${id}`,
    branch: `pi-subagent-task/${id}`,
    sessionFiles: [],
    downstreamCount: 0,
    lastError: undefined,
    startedAt: undefined,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("renderBoard", () => {
  it("places each task in the correct tier with the correct token colour (expanded)", () => {
    const tasks = [
      makeTask("t-running", "running"),
      makeTask("t-parked", "parked"),
      makeTask("t-ready", "ready"),
      makeTask("t-failed", "failed"),
      makeTask("t-blocked", "blocked"),
      makeTask("t-done", "done"),
    ];
    const pool = makePool(tasks);
    const theme = createMockTheme();

    const container = renderBoard(pool, { expanded: true, isPartial: false }, theme);

    // Collect Text children (skip Spacer).
    const textChildren = container.children.filter((c): c is Text => c instanceof Text);

    // Expected order: tier header, task row, tier header, task row, …
    // Tiers in TIER_ORDER: running, parked, ready, failed, blocked, done.
    const expectedHeaders = [
      { label: "Running", token: "warning" },
      { label: "Parked", token: "mdHeading" },
      { label: "Ready", token: "accent" },
      { label: "Failed", token: "error" },
      { label: "Blocked", token: "mdHeading" },
      { label: "Done", token: "success" },
    ];

    for (let i = 0; i < expectedHeaders.length; i++) {
      const { label, token } = expectedHeaders[i]!;
      const headerIdx = i * 2;
      // Header
      expect(textChildren[headerIdx]).toBeDefined();
      expect(textContent(textChildren[headerIdx]!)).toBe(label);
      // Verify theme.fg was called with the token for the header.
      // Call: theme.fg(token, theme.bold(label)) → theme.bold returns label.
      expect(theme.fg).toHaveBeenCalledWith(token, label);
      // Task row
      const rowIdx = i * 2 + 1;
      expect(textChildren[rowIdx]).toBeDefined();
      const rowContent = textContent(textChildren[rowIdx]!);
      expect(rowContent.startsWith(STATUS_ICONS[tasks[i]!.status])).toBe(true);
      expect(rowContent).toContain(tasks[i]!.id);
    }

    // No "+N more" hint in expanded mode.
    const moreHint = textChildren.find((t) => textContent(t).includes("more"));
    expect(moreHint).toBeUndefined();

    // Footer present.
    const last = textChildren[textChildren.length - 1];
    expect(last).toBeDefined();
    expect(textContent(last!)).toContain("merges");
  });

  it("collapsed: caps at COLLAPSED_ROW_CAP rows and shows a '+N more' hint", () => {
    const tasks = Array.from({ length: 25 }, (_, i) => makeTask(`t-${i}`, "ready"));
    const pool = makePool(tasks);
    const theme = createMockTheme();

    const container = renderBoard(pool, { expanded: false, isPartial: false }, theme);

    const textChildren = container.children.filter((c): c is Text => c instanceof Text);

    // 1 header row ("Ready"), then up to COLLAPSED_ROW_CAP - 1 task rows.
    const expectedDisplayedTasks = COLLAPSED_ROW_CAP - 1; // 19
    const expectedRemaining = tasks.length - expectedDisplayedTasks; // 6

    // Every displayed task row should reference the task id.
    for (let i = 0; i < expectedDisplayedTasks; i++) {
      const row = textChildren.find((t) => textContent(t).includes(`t-${i}`));
      expect(row).toBeDefined();
    }

    // "+N more" line.
    const moreLine = textChildren.find((t) => textContent(t).includes("more"));
    expect(moreLine).toBeDefined();
    expect(textContent(moreLine!)).toContain(`${expectedRemaining}+ more`);
    expect(textContent(moreLine!)).toContain("Ctrl+O");

    // Hidden tasks should NOT appear.
    for (let i = expectedDisplayedTasks; i < tasks.length; i++) {
      const hidden = textChildren.find((t) => textContent(t).includes(`t-${i}`));
      expect(hidden).toBeUndefined();
    }
  });

  it("expanded: renders all tasks regardless of count", () => {
    const tasks = Array.from({ length: 25 }, (_, i) => makeTask(`t-${i}`, "ready"));
    const pool = makePool(tasks);
    const theme = createMockTheme();

    const container = renderBoard(pool, { expanded: true, isPartial: false }, theme);

    const textChildren = container.children.filter((c): c is Text => c instanceof Text);

    // All 25 tasks must appear.
    for (let i = 0; i < tasks.length; i++) {
      const row = textChildren.find((t) => textContent(t).includes(`t-${i}`));
      expect(row).toBeDefined();
    }

    // No "+N more" hint.
    const moreLine = textChildren.find((t) => textContent(t).includes("more"));
    expect(moreLine).toBeUndefined();
  });

  it("footer shows agent usage when poolsUsage is provided", () => {
    const pool = makePool([makeTask("t-1", "running")]);
    const theme = createMockTheme();

    const poolsUsage: PoolUsage = {
      total: { used: 2, cap: 4 },
      provider: { anthropic: { used: 1, cap: 3 } },
      model: {},
    };

    const container = renderBoard(
      pool,
      { expanded: true, isPartial: false },
      theme,
      poolsUsage,
      false,
    );

    const textChildren = container.children.filter((c): c is Text => c instanceof Text);
    const footer = textChildren[textChildren.length - 1];
    expect(textContent(footer!)).toContain("agents 2/4");
    expect(textContent(footer!)).toContain("anthropic 1/3");
    expect(textContent(footer!)).toContain("merges 0");
  });

  it("footer shows merges 1 when mergeInProgress is true", () => {
    const pool = makePool([makeTask("t-1", "running")]);
    const theme = createMockTheme();

    const container = renderBoard(
      pool,
      { expanded: true, isPartial: false },
      theme,
      undefined,
      true,
    );

    const textChildren = container.children.filter((c): c is Text => c instanceof Text);
    const footer = textChildren[textChildren.length - 1];
    expect(textContent(footer!)).toContain("merges 1");
  });

  it("renders retry count and elapsed time when present", () => {
    const now = Date.now();
    const task = makeTask("t-retry", "running", {
      retryCount: 2,
      startedAt: now - 65_000,
    });
    const pool = makePool([task]);
    const theme = createMockTheme();

    const container = renderBoard(pool, { expanded: true, isPartial: false }, theme);

    const textChildren = container.children.filter((c): c is Text => c instanceof Text);
    const row = textChildren.find((t) => textContent(t).includes("t-retry"));
    expect(row).toBeDefined();
    expect(textContent(row!)).toContain("(retry 2)");
    expect(textContent(row!)).toContain("1m");
  });

  it("renders lastError for failed tasks", () => {
    const task = makeTask("t-err", "failed", { lastError: "tests did not pass" });
    const pool = makePool([task]);
    const theme = createMockTheme();

    const container = renderBoard(pool, { expanded: true, isPartial: false }, theme);

    const textChildren = container.children.filter((c): c is Text => c instanceof Text);
    const row = textChildren.find((t) => textContent(t).includes("t-err"));
    expect(row).toBeDefined();
    expect(textContent(row!)).toContain("tests did not pass");
  });

  it("counts agent leaves in a sequential composite cursor", () => {
    const compose: ComposeAtom = {
      type: "sequential",
      atoms: [{ type: "agent" }, { type: "agent" }],
    };
    const cursor = buildCursor(compose, "t-seq");
    const task: TaskRuntime = makeTask("t-seq", "ready", { cursor, compose });
    const pool = makePool([task]);
    const theme = createMockTheme();

    const container = renderBoard(pool, { expanded: true, isPartial: false }, theme);

    const textChildren = container.children.filter((c): c is Text => c instanceof Text);
    const row = textChildren.find((t) => textContent(t).includes("t-seq"));
    expect(row).toBeDefined();
    // Two agent leaves, none done: [0/2]
    expect(textContent(row!)).toContain("[0/2]");
  });

  it("counts agent leaves in a gateLoop composite cursor", () => {
    const compose: ComposeAtom = {
      type: "gateLoop",
      work: { type: "agent" },
      review: { type: "agent" },
    };
    const cursor = buildCursor(compose, "t-gl");
    const task: TaskRuntime = makeTask("t-gl", "ready", { cursor, compose });
    const pool = makePool([task]);
    const theme = createMockTheme();

    const container = renderBoard(pool, { expanded: true, isPartial: false }, theme);

    const textChildren = container.children.filter((c): c is Text => c instanceof Text);
    const row = textChildren.find((t) => textContent(t).includes("t-gl"));
    expect(row).toBeDefined();
    // Only the work sub-cursor is counted (review is an internal step, L2).
    // One agent leaf (work), none done: [0/1]
    expect(textContent(row!)).toContain("[0/1]");
  });

  it("counts done agent leaves in a loop composite cursor", () => {
    const compose: ComposeAtom = {
      type: "loop",
      atom: { type: "agent" },
      count: 3,
    };
    const cursor = buildCursor(compose, "t-loop");
    // Mark the loop's single agent as done.
    if (cursor.childCursor) {
      cursor.childCursor.state = "done";
    }
    const task: TaskRuntime = makeTask("t-loop", "done", { cursor, compose });
    const pool = makePool([task]);
    const theme = createMockTheme();

    const container = renderBoard(pool, { expanded: true, isPartial: false }, theme);

    const textChildren = container.children.filter((c): c is Text => c instanceof Text);
    const row = textChildren.find((t) => textContent(t).includes("t-loop"));
    expect(row).toBeDefined();
    // One agent leaf (childCursor), marked done: [1/1]
    expect(textContent(row!)).toContain("[1/1]");
  });
});

describe("renderSummary", () => {
  it("matches §6.2 template exactly (done, failed, skipped)", () => {
    const t1 = makeTask("t-setup", "done", {
      title: "Setup",
      sessionFiles: ["session-setup.jsonl"],
    });
    const t2 = makeTask("t-lint", "done");
    const t3 = makeTask("t-build", "failed", {
      retryCount: 2,
      lastError: "compilation error",
    });
    const t4 = makeTask("t-deploy", "failed", {
      retryCount: 0,
      lastError: "depends on failed: t-build",
    });

    const pool = makePool([t1, t2, t3, t4], {
      id: "my-pool",
      name: "My Pool",
      branch: "pi-subagent-task/my-pool",
    });

    const result = renderSummary(pool);

    // ── content structure ──
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");

    const text = result.content[0]!.text;
    const lines = text.split("\n");

    // ── Line-by-line assertions ──
    expect(lines[0]).toBe("Pool: My Pool  (id: my-pool)");
    expect(lines[1]).toMatch(/^Pool branch: pi-subagent-task\/my-pool {3}\(worktree: /);
    expect(lines[2]).toBe("Tasks: 2 done, 1 failed, 1 skipped");

    // Done tasks.
    expect(lines[3]).toBe("  ✓ t-setup Setup  (session: session-setup.jsonl)");
    expect(lines[4]).toBe("  ✓ t-lint  (session: -)");

    // Failed task.
    expect(lines[5]).toBe(
      "  ✗ t-build  FAILED after 3 attempts — compilation error  (resume to retry)",
    );

    // Skipped task.
    expect(lines[6]).toBe("  ⊘ t-deploy  SKIPPED (depends on failed: t-build)");

    // Paths.
    expect(lines[7]).toBe("Sessions: .pi/subagent-tasks/my-pool/sessions/");
    expect(lines[8]).toBe("Audit:    .pi/subagent-tasks/my-pool/audit.jsonl");

    // Finalize.
    expect(lines[9]).toBe(
      "Finalize: from your repo, e.g.  git merge --ff-only pi-subagent-task/my-pool",
    );
    expect(lines[10]).toBe(
      "                              | gh pr create --head pi-subagent-task/my-pool",
    );
  });

  it("computes correct counts with no failures", () => {
    const t1 = makeTask("t-1", "done");
    const t2 = makeTask("t-2", "done");
    const pool = makePool([t1, t2]);
    const result = renderSummary(pool);

    const text = result.content[0]!.text;
    expect(text).toContain("Tasks: 2 done, 0 failed, 0 skipped");
    expect(result.details).toEqual({
      poolId: "test-pool",
      counts: { done: 2, failed: 0, skipped: 0 },
    });
  });

  it("skipped detection uses lastError starting with 'depends on failed'", () => {
    const t1 = makeTask("t-fail", "failed", { lastError: "depends on failed: t-other" });
    const t2 = makeTask("t-fail2", "failed", { lastError: "depends on failed: t-other2" });
    const t3 = makeTask("t-real", "failed", { lastError: "internal error" });
    const pool = makePool([t1, t2, t3]);
    const result = renderSummary(pool);

    const text = result.content[0]!.text;
    expect(text).toContain("Tasks: 0 done, 1 failed, 2 skipped");
    expect(result.details).toEqual({
      poolId: "test-pool",
      counts: { done: 0, failed: 1, skipped: 2 },
    });
  });

  it("handles empty pool gracefully", () => {
    const pool = makePool([]);
    const result = renderSummary(pool);

    const text = result.content[0]!.text;
    expect(text).toContain("Tasks: 0 done, 0 failed, 0 skipped");
    expect(text).toContain("Sessions:");
    expect(text).toContain("Audit:");
    expect(text).toContain("Finalize:");
  });
});
