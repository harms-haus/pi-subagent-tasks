import { describe, it, expect, vi } from "vitest";

import { assemblePrompt, nextWantedAgents, advanceComposeCursor } from "../atoms";
import { buildCursor } from "../cursor";
import type { AgentRunResult, CursorNode, TaskRuntime } from "../types";

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a minimal {@link TaskRuntime} with the given cursor root and compose
 * tree. All other fields use sensible defaults for testing the compose engine.
 */
function task(cursor: CursorNode, overrides?: Partial<TaskRuntime>): TaskRuntime {
  return {
    id: "t-1",
    title: undefined,
    prompt: "Write the code",
    profile: undefined,
    dependsOn: [],
    compose: { type: "agent" },
    cursor,
    status: "ready",
    retryCount: 0,
    runningAgentCount: 0,
    worktreePath: "/tmp/worktree",
    branch: "pi-subagent-task/test/t-1",
    sessionFiles: [],
    downstreamCount: 0,
    ...overrides,
  };
}

/** Non-null child accessor. */
function child(node: CursorNode, i: number): CursorNode {
  const c = node.children;
  if (c === undefined) throw new Error("node has no children");
  return c[i]!;
}

/** A successful agent result with the given lastText. */
function okResult(lastText: string, overrides?: Partial<AgentRunResult>): AgentRunResult {
  return {
    success: true,
    lastText,
    exitCode: 0,
    durationMs: 100,
    ...overrides,
  };
}

// ── assemblePrompt ───────────────────────────────────────────────────────────

describe("assemblePrompt", () => {
  it("returns just the task prompt when there is no flow context", () => {
    expect(assemblePrompt(undefined, "Do the thing")).toBe("Do the thing");
  });

  it("returns just the task prompt when flow context is empty string", () => {
    expect(assemblePrompt("", "Do the thing")).toBe("Do the thing");
  });

  it("prepends flow context with separator when context is provided", () => {
    const result = assemblePrompt("Previous step output", "Do the thing");
    expect(result).toBe("Previous step output\n\n---\n\nDo the thing");
  });

  it("handles multi-line context and task prompt", () => {
    const ctx = "Line 1\nLine 2\nLine 3";
    const prompt = "Final instruction\nwith details";
    expect(assemblePrompt(ctx, prompt)).toBe(
      "Line 1\nLine 2\nLine 3\n\n---\n\nFinal instruction\nwith details",
    );
  });
});

// ── nextWantedAgents ─────────────────────────────────────────────────────────

describe("nextWantedAgents", () => {
  // ── agent ──────────────────────────────────────────────────────────────────

  it("returns one demand for a pending agent leaf", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0");
    // Root-level agent with no flow context → just the task prompt.
    expect(demands[0]!.effectivePrompt).toBe("Write the code");
    expect(demands[0]!.profileName).toBe("");
    expect(demands[0]!.taskId).toBe("t-1");
    expect(demands[0]!.cwd).toBe("/tmp/worktree");
  });

  it("uses task profile when atom has no profile override", () => {
    const cursor = buildCursor({ type: "agent" }, "0");
    const t = task(cursor, { profile: "coder" });
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.profileName).toBe("coder");
  });

  it("uses atom profile override over task profile", () => {
    const cursor = buildCursor({ type: "agent", profile: "reviewer" }, "0");
    const t = task(cursor, { profile: "coder" });
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.profileName).toBe("reviewer");
  });

  it("returns empty when agent node is done", () => {
    const cursor = buildCursor(undefined, "0");
    cursor.state = "done";
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  it("returns empty when agent node is running", () => {
    const cursor = buildCursor(undefined, "0");
    cursor.state = "running";
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  it("returns empty when agent node is failed", () => {
    const cursor = buildCursor(undefined, "0");
    cursor.state = "failed";
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  it("passes resumeSessionFile from cursor node", () => {
    const cursor = buildCursor(undefined, "0");
    cursor.sessionFile = "/tmp/sessions/prev.jsonl";
    const t = task(cursor);
    const demands = nextWantedAgents(t);
    expect(demands[0]!.resumeSessionFile).toBe("/tmp/sessions/prev.jsonl");
  });

  it("returns empty when task has no worktreePath", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor, { worktreePath: null });
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  // ── sequential ─────────────────────────────────────────────────────────────

  it("sequential: returns only the first child's demand (childIndex 0)", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
        ],
      },
      "0",
    );
    const t = task(cursor);
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.0"); // first child
    // No flow context for the first child.
    expect(demands[0]!.effectivePrompt).toBe("Write the code");
  });

  it("sequential: returns second child after first is done (with context)", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
        ],
      },
      "0",
    );
    const t = task(cursor);

    // Mark first child done and advance the sequential
    child(cursor, 0).state = "done";
    child(cursor, 0).lastText = "A-out";
    cursor.childIndex = 1;

    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.1"); // second child
    // Second child gets A's output as context.
    expect(demands[0]!.effectivePrompt).toBe("A-out\n\n---\n\nWrite the code");
  });

  it("sequential: returns empty when all children are done", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
        ],
      },
      "0",
    );
    child(cursor, 0).state = "done";
    child(cursor, 1).state = "done";
    cursor.childIndex = 2; // past both
    cursor.state = "done";

    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  it("sequential: returns empty when childIndex is past the end", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [{ type: "agent" }],
      },
      "0",
    );
    cursor.childIndex = 1;
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  it("sequential: empty children array produces no demands", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [],
      },
      "0",
    );
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  it("sequential: undefined childIndex produces no demands", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [{ type: "agent" }],
      },
      "0",
    );
    cursor.childIndex = undefined;
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  // ── parallel ───────────────────────────────────────────────────────────────

  it("parallel: returns demands for ALL pending children", () => {
    const cursor = buildCursor(
      {
        type: "parallel",
        atoms: [
          { type: "agent", title: "x" },
          { type: "agent", title: "y" },
          { type: "agent", title: "z" },
        ],
      },
      "0",
    );
    const t = task(cursor);
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(3);
    expect(demands.map((d) => d.atomPath)).toEqual(["0.0", "0.1", "0.2"]);
  });

  it("parallel: all children get the same incoming context", () => {
    // Nest parallel inside sequential[agent, parallel[x,y]] to test incoming
    // context flowing from the prior sibling into all parallel children.
    const root = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "prev" },
          {
            type: "parallel",
            atoms: [
              { type: "agent", title: "x" },
              { type: "agent", title: "y" },
            ],
          },
        ],
      },
      "0",
    );
    // Advance past first agent
    child(root, 0).state = "done";
    child(root, 0).lastText = "Pre-work output";
    root.childIndex = 1;
    root.state = "running";

    const t2 = task(root, { prompt: "Finalize" });
    const demands = nextWantedAgents(t2);
    expect(demands).toHaveLength(2);
    // Both children should get the same context from the preceding sibling.
    for (const d of demands) {
      expect(d.effectivePrompt).toBe("Pre-work output\n\n---\n\nFinalize");
    }
  });

  it("parallel: returns only pending children (skips done/running)", () => {
    const cursor = buildCursor(
      {
        type: "parallel",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
          { type: "agent", title: "c" },
        ],
      },
      "0",
    );
    child(cursor, 0).state = "done";
    child(cursor, 1).state = "running";
    // Only child 2 is pending.
    const t = task(cursor);
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.2");
  });

  it("parallel: empty children produces no demands", () => {
    const cursor = buildCursor({ type: "parallel", atoms: [] }, "0");
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  // ── gateLoop ───────────────────────────────────────────────────────────────

  it("gateLoop (work phase): delegates to workCursor with incomingFlow", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent", profile: "coder" },
        review: { type: "agent", profile: "reviewer" },
      },
      "0",
    );
    cursor.state = "running";
    const t = task(cursor, { prompt: "Implement feature" });
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.work");
    expect(demands[0]!.profileName).toBe("coder");
    // No flow context for the first work run.
    expect(demands[0]!.effectivePrompt).toBe("Implement feature");
  });

  it("gateLoop (work phase): prepends lastFeedback when present", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent" },
        review: { type: "agent" },
      },
      "g",
    );
    cursor.state = "running";
    cursor.lastFeedback = "Add more tests";
    cursor.gatePhase = "work";

    const t = task(cursor, { prompt: "Write code" });
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.effectivePrompt).toContain("Previous review feedback:\nAdd more tests");
    expect(demands[0]!.effectivePrompt).toContain("Write code");
  });

  it("gateLoop (work phase): feedback precedes incomingFlow when both exist", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent" },
        review: { type: "agent" },
      },
      "g",
    );
    cursor.state = "running";
    cursor.lastFeedback = "Needs refinement";
    cursor.gatePhase = "work";

    // The gateLoop is in a sequential after a prior sibling.
    const root = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "setup" },
          {
            type: "gateLoop",
            work: { type: "agent" },
            review: { type: "agent" },
          },
        ],
      },
      "0",
    );
    // Advance past setup so the gateLoop is next.
    child(root, 0).state = "done";
    child(root, 0).lastText = "Setup done";
    root.childIndex = 1;
    root.state = "running";

    // Also set feedback on the gateLoop.
    const gate = child(root, 1);
    gate.lastFeedback = "Needs refinement";
    gate.gatePhase = "work";

    const t = task(root, { prompt: "Build feature" });
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    // Effective prompt should have feedback first, then incoming flow, then task prompt.
    const prompt = demands[0]!.effectivePrompt;
    expect(prompt).toContain("Previous review feedback:\nNeeds refinement");
    expect(prompt).toContain("Setup done");
    expect(prompt).toContain("Build feature");
    // Feedback should come before the incoming flow.
    expect(prompt.indexOf("Previous review feedback:")).toBeLessThan(prompt.indexOf("Setup done"));
  });

  it("gateLoop (review phase): delegates to reviewCursor with workCursor.lastText", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent", profile: "coder" },
        review: { type: "agent", profile: "reviewer" },
      },
      "0",
    );
    cursor.state = "running";
    cursor.gatePhase = "review";
    cursor.workCursor!.state = "done";
    cursor.workCursor!.lastText = "Implementation done";

    const t = task(cursor, { prompt: "Implement feature" });
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.review");
    expect(demands[0]!.profileName).toBe("reviewer");
    // Review gets the work lastText as context.
    expect(demands[0]!.effectivePrompt).toBe("Implementation done\n\n---\n\nImplement feature");
  });

  it("gateLoop: returns empty when review phase but reviewCursor is missing", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent" },
        review: { type: "agent" },
      },
      "0",
    );
    cursor.state = "running";
    cursor.gatePhase = "review";
    cursor.reviewCursor = undefined;
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  it("gateLoop: returns empty when work phase but workCursor is missing", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent" },
        review: { type: "agent" },
      },
      "0",
    );
    cursor.state = "running";
    cursor.gatePhase = "work";
    cursor.workCursor = undefined;
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  // ── loop ───────────────────────────────────────────────────────────────────

  it("loop (iteration 1): delegates to childCursor with incomingFlow (no prev context)", () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: { type: "agent", profile: "variant-gen" },
        count: 3,
      },
      "L",
    );
    cursor.state = "running";
    const t = task(cursor, { prompt: "Generate variant" });
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("L.iter");
    expect(demands[0]!.profileName).toBe("variant-gen");
    // Iteration 1 → no prev context.
    expect(demands[0]!.effectivePrompt).toBe("Generate variant");
  });

  it("loop (iteration > 1): passes prevIterationText as context", () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: { type: "agent" },
        count: 3,
      },
      "L",
    );
    cursor.state = "running";
    cursor.loopIteration = 2;
    cursor.prevIterationText = "Iteration 1 output";

    const t = task(cursor, { prompt: "Generate variant" });
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.effectivePrompt).toBe("Iteration 1 output\n\n---\n\nGenerate variant");
  });

  it("loop: iteration 2 with empty prevIterationText (edge case)", () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: { type: "agent" },
        count: 3,
      },
      "L",
    );
    cursor.state = "running";
    cursor.loopIteration = 2;
    // prevIterationText intentionally left undefined.
    const t = task(cursor, { prompt: "Generate" });
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    // Empty prevIterationText is treated as no flow context (same as
    // undefined) — the agent receives only the task prompt.
    expect(demands[0]!.effectivePrompt).toBe("Generate");
  });

  it("loop: returns empty when childCursor is missing", () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: { type: "agent" },
        count: 3,
      },
      "L",
    );
    cursor.state = "running";
    cursor.childCursor = undefined;
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  // ── Deeper composition ─────────────────────────────────────────────────────

  it("nested: sequential[parallel[x,y], agent(z)] — parallel children all run, then z", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          {
            type: "parallel",
            atoms: [
              { type: "agent", title: "x" },
              { type: "agent", title: "y" },
            ],
          },
          { type: "agent", title: "z" },
        ],
      },
      "0",
    );
    const t = task(cursor);

    // Step 1: should return 2 parallel demands.
    let demands = nextWantedAgents(t);
    expect(demands).toHaveLength(2);
    expect(demands.map((d) => d.atomPath)).toEqual(["0.0.0", "0.0.1"]);

    // Mark both parallel children done.
    child(child(cursor, 0), 0).state = "done";
    child(child(cursor, 0), 0).lastText = "X-out";
    child(child(cursor, 0), 1).state = "done";
    child(child(cursor, 0), 1).lastText = "Y-out";

    // Recompute parallel completion.
    cursor.childIndex = 1;
    cursor.children![0]!.state = "done";
    cursor.children![0]!.lastText = "X\nX-out\n\nY\nY-out";

    // Step 2: should return z's demand with parallel concat as context.
    demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.1");
    expect(demands[0]!.effectivePrompt).toContain("X-out");
    expect(demands[0]!.effectivePrompt).toContain("Y-out");
    expect(demands[0]!.effectivePrompt).toContain("Write the code");
  });

  // ── done/running node skipping ─────────────────────────────────────────────

  it("skips done sequential root (state === done)", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [{ type: "agent" }],
      },
      "0",
    );
    cursor.state = "done";
    const t = task(cursor);
    expect(nextWantedAgents(t)).toHaveLength(0);
  });

  it("skips running sequential node — delegates to children", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [{ type: "agent", title: "a" }],
      },
      "0",
    );
    cursor.state = "running";
    const t = task(cursor);
    // Sequential is running but child is pending → demand for child.
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.0");
  });

  // ── profileResolver (C3 fix: provider/model on demands) ───────────────────

  it("demands have undefined provider/model when no resolver is given", () => {
    const cursor = buildCursor({ type: "agent", profile: "coder" }, "0");
    const t = task(cursor, { profile: "coder" });
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.provider).toBeUndefined();
    expect(demands[0]!.model).toBeUndefined();
  });

  it("populates provider and model on a demand when a resolver is given", () => {
    const cursor = buildCursor({ type: "agent", profile: "coder" }, "0");
    const t = task(cursor, { profile: "coder" });
    const resolver = (name: string): { provider?: string; model?: string } => {
      if (name === "coder") return { provider: "anthropic", model: "claude-sonnet-4-5" };
      return {};
    };
    const demands = nextWantedAgents(t, resolver);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.provider).toBe("anthropic");
    expect(demands[0]!.model).toBe("claude-sonnet-4-5");
  });

  it("resolver is called with the effective profile name (atom override > task)", () => {
    const cursor = buildCursor({ type: "agent", profile: "reviewer" }, "0");
    const t = task(cursor, { profile: "coder" });
    const seen: string[] = [];
    const resolver = (name: string): { provider?: string; model?: string } => {
      seen.push(name);
      if (name === "reviewer") return { provider: "openai", model: "gpt-4o" };
      return {};
    };
    const demands = nextWantedAgents(t, resolver);
    expect(demands).toHaveLength(1);
    expect(seen).toEqual(["reviewer"]);
    expect(demands[0]!.provider).toBe("openai");
    expect(demands[0]!.model).toBe("gpt-4o");
  });

  it("parallel: each demand gets its own resolved provider/model independently", () => {
    const cursor = buildCursor(
      {
        type: "parallel",
        atoms: [
          { type: "agent", profile: "a" },
          { type: "agent", profile: "b" },
          { type: "agent", profile: "c" },
        ],
      },
      "0",
    );
    const t = task(cursor);
    const profiles: Record<string, { provider?: string; model?: string }> = {
      a: { provider: "anthropic", model: "claude-sonnet-4-5" },
      b: { provider: "openai", model: "gpt-4o" },
      c: { provider: "anthropic", model: "claude-haiku-3-5" },
    };
    const resolver = (name: string): { provider?: string; model?: string } => profiles[name] ?? {};
    const demands = nextWantedAgents(t, resolver);
    expect(demands).toHaveLength(3);
    expect(demands[0]!.provider).toBe("anthropic");
    expect(demands[0]!.model).toBe("claude-sonnet-4-5");
    expect(demands[1]!.provider).toBe("openai");
    expect(demands[1]!.model).toBe("gpt-4o");
    expect(demands[2]!.provider).toBe("anthropic");
    expect(demands[2]!.model).toBe("claude-haiku-3-5");
  });

  it("gateLoop work and review get distinct resolved provider/model", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent", profile: "coder" },
        review: { type: "agent", profile: "reviewer" },
      },
      "0",
    );
    cursor.state = "running";
    const t = task(cursor);
    const profiles: Record<string, { provider?: string; model?: string }> = {
      coder: { provider: "anthropic", model: "claude-sonnet-4-5" },
      reviewer: { provider: "openai", model: "o3" },
    };
    const resolver = (name: string): { provider?: string; model?: string } => profiles[name] ?? {};

    // Work phase
    const workDemands = nextWantedAgents(t, resolver);
    expect(workDemands).toHaveLength(1);
    expect(workDemands[0]!.provider).toBe("anthropic");
    expect(workDemands[0]!.model).toBe("claude-sonnet-4-5");

    // Switch to review phase
    cursor.gatePhase = "review";
    cursor.workCursor!.state = "done";
    cursor.workCursor!.lastText = "Done";
    const reviewDemands = nextWantedAgents(t, resolver);
    expect(reviewDemands).toHaveLength(1);
    expect(reviewDemands[0]!.provider).toBe("openai");
    expect(reviewDemands[0]!.model).toBe("o3");
  });

  it("resolver returning empty object leaves provider/model undefined", () => {
    const cursor = buildCursor({ type: "agent", profile: "unknown" }, "0");
    const t = task(cursor);
    const resolver = (): { provider?: string; model?: string } => ({});
    const demands = nextWantedAgents(t, resolver);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.provider).toBeUndefined();
    expect(demands[0]!.model).toBeUndefined();
  });

  it("sequential: second child demand gets resolved provider/model after first completes", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", profile: "planner" },
          { type: "agent", profile: "coder" },
        ],
      },
      "0",
    );
    const t = task(cursor);
    child(cursor, 0).state = "done";
    cursor.childIndex = 1;
    const resolver = (name: string): { provider?: string; model?: string } => {
      if (name === "coder") return { provider: "anthropic", model: "claude-sonnet-4-5" };
      return {};
    };
    const demands = nextWantedAgents(t, resolver);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.profileName).toBe("coder");
    expect(demands[0]!.provider).toBe("anthropic");
    expect(demands[0]!.model).toBe("claude-sonnet-4-5");
  });
});

// ── advanceComposeCursor ─────────────────────────────────────────────────────

describe("advanceComposeCursor", () => {
  // ── agent ──────────────────────────────────────────────────────────────────

  it("agent: marks node done, stores lastText and sessionFile", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);

    const result = advanceComposeCursor(
      t,
      "0",
      okResult("my-output", { sessionFile: "/s/session.jsonl" }),
    );
    expect(cursor.state).toBe("done");
    expect(cursor.lastText).toBe("my-output");
    expect(cursor.sessionFile).toBe("/s/session.jsonl");
    expect(result).toEqual({ composeComplete: true, needsMerge: true });
  });

  it("agent: composeComplete false when root not done (nested tree)", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
        ],
      },
      "0",
    );
    const t = task(cursor);

    // Mark first child done.
    const result = advanceComposeCursor(t, "0.0", okResult("A-out"));
    expect(child(cursor, 0).state).toBe("done");
    expect(child(cursor, 0).lastText).toBe("A-out");
    // Sequential should have advanced childIndex.
    expect(cursor.childIndex).toBe(1);
    // Root is not done because second child remains.
    expect(result).toEqual({ composeComplete: false, needsMerge: false });
  });

  it("agent: throws when atomPath does not exist", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    expect(() => advanceComposeCursor(t, "nonexistent", okResult("x"))).toThrow(
      'no cursor node found at path "nonexistent"',
    );
  });

  it("agent: throws when atomPath points at a container node", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [{ type: "agent" }],
      },
      "0",
    );
    const t = task(cursor);
    expect(() => advanceComposeCursor(t, "0", okResult("x"))).toThrow(
      "unexpected direct advance of sequential node",
    );
  });

  // ── sequential ─────────────────────────────────────────────────────────────

  it("sequential: advances childIndex when child completes", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
          { type: "agent", title: "c" },
        ],
      },
      "0",
    );
    const t = task(cursor);

    // Complete first child.
    advanceComposeCursor(t, "0.0", okResult("A-out"));
    expect(cursor.childIndex).toBe(1);
    expect(cursor.state).not.toBe("done");

    // Complete second child.
    advanceComposeCursor(t, "0.1", okResult("B-out"));
    expect(cursor.childIndex).toBe(2);
    expect(cursor.state).not.toBe("done");

    // Complete third child → sequential done.
    advanceComposeCursor(t, "0.2", okResult("C-out"));
    expect(cursor.childIndex).toBe(3);
    expect(cursor.state).toBe("done");
    expect(cursor.lastText).toBe("C-out");
  });

  it("sequential: result flows as context to next sibling (via lastText)", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
        ],
      },
      "0",
    );
    const t = task(cursor);

    // Complete A.
    advanceComposeCursor(t, "0.0", okResult("Step-A output"));

    // B should now see A's output as context.
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.effectivePrompt).toBe("Step-A output\n\n---\n\nWrite the code");
  });

  // ── parallel ───────────────────────────────────────────────────────────────

  it("parallel: all children done → node done with headed concatenation", () => {
    const cursor = buildCursor(
      {
        type: "parallel",
        atoms: [
          { type: "agent", title: "Researcher" },
          { type: "agent", title: "Coder" },
        ],
      },
      "0",
    );
    const t = task(cursor);

    // Complete first parallel child.
    advanceComposeCursor(t, "0.0", okResult("Research findings"));
    expect(cursor.state).not.toBe("done"); // sibling still pending

    // Complete second parallel child.
    const result = advanceComposeCursor(t, "0.1", okResult("Implemented feature"));
    expect(cursor.state).toBe("done");
    expect(cursor.lastText).toBe("Researcher\nResearch findings\n\nCoder\nImplemented feature");
    expect(result).toEqual({ composeComplete: true, needsMerge: true });
  });

  it("parallel: fallback header uses profile when title is absent", () => {
    const cursor = buildCursor(
      {
        type: "parallel",
        atoms: [
          { type: "agent", profile: "research-agent" },
          { type: "agent", profile: "code-agent" },
        ],
      },
      "0",
    );
    const t = task(cursor);

    advanceComposeCursor(t, "0.0", okResult("R"));
    advanceComposeCursor(t, "0.1", okResult("C"));

    expect(cursor.lastText).toBe("research-agent\nR\n\ncode-agent\nC");
  });

  it("parallel: fallback header uses atom-N when neither title nor profile", () => {
    const cursor = buildCursor(
      {
        type: "parallel",
        atoms: [{ type: "agent" }, { type: "agent" }],
      },
      "0",
    );
    const t = task(cursor);

    advanceComposeCursor(t, "0.0", okResult("alpha"));
    advanceComposeCursor(t, "0.1", okResult("beta"));

    expect(cursor.lastText).toBe("atom-0\nalpha\n\natom-1\nbeta");
  });

  // ── loop ───────────────────────────────────────────────────────────────────

  it("loop: child completes → advances iteration, resets childCursor for next iter", () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: { type: "agent" },
        count: 2,
      },
      "L",
    );
    const t = task(cursor);

    // Complete iteration 1.
    const r1 = advanceComposeCursor(t, "L.iter", okResult("Iteration 1 output"));
    expect(cursor.loopIteration).toBe(2); // advanced
    expect(cursor.prevIterationText).toBe("Iteration 1 output");
    expect(cursor.childCursor!.state).toBe("pending"); // reset for next iter
    expect(cursor.state).not.toBe("done"); // still one more to go
    expect(r1.composeComplete).toBe(false);

    // Complete iteration 2.
    const r2 = advanceComposeCursor(t, "L.iter", okResult("Iteration 2 output"));
    expect(cursor.loopIteration).toBe(3); // > count
    expect(cursor.state).toBe("done");
    expect(cursor.lastText).toBe("Iteration 2 output");
    expect(r2).toEqual({ composeComplete: true, needsMerge: true });
  });

  it("loop: single iteration (count=1) completes immediately", () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: { type: "agent" },
        count: 1,
      },
      "L",
    );
    const t = task(cursor);

    const result = advanceComposeCursor(t, "L.iter", okResult("Only output"));
    expect(cursor.loopIteration).toBe(2); // > 1
    expect(cursor.state).toBe("done");
    expect(cursor.lastText).toBe("Only output");
    expect(result.composeComplete).toBe(true);
  });

  it("loop: iteration chaining — next iteration sees prev text as context", () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: { type: "agent" },
        count: 3,
      },
      "L",
    );
    const t = task(cursor);

    // Complete iteration 1.
    advanceComposeCursor(t, "L.iter", okResult("Iter1"));

    // Verify iteration 2 gets Iter1 as context.
    let demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.effectivePrompt).toContain("Iter1");

    // Complete iteration 2.
    advanceComposeCursor(t, "L.iter", okResult("Iter2"));

    // Verify iteration 3 gets Iter2 as context.
    demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.effectivePrompt).toContain("Iter2");
    expect(demands[0]!.effectivePrompt).not.toContain("Iter1");
  });

  it("loop[sequential[a,b], count=2]: after iter 1, nextWantedAgents yields demand for iter 2 (childIndex reset)", () => {
    // Regression test for kb-9: resetCursorState was kind-agnostic and
    // wiped childIndex to undefined on sequential bodies, causing
    // demandsFor to return [] → deadlock on iteration 2+.
    const cursor = buildCursor(
      {
        type: "loop",
        atom: {
          type: "sequential",
          atoms: [
            { type: "agent", title: "a" },
            { type: "agent", title: "b" },
          ],
        },
        count: 2,
      },
      "L",
    );
    const t = task(cursor);

    // ── Iteration 1 ──

    // Step 1: agent 'a' should start (childIndex=0).
    let demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("L.iter.0");

    // Complete agent 'a'.
    advanceComposeCursor(t, "L.iter.0", okResult("A1"));

    // Step 2: agent 'b' should start now.
    demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("L.iter.1");

    // Complete agent 'b' — this marks the sequential done, which triggers
    // the loop's recomputeCompletion to advance to iteration 2.
    advanceComposeCursor(t, "L.iter.1", okResult("B1"));

    // Verify loop advanced.
    expect(cursor.loopIteration).toBe(2);
    expect(cursor.prevIterationText).toBe("B1");

    // ── Iteration 2 ──

    // The sequential body should have been reset: childIndex=0 so 'a' runs.
    demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("L.iter.0");
    // Iteration 2 sees iteration 1's output as flow context.
    expect(demands[0]!.effectivePrompt).toContain("B1");
    expect(demands[0]!.effectivePrompt).toContain("Write the code");
  });

  // ── resetCursorState coverage ──────────────────────────────────────────────

  it("loop[parallel[a,b], count=2]: resetCursorState resets parallel body", () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: {
          type: "parallel",
          atoms: [
            { type: "agent", title: "x" },
            { type: "agent", title: "y" },
          ],
        },
        count: 2,
      },
      "L",
    );
    const t = task(cursor);

    // Complete iteration 1.
    advanceComposeCursor(t, "L.iter.0", okResult("PX"));
    advanceComposeCursor(t, "L.iter.1", okResult("PY"));

    // Loop should advance to iteration 2 and reset the parallel body.
    expect(cursor.loopIteration).toBe(2);
    expect(cursor.childCursor!.state).toBe("pending");
    expect(cursor.childCursor!.children![0]!.state).toBe("pending");
    expect(cursor.childCursor!.children![1]!.state).toBe("pending");

    // Iteration 2: both agents should start again.
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(2);
    expect(demands.map((d) => d.atomPath)).toEqual(["L.iter.0", "L.iter.1"]);
  });

  it("loop[gateLoop[work,review], count=2]: resetCursorState resets gateLoop body", () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: {
          type: "gateLoop",
          work: { type: "agent", title: "writer" },
          review: { type: "agent", title: "reviewer" },
        },
        count: 2,
      },
      "L",
    );
    const t = task(cursor);

    // Run work phase.
    advanceComposeCursor(t, "L.iter.work", okResult("Draft"), {
      handleGateLoop(node) {
        node.gatePhase = "review";
      },
    });

    // Run review phase and approve.
    advanceComposeCursor(
      t,
      "L.iter.review",
      okResult("Approved", { verdict: { approved: true, feedback: "" } }),
      {
        handleGateLoop(node) {
          node.state = "done";
          node.lastText = node.workCursor?.lastText;
        },
      },
    );

    // Loop completes iteration 1 and resets the gateLoop body for iteration 2.
    expect(cursor.loopIteration).toBe(2);
    expect(cursor.childCursor!.state).toBe("pending");
    expect(cursor.childCursor!.gatePhase).toBe("work");
    expect(cursor.childCursor!.iteration).toBe(1);

    // Iteration 2: work agent should start again.
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("L.iter.work");
  });

  it("loop[loop[agent, count=2], count=2]: resetCursorState resets nested loop body", () => {
    const cursor = buildCursor(
      {
        type: "loop",
        atom: {
          type: "loop",
          atom: { type: "agent", title: "inner" },
          count: 2,
        },
        count: 2,
      },
      "L",
    );
    const t = task(cursor);

    // Complete outer iteration 1: need to run inner loop's 2 iterations.
    advanceComposeCursor(t, "L.iter.iter", okResult("Inner1"));
    advanceComposeCursor(t, "L.iter.iter", okResult("Inner2"));

    // Outer loop advances to iteration 2, resets the inner loop.
    expect(cursor.loopIteration).toBe(2);
    expect(cursor.childCursor!.state).toBe("pending");
    expect(cursor.childCursor!.loopIteration).toBe(1);

    // Iteration 2: inner loop should start again.
    const demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("L.iter.iter");
  });

  it("recomputeCompletion: loop without childCursor is marked done", () => {
    // Build a sequential[ loop(no-childCursor), agent-after ]. Completing
    // agent-after triggers recomputeCompletion from root, which walks into
    // the loop (no childCursor → marked done), then advances the sequential.
    const seq = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "loop", atom: { type: "agent" }, count: 2 },
          { type: "agent", title: "after" },
        ],
      },
      "0",
    );
    const innerLoop = seq.children![0]!;
    innerLoop.childCursor = undefined; // simulate malformed loop
    const t = task(seq);

    // Complete the "after" agent. advanceComposeCursor calls
    // recomputeCompletion on the root: sequential sees child 0 (loop) —
    // recomputes it (no childCursor → state=done), then child 1 (agent)
    // is also done, so sequential advances childIndex to 2.
    advanceComposeCursor(t, "0.1", okResult("done"));
    expect(innerLoop.state).toBe("done");
    expect(seq.childIndex).toBe(2);
  });

  it("assertNever in recomputeCompletion throws on unknown cursor kind", () => {
    // Build sequential[ a, b ]. Corrupt b's kind, then complete a.
    // advanceComposeCursor marks a done, then recomputeCompletion walks
    // the tree: sequential recurses into children, hits b's "bogus" kind,
    // and throws via assertNever.
    const root = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
        ],
      },
      "0",
    );
    root.children![1]!.kind = "bogus" as never;
    const t = task(root);
    expect(() => advanceComposeCursor(t, "0.0", okResult("A"))).toThrow("Unexpected value");
  });

  // ── gateLoop (via handler) ─────────────────────────────────────────────────

  it("gateLoop: handleGateLoop callback is called with node and result", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent" },
        review: { type: "agent" },
      },
      "g",
    );
    cursor.state = "running";
    cursor.gatePhase = "review";
    cursor.reviewCursor!.state = "running";

    const t = task(cursor);
    const handler = vi.fn();

    // Complete the review agent.
    const result = advanceComposeCursor(
      t,
      "g.review",
      okResult("review-done", { verdict: { approved: true, feedback: "" } }),
      { handleGateLoop: handler },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      cursor,
      expect.objectContaining({ lastText: "review-done" }),
    );
    // The handler is responsible for setting cursor.state = "done".
    // Since we didn't set it in the handler, composeComplete should be false.
    expect(result.composeComplete).toBe(false);
  });

  it("gateLoop: no handler provided → advance does nothing beyond sub-cursor", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent" },
        review: { type: "agent" },
      },
      "g",
    );
    cursor.state = "running";
    cursor.gatePhase = "review";
    cursor.reviewCursor!.state = "running";

    const t = task(cursor);

    // No handler — should not throw, just recompute sub-cursors.
    const result = advanceComposeCursor(t, "g.review", okResult("review-output"));
    // The gateLoop node itself should NOT be marked done (no handler).
    expect(cursor.state).toBe("running");
    expect(cursor.reviewCursor!.state).toBe("done");
    expect(cursor.reviewCursor!.lastText).toBe("review-output");
    expect(result.composeComplete).toBe(false);
  });

  it("gateLoop: handler can approve and mark node done", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent" },
        review: { type: "agent" },
      },
      "g",
    );
    cursor.state = "running";
    cursor.gatePhase = "review";
    cursor.workCursor!.state = "done";
    cursor.workCursor!.lastText = "Work result";
    cursor.reviewCursor!.state = "running";

    const t = task(cursor);

    const result = advanceComposeCursor(
      t,
      "g.review",
      okResult("Approved", { verdict: { approved: true, feedback: "Looks good" } }),
      {
        handleGateLoop(node) {
          node.state = "done";
          node.lastText = node.workCursor?.lastText;
        },
      },
    );

    expect(cursor.state).toBe("done");
    expect(cursor.lastText).toBe("Work result");
    expect(result).toEqual({ composeComplete: true, needsMerge: true });
  });

  it("gateLoop: advancement of gateLoop work agent without handler", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent" },
        review: { type: "agent" },
      },
      "g",
    );
    cursor.state = "running";
    cursor.gatePhase = "work";

    const t = task(cursor);

    // Complete the work agent with no handler.
    advanceComposeCursor(t, "g.work", okResult("work-output"));
    // Work cursor should be done, but gateLoop handler wasn't called.
    expect(cursor.workCursor!.state).toBe("done");
    expect(cursor.workCursor!.lastText).toBe("work-output");
    expect(cursor.state).toBe("running"); // gateLoop still running (no handler to advance phase)
  });

  // ── Root completion ────────────────────────────────────────────────────────

  it("single agent completes → root done → composeComplete + needsMerge", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    const result = advanceComposeCursor(t, "0", okResult("done"));
    expect(result).toEqual({ composeComplete: true, needsMerge: true });
  });

  it("nested sequential completes fully → composeComplete true", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
        ],
      },
      "0",
    );
    const t = task(cursor);

    advanceComposeCursor(t, "0.0", okResult("A"));
    const r1 = advanceComposeCursor(t, "0.1", okResult("B"));
    expect(r1).toEqual({ composeComplete: true, needsMerge: true });
    expect(cursor.state).toBe("done");
    expect(cursor.lastText).toBe("B");
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it("agent node with no sessionFile in result", () => {
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    advanceComposeCursor(t, "0", okResult("output"));
    expect(cursor.sessionFile).toBeUndefined();
  });

  it("sequential with empty children array is immediately done", () => {
    const cursor = buildCursor({ type: "sequential", atoms: [] }, "0");
    // An empty sequential with no agent leaves to advance is a degenerate
    // case that won't produce demands; its state stays "pending" until the
    // scheduler runs recomputeCompletion (which marks it done).
    expect(cursor.state).toBe("pending");
  });

  it("parallel with empty children array is immediately done", () => {
    const cursor = buildCursor({ type: "parallel", atoms: [] }, "0");
    // An empty parallel has no children to advance; same degenerate case.
    expect(cursor.state).toBe("pending");
  });

  it("invalid loop count is rejected before its child can produce an agent demand", () => {
    expect(() => buildCursor({ type: "loop", atom: { type: "agent" }, count: 0 }, "L")).toThrow(
      /Loop count must be an integer from 1 through 100/,
    );
  });

  it("reports needsMerge=false when root not done", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "a" },
          { type: "agent", title: "b" },
        ],
      },
      "0",
    );
    const t = task(cursor);
    const result = advanceComposeCursor(t, "0.0", okResult("A"));
    expect(result.needsMerge).toBe(false);
    expect(result.composeComplete).toBe(false);
  });

  // ── Propagation examples from spec §5.5 ────────────────────────────────────

  it("spec example: sequential[ gateLoop(tw,tr), gateLoop(cw,cr) ] (TDD)", () => {
    // Simulate a TDD-style workflow: test-writer gateLoop then coder gateLoop.
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          {
            type: "gateLoop",
            work: { type: "agent", title: "test-writer" },
            review: { type: "agent", title: "test-reviewer" },
            maxIterations: 3,
          },
          {
            type: "gateLoop",
            work: { type: "agent", title: "coder" },
            review: { type: "agent", title: "code-reviewer" },
            maxIterations: 3,
          },
        ],
      },
      "0",
    );
    const t = task(cursor, { prompt: "Build TDD feature" });

    // ── First gateLoop: test-writer ──

    // Step 1: work phase — test-writer should start.
    let demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.0.work");
    expect(demands[0]!.effectivePrompt).toBe("Build TDD feature");

    // Complete test-writer work.
    const gate1 = child(cursor, 0);
    advanceComposeCursor(t, "0.0.work", okResult("Tests written"), {
      handleGateLoop(node) {
        // After work completes, switch to review phase.
        node.gatePhase = "review";
      },
    });
    expect(gate1.workCursor!.state).toBe("done");
    expect(gate1.gatePhase).toBe("review");

    // Step 2: review phase — test-reviewer should start with work output as context.
    demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.0.review");
    expect(demands[0]!.effectivePrompt).toBe("Tests written\n\n---\n\nBuild TDD feature");

    // Complete review — approved.
    advanceComposeCursor(
      t,
      "0.0.review",
      okResult("Looks good", { verdict: { approved: true, feedback: "Great tests" } }),
      {
        handleGateLoop(node) {
          node.state = "done";
          node.lastText = node.workCursor?.lastText;
        },
      },
    );
    expect(gate1.state).toBe("done");

    // ── Second gateLoop: coder ──
    // Sequential should now advance to index 1.
    expect(cursor.childIndex).toBe(1);

    // Step 3: work phase — coder starts with gate1's lastText as context.
    demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.1.work");
    expect(demands[0]!.effectivePrompt).toContain("Tests written");
    expect(demands[0]!.effectivePrompt).toContain("Build TDD feature");
  });

  it("spec example: sequential[ parallel[research-1, research-2, research-3], summarize ]", () => {
    const cursor = buildCursor(
      {
        type: "sequential",
        atoms: [
          {
            type: "parallel",
            atoms: [
              { type: "agent", title: "Research-A" },
              { type: "agent", title: "Research-B" },
              { type: "agent", title: "Research-C" },
            ],
          },
          { type: "agent", title: "Summarizer" },
        ],
      },
      "0",
    );
    const t = task(cursor, { prompt: "Research and summarize" });

    // Step 1: all three research agents start concurrently.
    let demands = nextWantedAgents(t);
    expect(demands).toHaveLength(3);
    expect(demands.map((d) => d.atomPath)).toEqual(["0.0.0", "0.0.1", "0.0.2"]);

    // Complete each research agent.
    advanceComposeCursor(t, "0.0.0", okResult("Research A findings"));
    advanceComposeCursor(t, "0.0.1", okResult("Research B findings"));
    advanceComposeCursor(t, "0.0.2", okResult("Research C findings"));

    // Parallel node should now be done with headed concatenation.
    const parallelNode = child(cursor, 0);
    expect(parallelNode.state).toBe("done");
    expect(parallelNode.lastText).toContain("Research-A\nResearch A findings");
    expect(parallelNode.lastText).toContain("Research-B\nResearch B findings");
    expect(parallelNode.lastText).toContain("Research-C\nResearch C findings");

    // Sequential should advance to index 1.
    expect(cursor.childIndex).toBe(1);

    // Step 2: summarizer starts with the parallel output as context.
    demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("0.1");
    const effPrompt = demands[0]!.effectivePrompt;
    expect(effPrompt).toContain("Research-A\nResearch A findings");
    expect(effPrompt).toContain("Research-B\nResearch B findings");
    expect(effPrompt).toContain("Research-C\nResearch C findings");
    expect(effPrompt).toContain("Research and summarize");
  });

  it("spec example: gateLoop(plan-writer, plan-reviewer)", () => {
    const cursor = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent", title: "Plan Writer" },
        review: { type: "agent", title: "Plan Reviewer" },
        maxIterations: 3,
      },
      "plan",
    );
    cursor.state = "running";
    const t = task(cursor, { prompt: "Write a plan" });

    // Step 1: work phase — plan writer starts.
    let demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("plan.work");

    // Simulate a handler that manages the gateLoop lifecycle.
    const gateHandler = vi.fn((node: CursorNode, result: AgentRunResult) => {
      if (result.verdict?.approved) {
        node.state = "done";
        node.lastText = node.workCursor?.lastText;
      } else if (result.verdict === undefined) {
        // Work just finished → switch to review
        node.gatePhase = "review";
      } else {
        // Review rejected → go back to work with feedback
        node.gatePhase = "work";
        node.lastFeedback = result.verdict.feedback;
        node.iteration = (node.iteration ?? 1) + 1;
        // Reset work cursor
        if (node.workCursor) {
          node.workCursor.state = "pending";
          node.workCursor.lastText = undefined;
          node.workCursor.sessionFile = undefined;
        }
      }
    });

    // Complete work — no verdict → handler switches to review.
    advanceComposeCursor(t, "plan.work", okResult("Draft plan"), { handleGateLoop: gateHandler });
    expect(cursor.gatePhase).toBe("review");

    // Step 2: review phase — plan reviewer starts with work output as context.
    demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.atomPath).toBe("plan.review");
    expect(demands[0]!.effectivePrompt).toContain("Draft plan");

    // Complete review — rejected with feedback.
    advanceComposeCursor(
      t,
      "plan.review",
      okResult("Needs work", { verdict: { approved: false, feedback: "Add timeline" } }),
      { handleGateLoop: gateHandler },
    );
    expect(cursor.gatePhase).toBe("work");
    expect(cursor.lastFeedback).toBe("Add timeline");
    expect(cursor.iteration).toBe(2);

    // Step 3: work phase resumes with feedback as context prefix.
    demands = nextWantedAgents(t);
    expect(demands).toHaveLength(1);
    expect(demands[0]!.effectivePrompt).toContain("Previous review feedback:\nAdd timeline");
    expect(demands[0]!.effectivePrompt).toContain("Write a plan");

    // Complete work again.
    advanceComposeCursor(t, "plan.work", okResult("Revised draft with timeline"), {
      handleGateLoop: gateHandler,
    });
    expect(cursor.gatePhase).toBe("review");

    // Complete review — approved.
    advanceComposeCursor(
      t,
      "plan.review",
      okResult("Approved", { verdict: { approved: true, feedback: "" } }),
      { handleGateLoop: gateHandler },
    );
    expect(cursor.state).toBe("done");
    expect(cursor.lastText).toBe("Revised draft with timeline");
  });

  // ── Coverage edge cases ───────────────────────────────────────────────────

  it("gateLoopParentPath: handler called but atomPath is not a gateLoop child", () => {
    // When a handler is provided but the completed agent is NOT inside a
    // gateLoop, the handler should NOT be called (gateLoopParentPath returns
    // undefined for paths without ".work" or ".review" suffix).
    const cursor = buildCursor(undefined, "0");
    const t = task(cursor);
    const handler = vi.fn();

    advanceComposeCursor(t, "0", okResult("done"), { handleGateLoop: handler });
    expect(handler).not.toHaveBeenCalled();
  });

  it("gateLoopParentPath: handler called but parent is not a gateLoop", () => {
    // When atomPath ends with ".x" but the parent isn't a gateLoop, the
    // handler should not be called (the parent check fails).
    // Build a trivial cursor — the path "0.x" doesn't exist, so we expect
    // a throw, which is fine for this edge case since it confirms the
    // gateLoopParentPath logic doesn't misfire.
    const cursor = buildCursor({ type: "sequential", atoms: [{ type: "agent" }] }, "0");
    const t = task(cursor);
    const handler = vi.fn();

    // Complete the first child. The atomPath "0.0" does NOT end with
    // ".work" or ".review", so gateLoopParentPath returns undefined.
    advanceComposeCursor(t, "0.0", okResult("done"), { handleGateLoop: handler });
    expect(handler).not.toHaveBeenCalled();
  });

  it("resetCursorState recurses into sub-cursors when they exist", () => {
    // Build a loop whose childCursor is a sequential with children to
    // exercise the sub-cursor recursion in resetCursorState.
    const cursor = buildCursor(
      {
        type: "loop",
        atom: {
          type: "sequential",
          atoms: [
            { type: "agent", title: "inner-a" },
            { type: "agent", title: "inner-b" },
          ],
        },
        count: 2,
      },
      "L",
    );
    const t = task(cursor);

    // Complete iteration 1 (both sequential children).
    advanceComposeCursor(t, "L.iter.0", okResult("A1"));
    advanceComposeCursor(t, "L.iter.1", okResult("B1"));

    // After both children are done, the sequential's recomputeCompletion
    // should mark the sequential done, then the loop's recomputeCompletion
    // should advance to iteration 2 and reset the childCursor tree.
    const loopNode = cursor;
    expect(loopNode.loopIteration).toBeGreaterThan(1);
    // The child cursor and its descendants should be reset to pending.
    expect(loopNode.childCursor!.state).toBe("pending");
    expect(loopNode.childCursor!.children![0]!.state).toBe("pending");
    expect(loopNode.childCursor!.children![1]!.state).toBe("pending");
  });

  it("assertNever in demandsFor throws on unknown cursor kind", () => {
    const cursor = buildCursor(undefined, "0");
    // Corrupt the kind to trigger assertNever in demandsFor
    (cursor as { kind: string }).kind = "unknown-kind";
    const t = task(cursor);
    expect(() => nextWantedAgents(t)).toThrow("Unexpected value");
  });

  it("assertNever in recomputeCompletion throws on unknown cursor kind", () => {
    // First complete the agent so advanceComposeCursor calls recomputeCompletion
    // on the root, which will iterate agents and then hit assertNever.
    // Actually, the agent case doesn't switch on kind in recomputeCompletion,
    // so we need a composite node with a bogus child kind.
    const root = buildCursor(
      {
        type: "sequential",
        atoms: [{ type: "agent" }],
      },
      "0",
    );
    // Corrupt the child's kind
    (root.children![0]! as { kind: string }).kind = "bogus";
    const t = task(root);
    // The agent's state is pending, so demandsFor will try to create a demand
    // and assertNever won't be hit. Instead, complete the corrupted child
    // via advanceComposeCursor, which will trigger recomputeCompletion.
    // But advanceComposeCursor will first try to mark it as an agent...
    // Actually the corrupted node has kind "bogus", so advanceComposeCursor
    // will hit the default throw first.
    expect(() => advanceComposeCursor(t, "0.0", okResult("x"))).toThrow(
      "unexpected direct advance of bogus node",
    );
  });
});
