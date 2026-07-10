import { describe, it, expect, vi } from "vitest";

import {
  extractVerdict,
  needsReminderRetry,
  handleGateLoopResult,
  buildReviewerReminder,
} from "../gateloop";
import type { AgentRunResult, CursorNode, GateVerdict, TaskRuntime } from "../types";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Build a minimal task runtime for gateLoop tests. */
function task(overrides?: Partial<TaskRuntime>): TaskRuntime {
  return {
    id: "t-1",
    title: undefined,
    prompt: "Write the code",
    profile: undefined,
    dependsOn: [],
    compose: { type: "gateLoop", work: { type: "agent" }, review: { type: "agent" } },
    cursor: {} as CursorNode,
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

/** A successful agent result. */
function okResult(lastText: string, overrides?: Partial<AgentRunResult>): AgentRunResult {
  return {
    success: true,
    lastText,
    exitCode: 0,
    durationMs: 100,
    ...overrides,
  };
}

/** Build a minimal gateLoop cursor node (work phase, iteration 1). */
function gateLoopNode(overrides?: Partial<CursorNode>): CursorNode {
  return {
    kind: "gateLoop",
    path: "0",
    state: "pending",
    gatePhase: "work",
    iteration: 1,
    workCursor: {
      kind: "agent",
      path: "0.work",
      state: "pending",
    },
    reviewCursor: {
      kind: "agent",
      path: "0.review",
      state: "pending",
    },
    ...overrides,
  };
}

/** Build a gateLoop cursor node already in review phase. */
function gateLoopInReviewPhase(overrides?: Partial<CursorNode>): CursorNode {
  return gateLoopNode({
    gatePhase: "review",
    iteration: 1,
    workCursor: {
      kind: "agent",
      path: "0.work",
      state: "done",
      lastText: "Work output from first iteration",
      sessionFile: "/sessions/t-1/work-0.json",
    },
    reviewCursor: {
      kind: "agent",
      path: "0.review",
      state: "pending",
    },
    ...overrides,
  });
}

// ── extractVerdict ───────────────────────────────────────────────────────────

describe("extractVerdict", () => {
  it("returns result.verdict when present (approved)", () => {
    const verdict: GateVerdict = { approved: true, feedback: "Looks great" };
    const result = okResult("unused", { verdict });
    expect(extractVerdict(result)).toEqual(verdict);
  });

  it("returns result.verdict when present (rejected)", () => {
    const verdict: GateVerdict = { approved: false, feedback: "Need more tests" };
    const result = okResult("unused", { verdict });
    expect(extractVerdict(result)).toEqual(verdict);
  });

  it("parses valid JSON verdict from lastText", () => {
    const result = okResult(JSON.stringify({ approved: true, feedback: "Good" }));
    expect(extractVerdict(result)).toEqual({ approved: true, feedback: "Good" });
  });

  it("parses valid JSON verdict with extra fields", () => {
    const result = okResult(
      JSON.stringify({ approved: false, feedback: "Fix it", extra: "ignored" }),
    );
    expect(extractVerdict(result)).toEqual({ approved: false, feedback: "Fix it" });
  });

  it("returns fallback verdict when lastText is empty", () => {
    const result = okResult("");
    expect(extractVerdict(result)).toEqual({
      approved: false,
      feedback: "reviewer produced no valid verdict",
    });
  });

  it("returns fallback verdict when lastText is not valid JSON", () => {
    const result = okResult("The work looks fine to me, approved!");
    expect(extractVerdict(result)).toEqual({
      approved: false,
      feedback: "reviewer produced no valid verdict",
    });
  });

  it("returns fallback verdict when lastText is valid JSON but missing approved field", () => {
    const result = okResult(JSON.stringify({ feedback: "ok" }));
    expect(extractVerdict(result)).toEqual({
      approved: false,
      feedback: "reviewer produced no valid verdict",
    });
  });

  it("returns fallback verdict when approved is not boolean", () => {
    const result = okResult(JSON.stringify({ approved: "yes", feedback: "ok" }));
    expect(extractVerdict(result)).toEqual({
      approved: false,
      feedback: "reviewer produced no valid verdict",
    });
  });

  it("returns fallback verdict when feedback is not string", () => {
    const result = okResult(JSON.stringify({ approved: true, feedback: 42 }));
    expect(extractVerdict(result)).toEqual({
      approved: false,
      feedback: "reviewer produced no valid verdict",
    });
  });

  it("returns fallback verdict when lastText is malformed JSON", () => {
    const result = okResult("{ approved: true }");
    expect(extractVerdict(result)).toEqual({
      approved: false,
      feedback: "reviewer produced no valid verdict",
    });
  });

  // ── Structured verdict validation ────────────────────────────────────────

  it("returns fallback verdict when result.verdict is null", () => {
    const result = okResult("unused", { verdict: null as unknown as GateVerdict });
    expect(extractVerdict(result)).toEqual({
      approved: false,
      feedback: "reviewer produced no valid verdict",
    });
  });

  it("returns fallback verdict when verdict.approved is missing (partial verdict)", () => {
    const result = okResult("unused", {
      verdict: { approved: true } as GateVerdict, // missing feedback
    });
    const parsed = extractVerdict(result);
    expect(parsed.approved).toBe(false);
    expect(parsed.feedback).toBe("reviewer produced no valid verdict");
  });

  it("returns fallback verdict when verdict.feedback has wrong type", () => {
    const result = okResult("unused", {
      verdict: { approved: true, feedback: 42 } as unknown as GateVerdict,
    });
    expect(extractVerdict(result)).toEqual({
      approved: false,
      feedback: "reviewer produced no valid verdict",
    });
  });

  it("returns fallback verdict when verdict.approved has wrong type", () => {
    const result = okResult("unused", {
      verdict: { approved: "yes", feedback: "ok" } as unknown as GateVerdict,
    });
    expect(extractVerdict(result)).toEqual({
      approved: false,
      feedback: "reviewer produced no valid verdict",
    });
  });
});

// ── needsReminderRetry ───────────────────────────────────────────────────────

describe("needsReminderRetry", () => {
  it("returns false when result.verdict is present", () => {
    const result = okResult("This is some text", {
      verdict: { approved: true, feedback: "ok" },
    });
    expect(needsReminderRetry(result)).toBe(false);
  });

  it("returns true when lastText is empty and no verdict", () => {
    const result = okResult("");
    expect(needsReminderRetry(result)).toBe(true);
  });

  it("returns true when lastText is non-JSON text and no verdict", () => {
    const result = okResult("I have reviewed the work and it looks good.");
    expect(needsReminderRetry(result)).toBe(true);
  });

  it("returns false when lastText is valid verdict JSON and no verdict", () => {
    const result = okResult(JSON.stringify({ approved: true, feedback: "ok" }));
    expect(needsReminderRetry(result)).toBe(false);
  });

  it("returns true when lastText is JSON but missing fields", () => {
    const result = okResult(JSON.stringify({ foo: "bar" }));
    expect(needsReminderRetry(result)).toBe(true);
  });

  it("returns true when lastText is JSON but approved is not boolean", () => {
    const result = okResult(JSON.stringify({ approved: "yes", feedback: "ok" }));
    expect(needsReminderRetry(result)).toBe(true);
  });

  it("returns true when lastText is JSON but feedback is not string", () => {
    const result = okResult(JSON.stringify({ approved: true, feedback: 42 }));
    expect(needsReminderRetry(result)).toBe(true);
  });

  it("returns false when lastText is valid verdict JSON with extra fields", () => {
    const result = okResult(JSON.stringify({ approved: false, feedback: "nope", extra: "data" }));
    expect(needsReminderRetry(result)).toBe(false);
  });
});

// ── handleGateLoopResult ─────────────────────────────────────────────────────

describe("handleGateLoopResult", () => {
  // ── Work result ────────────────────────────────────────────────────

  describe("work result (gatePhase was 'work')", () => {
    it("marks workCursor done and stores session file", () => {
      const gl = gateLoopNode();
      const t = task();
      const result = okResult("work output", {
        sessionFile: "/sessions/t-1/work-1.json",
      });

      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: false, exhausted: false });
      expect(gl.workCursor?.state).toBe("done");
      expect(gl.workCursor?.lastText).toBe("work output");
      expect(gl.workCursor?.sessionFile).toBe("/sessions/t-1/work-1.json");
      expect(gl.workSessionFile).toBe("/sessions/t-1/work-1.json");
      expect(gl.gatePhase).toBe("review");
    });

    it("resets reviewCursor to a fresh pending state", () => {
      // Simulate a used reviewCursor (e.g. from a previous iteration).
      const gl = gateLoopNode({
        reviewCursor: {
          kind: "agent",
          path: "0.review",
          state: "done",
          lastText: "old review",
          sessionFile: "/sessions/t-1/review-old.json",
          executionCount: 3,
        },
      });
      const t = task();
      const result = okResult("work output", { sessionFile: "/sessions/t-1/work-1.json" });

      handleGateLoopResult(t, gl, result);

      expect(gl.reviewCursor?.state).toBe("pending");
      expect(gl.reviewCursor?.lastText).toBeUndefined();
      expect(gl.reviewCursor?.sessionFile).toBeUndefined();
      expect(gl.reviewCursor?.executionCount).toBeUndefined();
      // Structural fields preserved.
      expect(gl.reviewCursor?.kind).toBe("agent");
      expect(gl.reviewCursor?.path).toBe("0.review");
    });

    it("handles work result when workCursor is undefined (no-op)", () => {
      const gl = gateLoopNode({ workCursor: undefined });
      const t = task();
      const result = okResult("work output", { sessionFile: "/sessions/t-1/work-1.json" });

      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: false, exhausted: false });
      expect(gl.workSessionFile).toBe("/sessions/t-1/work-1.json");
      expect(gl.gatePhase).toBe("review");
    });
  });

  // ── Review result: approved ─────────────────────────────────────────

  describe("review result approved", () => {
    it("marks gateLoop done and sets lastText from workCursor", () => {
      const gl = gateLoopInReviewPhase();
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: true, feedback: "Perfect" },
      });

      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: true, exhausted: false });
      expect(gl.state).toBe("done");
      expect(gl.lastText).toBe("Work output from first iteration");
    });

    it("calls onAudit with gateloop_approved", () => {
      const gl = gateLoopInReviewPhase();
      const t = task();
      const onAudit = vi.fn();
      const result = okResult("unused", {
        verdict: { approved: true, feedback: "Great" },
      });

      handleGateLoopResult(t, gl, result, { onAudit });

      expect(onAudit).toHaveBeenCalledTimes(1);
      expect(onAudit).toHaveBeenCalledWith("gateloop_approved", {
        iteration: 1,
        feedback: "Great",
        taskId: "t-1",
      });
    });

    it("uses empty string when workCursor has no lastText", () => {
      const gl = gateLoopInReviewPhase({
        workCursor: {
          kind: "agent",
          path: "0.work",
          state: "done",
          lastText: undefined,
          sessionFile: "/sessions/t-1/work-0.json",
        },
      });
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: true, feedback: "ok" },
      });

      handleGateLoopResult(t, gl, result);

      expect(gl.lastText).toBe("");
    });

    it("extracts verdict from lastText when structured verdict not present", () => {
      const gl = gateLoopInReviewPhase();
      const t = task();
      const result = okResult(JSON.stringify({ approved: true, feedback: "From JSON" }));

      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: true, exhausted: false });
      expect(gl.state).toBe("done");
    });
  });

  // ── Review result: rejected, within limit ───────────────────────────

  describe("review result rejected (within maxIterations)", () => {
    it("advances iteration, sets feedback, flips to work phase, resets workCursor", () => {
      const gl = gateLoopInReviewPhase();
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Need better error handling" },
      });

      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: false, exhausted: false });
      expect(gl.iteration).toBe(2);
      expect(gl.lastFeedback).toBe("Need better error handling");
      expect(gl.gatePhase).toBe("work");
      // Work cursor should be reset to pending.
      expect(gl.workCursor?.state).toBe("pending");
      expect(gl.workCursor?.lastText).toBeUndefined();
      expect(gl.workCursor?.sessionFile).toBeUndefined();
      // Review cursor is left as-is (it was the review that just ran).
      expect(gl.reviewCursor?.state).toBe("pending");
    });

    it("calls onAudit with gateloop_rejected (not exhausted)", () => {
      const gl = gateLoopInReviewPhase();
      const t = task();
      const onAudit = vi.fn();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Fix it" },
      });

      handleGateLoopResult(t, gl, result, { onAudit });

      expect(onAudit).toHaveBeenCalledWith("gateloop_rejected", {
        iteration: 2,
        feedback: "Fix it",
        exhausted: false,
        taskId: "t-1",
      });
    });

    it("uses opts.maxIterations when provided", () => {
      // With iteration=1 and maxIterations=2, iteration becomes 2 which is
      // NOT > 2, so within limit.
      const gl = gateLoopInReviewPhase();
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Almost there" },
      });

      const outcome = handleGateLoopResult(t, gl, result, { maxIterations: 2 });

      expect(outcome).toEqual({ approved: false, exhausted: false });
      expect(gl.iteration).toBe(2);
      expect(gl.gatePhase).toBe("work");
    });

    it("resets workCursor that is a container (sequential) correctly", () => {
      const gl = gateLoopInReviewPhase({
        workCursor: {
          kind: "sequential",
          path: "0.work",
          state: "done",
          lastText: "output",
          childIndex: 3,
          children: [
            { kind: "agent", path: "0.work.0", state: "done", lastText: "a" },
            { kind: "agent", path: "0.work.1", state: "done", lastText: "b" },
            { kind: "agent", path: "0.work.2", state: "done", lastText: "c" },
          ],
        },
      });
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Redo it" },
      });

      handleGateLoopResult(t, gl, result);

      expect(gl.workCursor?.state).toBe("pending");
      expect(gl.workCursor?.childIndex).toBe(0);
      expect(gl.workCursor?.lastText).toBeUndefined();
      expect(gl.workCursor?.sessionFile).toBeUndefined();
      // Children should also be reset.
      const children = (gl.workCursor as CursorNode).children;
      expect(children).toBeDefined();
      expect(children!.every((c: CursorNode) => c.state === "pending")).toBe(true);
      expect(children!.every((c: CursorNode) => c.lastText === undefined)).toBe(true);
    });

    it("uses gateLoopNode.maxIterations when opts.maxIterations not set", () => {
      const gl = gateLoopInReviewPhase({ maxIterations: 5 });
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Try again" },
      });

      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: false, exhausted: false });
      expect(gl.iteration).toBe(2);
      expect(gl.gatePhase).toBe("work");
    });
  });

  // ── Review result: rejected, exhausted ──────────────────────────────

  describe("review result rejected (exhausted)", () => {
    it("returns exhausted:true when iteration exceeds maxIterations (default 3)", () => {
      // Set the gateLoop at iteration 3, in review phase.
      // After rejection, iteration becomes 4 > 3 (default).
      const gl = gateLoopInReviewPhase({
        iteration: 3,
      });
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Still not good enough" },
      });

      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: false, exhausted: true });
      expect(gl.iteration).toBe(4);
      expect(gl.lastFeedback).toBe("Still not good enough");
      // gatePhase should stay "review" since we exhausted — no flip.
      expect(gl.gatePhase).toBe("review");
    });

    it("returns exhausted:true with explicit maxIterations=1", () => {
      // iteration=1, rejects → nextIteration=2 > maxIterations=1 → exhausted.
      const gl = gateLoopInReviewPhase();
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Nope" },
      });

      const outcome = handleGateLoopResult(t, gl, result, { maxIterations: 1 });

      expect(outcome).toEqual({ approved: false, exhausted: true });
      expect(gl.iteration).toBe(2);
    });

    it("returns exhausted:true with gateLoopNode.maxIterations=2 at iteration 2", () => {
      const gl = gateLoopInReviewPhase({
        iteration: 2,
        maxIterations: 2,
      });
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Failed twice" },
      });

      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: false, exhausted: true });
      expect(gl.iteration).toBe(3);
    });

    it("calls onAudit with gateloop_rejected exhausted:true", () => {
      const gl = gateLoopInReviewPhase({ iteration: 3 });
      const t = task();
      const onAudit = vi.fn();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Exhausted" },
      });

      handleGateLoopResult(t, gl, result, { onAudit });

      expect(onAudit).toHaveBeenCalledWith("gateloop_rejected", {
        iteration: 4,
        feedback: "Exhausted",
        exhausted: true,
        taskId: "t-1",
      });
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles iteration undefined as 1", () => {
      const gl = gateLoopInReviewPhase({ iteration: undefined });
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: true, feedback: "ok" },
      });

      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: true, exhausted: false });
    });

    it("handles review with fallback verdict (no structure, no valid JSON)", () => {
      const gl = gateLoopInReviewPhase();
      const t = task();
      const result = okResult("I reviewed the code and it needs work.");

      // No verdict present, lastText is not valid JSON → fallback to rejected.
      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: false, exhausted: false });
      expect(gl.lastFeedback).toBe("reviewer produced no valid verdict");
      expect(gl.iteration).toBe(2);
      expect(gl.gatePhase).toBe("work");
    });

    it("does not crash when workCursor is undefined on rejection reset", () => {
      const gl = gateLoopInReviewPhase({ workCursor: undefined });
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "No" },
      });

      const outcome = handleGateLoopResult(t, gl, result);

      expect(outcome).toEqual({ approved: false, exhausted: false });
      expect(gl.gatePhase).toBe("work");
    });

    it("defensive early-return: already-done gateLoop is a no-op", () => {
      const gl = gateLoopInReviewPhase({
        state: "done",
        gatePhase: "review",
      });
      const t = task();
      const result = okResult("should not be processed", {
        verdict: { approved: false, feedback: "Should be ignored" },
      });

      const outcome = handleGateLoopResult(t, gl, result);

      // Returns approved:true, exhausted:false (gateLoop already done).
      expect(outcome).toEqual({ approved: true, exhausted: false });
      // State should not have changed.
      expect(gl.state).toBe("done");
      expect(gl.iteration).toBe(1);
      expect(gl.lastFeedback).toBeUndefined();
      expect(gl.gatePhase).toBe("review");
    });

    it("defensive early-return: already-done gateLoop does not change workCursor", () => {
      const gl = gateLoopInReviewPhase({
        state: "done",
        gatePhase: "review",
        workCursor: {
          kind: "agent",
          path: "0.work",
          state: "done",
          lastText: "Original work",
          sessionFile: "/sessions/t-1/work-0.json",
        },
      });
      const t = task();
      const result = okResult("New work output");

      handleGateLoopResult(t, gl, result);

      // Work cursor should be untouched.
      expect(gl.workCursor?.lastText).toBe("Original work");
      expect(gl.workCursor?.state).toBe("done");
    });
  });
});

// ── resetCursorToPending coverage ─────────────────────────────────────────────
// These tests exercise the branch coverage of the private resetCursorToPending
// helper by passing work/review cursors of various container types.

describe("resetCursorToPending (via handleGateLoopResult)", () => {
  describe("work result flips to review and resets reviewCursor", () => {
    it("resets a gateLoop reviewCursor", () => {
      const nestedGate: CursorNode = {
        kind: "gateLoop",
        path: "0.review",
        state: "done",
        gatePhase: "review",
        iteration: 2,
        lastFeedback: "old",
        workSessionFile: "/sessions/old-work.json",
        workCursor: {
          kind: "agent",
          path: "0.review.work",
          state: "done",
          lastText: "work",
          sessionFile: "/sessions/w.json",
        },
        reviewCursor: {
          kind: "agent",
          path: "0.review.review",
          state: "done",
          lastText: "review",
          sessionFile: "/sessions/r.json",
        },
      };

      const gl = gateLoopNode({ reviewCursor: nestedGate });
      const t = task();
      const result = okResult("work output", {
        sessionFile: "/sessions/t-1/work-1.json",
      });

      handleGateLoopResult(t, gl, result);

      // reviewCursor should be reset to pending as a fresh gateLoop
      expect(gl.reviewCursor?.state).toBe("pending");
      expect(gl.reviewCursor?.gatePhase).toBe("work");
      expect(gl.reviewCursor?.iteration).toBe(1);
      expect(gl.reviewCursor?.lastFeedback).toBeUndefined();
      expect(gl.reviewCursor?.workSessionFile).toBeUndefined();
      // Sub-cursors should also be reset
      const rc = gl.reviewCursor as CursorNode;
      expect(rc.workCursor?.state).toBe("pending");
      expect(rc.workCursor?.lastText).toBeUndefined();
      expect(rc.workCursor?.sessionFile).toBeUndefined();
      expect(rc.reviewCursor?.state).toBe("pending");
      expect(rc.reviewCursor?.lastText).toBeUndefined();
      expect(rc.reviewCursor?.sessionFile).toBeUndefined();
    });

    it("resets a loop reviewCursor", () => {
      const loopCursor: CursorNode = {
        kind: "loop",
        path: "0.review",
        state: "done",
        loopIteration: 3,
        count: 3,
        prevIterationText: "prev",
        childCursor: {
          kind: "agent",
          path: "0.review.iter",
          state: "done",
          lastText: "last iteration",
          sessionFile: "/sessions/last.json",
        },
      };

      const gl = gateLoopNode({ reviewCursor: loopCursor });
      const t = task();
      const result = okResult("work output", {
        sessionFile: "/sessions/t-1/work-1.json",
      });

      handleGateLoopResult(t, gl, result);

      expect(gl.reviewCursor?.state).toBe("pending");
      expect((gl.reviewCursor as CursorNode).loopIteration).toBe(1);
      expect((gl.reviewCursor as CursorNode).prevIterationText).toBeUndefined();
      expect((gl.reviewCursor as CursorNode).childCursor?.state).toBe("pending");
    });

    it("resets a sequential reviewCursor with undefined children (none)", () => {
      const seqCursor: CursorNode = {
        kind: "sequential",
        path: "0.review",
        state: "done",
        childIndex: 2,
        lastText: "done",
        sessionFile: "/sessions/seq.json",
        // no children array → tests the `if (node.children)` else branch
      };

      const gl = gateLoopNode({ reviewCursor: seqCursor });
      const t = task();
      const result = okResult("work output", {
        sessionFile: "/sessions/t-1/work-1.json",
      });

      handleGateLoopResult(t, gl, result);

      expect(gl.reviewCursor?.state).toBe("pending");
      expect((gl.reviewCursor as CursorNode).childIndex).toBe(0);
      expect((gl.reviewCursor as CursorNode).lastText).toBeUndefined();
      expect((gl.reviewCursor as CursorNode).sessionFile).toBeUndefined();
    });

    it("resets a parallel reviewCursor with undefined children (none)", () => {
      const parCursor: CursorNode = {
        kind: "parallel",
        path: "0.review",
        state: "done",
        lastText: "parallel done",
        sessionFile: "/sessions/par.json",
        // no children array
      };

      const gl = gateLoopNode({ reviewCursor: parCursor });
      const t = task();
      const result = okResult("work output", {
        sessionFile: "/sessions/t-1/work-1.json",
      });

      handleGateLoopResult(t, gl, result);

      expect(gl.reviewCursor?.state).toBe("pending");
      expect((gl.reviewCursor as CursorNode).lastText).toBeUndefined();
      // sessionFile is deliberately NOT cleared on parallel nodes —
      // see shared resetCursorToPending in cursor.ts.
      expect((gl.reviewCursor as CursorNode).sessionFile).toBe("/sessions/par.json");
    });

    it("resets a parallel reviewCursor with children", () => {
      const parCursor: CursorNode = {
        kind: "parallel",
        path: "0.review",
        state: "done",
        lastText: "parallel done",
        sessionFile: "/sessions/par.json",
        children: [
          {
            kind: "agent",
            path: "0.review.0",
            state: "done",
            lastText: "child a",
            sessionFile: "/sessions/a.json",
          },
          {
            kind: "agent",
            path: "0.review.1",
            state: "done",
            lastText: "child b",
            sessionFile: "/sessions/b.json",
          },
        ],
      };

      const gl = gateLoopNode({ reviewCursor: parCursor });
      const t = task();
      const result = okResult("work output", {
        sessionFile: "/sessions/t-1/work-1.json",
      });

      handleGateLoopResult(t, gl, result);

      expect(gl.reviewCursor?.state).toBe("pending");
      expect((gl.reviewCursor as CursorNode).lastText).toBeUndefined();
      // sessionFile is deliberately NOT cleared on parallel nodes (see above).
      expect((gl.reviewCursor as CursorNode).sessionFile).toBe("/sessions/par.json");
      const rc = gl.reviewCursor as CursorNode;
      expect(rc.children).toHaveLength(2);
      expect(rc.children!.every((c: CursorNode) => c.state === "pending")).toBe(true);
      expect(rc.children!.every((c: CursorNode) => c.lastText === undefined)).toBe(true);
    });
  });

  describe("review rejection resets workCursor", () => {
    it("resets a gateLoop workCursor after rejection", () => {
      const nestedGate: CursorNode = {
        kind: "gateLoop",
        path: "0.work",
        state: "done",
        gatePhase: "work",
        iteration: 1,
        workCursor: {
          kind: "agent",
          path: "0.work.work",
          state: "done",
          lastText: "nested work",
          sessionFile: "/sessions/nw.json",
        },
        reviewCursor: {
          kind: "agent",
          path: "0.work.review",
          state: "done",
          lastText: "nested review",
          sessionFile: "/sessions/nr.json",
        },
      };

      const gl = gateLoopInReviewPhase({ workCursor: nestedGate });
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Do it again" },
      });

      handleGateLoopResult(t, gl, result);

      expect(gl.workCursor?.state).toBe("pending");
      expect((gl.workCursor as CursorNode).gatePhase).toBe("work");
      expect((gl.workCursor as CursorNode).iteration).toBe(1);
      expect((gl.workCursor as CursorNode).lastFeedback).toBeUndefined();
      expect((gl.workCursor as CursorNode).workSessionFile).toBeUndefined();
      // Sub-cursors reset
      const wc = gl.workCursor as CursorNode;
      expect(wc.workCursor?.state).toBe("pending");
      expect(wc.reviewCursor?.state).toBe("pending");
    });

    it("resets a loop workCursor after rejection", () => {
      const loopCursor: CursorNode = {
        kind: "loop",
        path: "0.work",
        state: "done",
        loopIteration: 5,
        count: 5,
        prevIterationText: "something",
        childCursor: {
          kind: "agent",
          path: "0.work.iter",
          state: "done",
          lastText: "final iter",
        },
      };

      const gl = gateLoopInReviewPhase({ workCursor: loopCursor });
      const t = task();
      const result = okResult("unused", {
        verdict: { approved: false, feedback: "Nope" },
      });

      handleGateLoopResult(t, gl, result);

      expect(gl.workCursor?.state).toBe("pending");
      expect((gl.workCursor as CursorNode).loopIteration).toBe(1);
      expect((gl.workCursor as CursorNode).prevIterationText).toBeUndefined();
      expect((gl.workCursor as CursorNode).childCursor?.state).toBe("pending");
    });
  });

  describe("gateLoop reviewCursor with undefined sub-cursors", () => {
    it("handles gateLoop reviewCursor with no workCursor", () => {
      const nestedGate: CursorNode = {
        kind: "gateLoop",
        path: "0.review",
        state: "done",
        gatePhase: "review",
        workCursor: undefined,
        reviewCursor: undefined,
      };

      const gl = gateLoopNode({ reviewCursor: nestedGate });
      const t = task();
      const result = okResult("work output", {
        sessionFile: "/sessions/t-1/work-1.json",
      });

      // Should not throw even though sub-cursors are undefined
      expect(() => handleGateLoopResult(t, gl, result)).not.toThrow();

      expect(gl.reviewCursor?.state).toBe("pending");
      expect(gl.reviewCursor?.gatePhase).toBe("work");
    });
  });
});

// ── buildReviewerReminder ─────────────────────────────────────────────────────

describe("buildReviewerReminder", () => {
  it("returns the expected reminder string", () => {
    const reminder = buildReviewerReminder();
    expect(reminder).toContain("gate_verdict tool");
    expect(reminder).toContain("git diff");
    expect(reminder).toContain("gate_verdict({approved, feedback})");
    expect(reminder).toContain("final action");
  });

  it("returns a non-empty string", () => {
    expect(buildReviewerReminder().length).toBeGreaterThan(50);
  });
});
