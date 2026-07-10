/**
 * gateLoop verdict handling logic for pi-subagent-tasks (§9, D8).
 *
 * This module is the standalone gateLoop advance handler. It is NOT imported
 * by {@link atoms.ts} directly — instead, it is wired in via the injected
 * {@link AdvanceHandlers.handleGateLoop} callback (integration task kb-12).
 *
 * Responsibilities:
 *   - {@link extractVerdict} — parse a {@link GateVerdict} from an agent result
 *     (either structured `result.verdict` or JSON in `result.lastText`).
 *   - {@link needsReminderRetry} — detect whether a reviewer produced text
 *     without a valid verdict, so the scheduler can re-invoke with a reminder.
 *   - {@link handleGateLoopResult} — the core gateLoop advance logic: interpret
 *     agent results as work or review and transition the gateLoop cursor.
 *   - {@link buildReviewerReminder} — produce the reminder prompt snippet.
 *
 * References:
 *   §5.4  ComposeAtom.gateLoop definition
 *   §5.5  inter-atom result flow (gateLoop rule)
 *   §9    gateLoop 5-step lifecycle
 *   D8    default iteration cap = 3
 */

import { resetCursorToPending } from "./cursor";
import type { AgentRunResult, CursorNode, GateVerdict, TaskRuntime } from "./types";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Fallback verdict returned when a reviewer produced no valid verdict.
 * This is the immutable sentinel used across extractVerdict and handleGateLoopResult.
 */
export const NO_VERDICT: GateVerdict = {
  approved: false,
  feedback: "reviewer produced no valid verdict",
};

// ── Verdict helpers ───────────────────────────────────────────────────────────

/**
 * Attempt to parse a {@link GateVerdict} from a JSON string.
 *
 * Returns the parsed verdict if the JSON has valid `approved` (boolean) and
 * `feedback` (string) fields; returns `undefined` on any failure (empty string,
 * malformed JSON, missing or wrong-typed fields).
 *
 * This helper is shared by {@link extractVerdict} (fallback path) and
 * {@link needsReminderRetry} (detection path) to avoid duplicating the
 * parse-and-validate logic.
 */
export function tryParseVerdictJson(text: string): GateVerdict | undefined {
  if (text === "") return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.approved === "boolean" && typeof parsed.feedback === "string") {
      return { approved: parsed.approved, feedback: parsed.feedback };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ── Verdict extraction ───────────────────────────────────────────────────────

/**
 * Extract a structured {@link GateVerdict} from an agent run result.
 *
 * The reviewer is expected to call the `gate_verdict` tool as its final action,
 * which stores the parsed verdict in `result.verdict`. When the tool was not
 * called (e.g. the reviewer only produced text), this function falls back to
 * attempting a JSON parse of `result.lastText`.
 *
 * **Only the structured `gate_verdict` tool path stores to `result.verdict`**.
 * The text-only fallback handles reviewers that output raw JSON instead of
 * calling the tool, or that produce no structured verdict at all.
 *
 * @param result  the completed agent run result.
 * @returns the parsed {@link GateVerdict}. On any parse/validation failure,
 *          returns `{ approved: false, feedback: "reviewer produced no valid verdict" }`.
 */
export function extractVerdict(result: AgentRunResult): GateVerdict {
  // Fast path: structured verdict from the gate_verdict tool.
  if (result.verdict != null) {
    // Validate the structured verdict — null/malformed data from the tool
    // seam should not propagate unchecked.
    if (
      typeof result.verdict.approved === "boolean" &&
      typeof result.verdict.feedback === "string"
    ) {
      return result.verdict;
    }
    return NO_VERDICT;
  }

  // Fallback: attempt to parse lastText as JSON.
  return tryParseVerdictJson(result.lastText) ?? NO_VERDICT;
}

// ── Reminder retry detection ─────────────────────────────────────────────────

/**
 * Determine whether a reviewer result needs a reminder retry.
 *
 * Returns `true` when the reviewer produced text-only output (no structured
 * `result.verdict`) AND `result.lastText` is NOT valid JSON matching the
 * verdict schema `{approved: boolean, feedback: string}`. In this case the
 * scheduler should re-invoke the reviewer **once** with the reminder prompt
 * from {@link buildReviewerReminder}.
 *
 * @returns `true` if the result warrants a single reminder retry.
 */
export function needsReminderRetry(result: AgentRunResult): boolean {
  // If a structured verdict is present, no reminder needed.
  if (result.verdict !== undefined) return false;

  // No structured verdict and lastText is not a valid verdict JSON.
  return tryParseVerdictJson(result.lastText) === undefined;
}

// ── GateLoop advance logic (§9) ─────────────────────────────────────────────

/** Options for {@link handleGateLoopResult}. */
export interface HandleGateLoopOptions {
  /**
   * Override the gateLoop's iteration cap. Falls back to
   * `gateLoopNode.maxIterations` (set from the compose atom), then to the
   * extension default of 3 (D8).
   */
  maxIterations?: number;

  /**
   * Optional audit callback for gateLoop lifecycle events. Called with an event
   * type string and a payload. Event types:
   *   - `"gateloop_approved"` — review approved the work
   *   - `"gateloop_rejected"` — review rejected the work (may or may not exhaust)
   */
  onAudit?: (type: string, payload: Record<string, unknown>) => void;
}

/**
 * Process an agent result within a gateLoop cursor node.
 *
 * This is the core gateLoop state machine. It distinguishes work vs. review
 * results by inspecting `gateLoopNode.gatePhase` **before** the result is
 * applied — the phase tells us which agent just completed.
 *
 * ### Work result (gatePhase === "work")
 * The work agent has finished. Marks the work cursor as done, stores the
 * session file reference, and transitions to the review phase.
 *
 * ### Review result (gatePhase === "review")
 * The review agent has finished. Extracts the verdict:
 *   - **Approved** → marks the gateLoop node itself as done; the task's
 *     compose tree is complete.
 *   - **Rejected** → advances the iteration counter. If the cap is exceeded,
 *     returns `exhausted: true` (the task moves to failed). Otherwise resets
 *     the work cursor to `pending` and flips back to the work phase, allowing
 *     the work agent to re-run with the accumulated feedback.
 *
 * @param task           the owning task (used only for its `id` — structured
 *                       for audit convenience).
 * @param gateLoopNode   the gateLoop cursor node to mutate.
 * @param result         the just-completed agent run result.
 * @param opts           optional configuration (iteration cap override, audit).
 * @returns an object describing the outcome: whether the gateLoop approved the
 *          work and whether iterations have been exhausted.
 */
export function handleGateLoopResult(
  task: TaskRuntime,
  gateLoopNode: CursorNode,
  result: AgentRunResult,
  opts?: HandleGateLoopOptions,
): { approved: boolean; exhausted: boolean } {
  // Defensive: if the gateLoop is already done, no-op (re-entry guard).
  if (gateLoopNode.state === "done") {
    return { approved: true, exhausted: false };
  }

  // Snapshot the phase BEFORE applying the result — the phase tells us which
  // agent (work or review) just completed.
  const wasWorkPhase = gateLoopNode.gatePhase === "work";

  if (wasWorkPhase) {
    // ── Work result ──────────────────────────────────────────────────────
    // The work agent has completed. Mark the work cursor as done and store
    // the session file for potential resume on the next iteration.
    const workCursor = gateLoopNode.workCursor;
    if (workCursor) {
      workCursor.state = "done";
      workCursor.lastText = result.lastText;
      workCursor.sessionFile = result.sessionFile;
    }

    gateLoopNode.workSessionFile = result.sessionFile;

    // Transition to review phase.
    gateLoopNode.gatePhase = "review";

    // Reset the review cursor to a fresh pending state for this iteration.
    if (gateLoopNode.reviewCursor) {
      resetCursorToPending(gateLoopNode.reviewCursor);
    }

    return { approved: false, exhausted: false };
  }

  // ── Review result ──────────────────────────────────────────────────────────
  const verdict = extractVerdict(result);

  // Track the current iteration for audit.
  const iteration = gateLoopNode.iteration ?? 1;

  if (verdict.approved) {
    // Reviewer approved the work → gateLoop is done.
    gateLoopNode.state = "done";
    gateLoopNode.lastText = gateLoopNode.workCursor?.lastText ?? "";

    opts?.onAudit?.("gateloop_approved", {
      iteration,
      feedback: verdict.feedback,
      taskId: task.id,
    });

    return { approved: true, exhausted: false };
  }

  // Reviewer rejected the work → advance iteration.
  gateLoopNode.lastFeedback = verdict.feedback;
  const nextIteration = iteration + 1;
  gateLoopNode.iteration = nextIteration;

  const maxIterations = opts?.maxIterations ?? gateLoopNode.maxIterations ?? 3;

  if (nextIteration > maxIterations) {
    // Exhausted all iterations — gateLoop stays in a non-done state (the
    // scheduler interprets `exhausted: true` as a terminal failure for the
    // task).
    opts?.onAudit?.("gateloop_rejected", {
      iteration: nextIteration,
      feedback: verdict.feedback,
      exhausted: true,
      taskId: task.id,
    });

    return { approved: false, exhausted: true };
  }

  // Another round: reset work cursor to pending so it re-runs.
  gateLoopNode.gatePhase = "work";
  if (gateLoopNode.workCursor) {
    resetCursorToPending(gateLoopNode.workCursor);
  }

  opts?.onAudit?.("gateloop_rejected", {
    iteration: nextIteration,
    feedback: verdict.feedback,
    exhausted: false,
    taskId: task.id,
  });

  return { approved: false, exhausted: false };
}

// ── Reminder prompt ──────────────────────────────────────────────────────────

/**
 * Build the reminder prompt snippet for a reviewer that didn't call the
 * `gate_verdict` tool.
 *
 * The scheduler uses this when {@link needsReminderRetry} returns `true`: it
 * re-invokes the reviewer agent **once** with this reminder appended to the
 * prompt.
 *
 * @returns the reminder instruction string.
 */
export function buildReviewerReminder(): string {
  return (
    "You did not call the gate_verdict tool. Inspect the work in this worktree " +
    "(git diff, read files) and then call gate_verdict({approved, feedback}) " +
    "as your final action."
  );
}
