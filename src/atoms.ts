/**
 * Compose atoms engine — prompt assembly, cursor demands, and completion
 * propagation (§5.4, §5.5, §7.2).
 *
 * This module is the heart of the compose execution model:
 *
 *   1. {@link assemblePrompt}   — build the effective prompt for an agent from
 *                                 flow context and the constant task prompt.
 *   2. {@link nextWantedAgents} — walk a task's cursor and return
 *                                 {@link AgentDemand}s for every pending agent
 *                                 leaf that should start now.
 *   3. {@link advanceComposeCursor} — mark a completed agent node and propagate
 *                                 completion upward through the tree.
 *
 * The module stays self-contained: gateLoop verdict handling is injected via
 * the optional {@link AdvanceHandlers.handleGateLoop} callback rather than
 * imported directly, keeping atoms.ts decoupled from gateLoop-specific logic.
 *
 * References:
 *   §5.4  compose atom kinds
 *   §5.5  inter-atom result flow (ALL 4 rules)
 *   §7.2  nextWantedAgents — mapping compose cursor → agent demands
 *   §8    retry / cursor reset
 *   §12   cursor serialized to state.json
 */

import { getCursorByPath, resetCursorToPending } from "./cursor";
import { assertNever } from "./utils";
import type { AgentDemand, AgentRunResult, CursorNode, TaskRuntime } from "./types";

// ── Profile resolution seam (C3 fix) ─────────────────────────────────────────

/**
 * Synchronous lookup that resolves a profile name to its `provider`/`model`
 * fields, so they can be attached to {@link AgentDemand}s for concurrency-pool
 * accounting (D7's three AND-gated pools).
 *
 * When provided to {@link nextWantedAgents}, each pending agent demand will
 * have its `provider`/`model` populated from the resolved profile. When
 * omitted (or returns an empty object), the demand's `provider`/`model` remain
 * `undefined` and `tryAcquire` gates only on the `total` pool (legacy
 * behavior).
 *
 * The resolver is expected to be a thin wrapper around
 * `resolveProfile(name, cwd)` from `profiles.ts` — which is synchronous and
 * cached — but is injected as a seam to keep `atoms.ts` decoupled from disk I/O
 * and to simplify unit testing.
 */
export type ProfileResolver = (profileName: string) => { provider?: string; model?: string };

// ── Prompt assembly (§5.1, §5.5) ─────────────────────────────────────────────

/**
 * Assemble the effective prompt that an agent receives.
 *
 * Rule (§5.5): `<prior-result context>\n\n---\n\n<task.prompt>`
 * When there is no flow context, the agent receives only the task prompt.
 *
 * @param flowContext  the inter-atom result from the preceding atom(s), or
 *                     `undefined` for a root atom with no predecessor.
 * @param taskPrompt   the task's constant prompt (§5.1).
 * @returns the assembled prompt string.
 */
export function assemblePrompt(flowContext: string | undefined, taskPrompt: string): string {
  if (flowContext === undefined || flowContext === "") return taskPrompt;
  return `${flowContext}\n\n---\n\n${taskPrompt}`;
}

// ── nextWantedAgents (§7.2) ──────────────────────────────────────────────────

/**
 * Walk `task.cursor` and return one {@link AgentDemand} per **pending** agent
 * leaf that the scheduler should start right now.
 *
 * Dispatch follows the compose tree structure (§5.4):
 *   - `agent`      → one demand when `state === "pending"`
 *   - `sequential` → delegate to the single child at `childIndex`
 *   - `parallel`   → collect demands from ALL pending children
 *   - `gateLoop`   → delegate to `workCursor` or `reviewCursor` per `gatePhase`
 *   - `loop`       → delegate to `childCursor` (current iteration)
 *
 * Running/done/failed nodes produce no demands.
 *
 * @param task             the live task runtime (cursor tree is read, not mutated).
 * @param profileResolver  optional sync lookup that resolves each atom's
 *                          profile name to `{provider?, model?}` so they can
 *                          be attached to the returned demands for
 *                          concurrency-pool accounting (C3 fix, D7). When
 *                          omitted, demands carry no `provider`/`model`.
 * @returns demands for every agent session the scheduler should attempt to
 *          start right now. Empty array when nothing can start.
 */
export function nextWantedAgents(
  task: TaskRuntime,
  profileResolver?: ProfileResolver,
): AgentDemand[] {
  // No worktree → no agents can run (task hasn't started yet or worktree deleted)
  if (!task.worktreePath) return [];

  return demandsFor(task.cursor, undefined, task, profileResolver);
}

/**
 * Recursive helper that walks `node` and returns demands for pending agent
 * leaves. `incomingFlow` is the flow context that the parent node passes down
 * to its children (§5.5).
 *
 * Container nodes (sequential, parallel, gateLoop, loop) are transparent —
 * they delegate to their children regardless of their own state, except when
 * `state === "done"` (no more work is possible). Only `agent` leaves are
 * gated on `state === "pending"` to avoid re-spawning a running agent.
 */
function demandsFor(
  node: CursorNode,
  incomingFlow: string | undefined,
  task: TaskRuntime,
  profileResolver?: ProfileResolver,
): AgentDemand[] {
  // Agent leaves: only pending agents produce demands.
  if (node.kind === "agent") {
    if (node.state !== "pending") return [];
    const profileName = node.profile ?? task.profile ?? "";
    const demand: AgentDemand = {
      atomPath: node.path,
      // `""` is a sentinel meaning "no profile resolvable" — the scheduler
      // will fail at agent-start when it tries to load a profile by empty name.
      profileName,
      effectivePrompt: assemblePrompt(incomingFlow, task.prompt),
      // GateLoop work agent fallback: use the parent gateLoop's workSessionFile
      // when the work cursor itself has no sessionFile (e.g. after a rejection
      // cycle where the handler stores the prior session on the gateLoop node).
      // Detect parent gateLoop by checking if this agent's path ends with ".work".
      resumeSessionFile:
        node.sessionFile ??
        (node.path.endsWith(".work")
          ? getCursorByPath(task.cursor, node.path.slice(0, -5))?.workSessionFile
          : undefined),
      cwd: task.worktreePath ?? "",
      taskId: task.id,
      // provider/model are resolved from the profile when a profileResolver
      // is supplied (C3 fix). Without a resolver they remain undefined and
      // tryAcquire gates only on the `total` pool (legacy behavior).
    };
    if (profileResolver !== undefined) {
      const resolved = profileResolver(profileName);
      if (resolved.provider !== undefined) demand.provider = resolved.provider;
      if (resolved.model !== undefined) demand.model = resolved.model;
    }
    return [demand];
  }

  // Container nodes: delegate to children if not fully done.
  if (node.state === "done") return [];

  switch (node.kind) {
    case "sequential": {
      const children = node.children;
      if (children === undefined || children.length === 0) return [];

      const idx = node.childIndex;
      if (idx === undefined || idx >= children.length) return [];

      const child = children[idx];
      if (child === undefined) return [];

      // Sequential pipelining (§5.5): when childIndex > 0, the flow context
      // for the next child is the previous sibling's lastText.
      const flow = idx > 0 ? (children[idx - 1]?.lastText ?? incomingFlow) : incomingFlow;
      return demandsFor(child, flow, task, profileResolver);
    }

    case "parallel": {
      const children = node.children;
      if (children === undefined || children.length === 0) return [];

      const result: AgentDemand[] = [];
      for (const child of children) {
        // Each child gets the SAME incoming context (§5.5 parallel rule).
        result.push(...demandsFor(child, incomingFlow, task, profileResolver));
      }
      return result;
    }

    case "gateLoop": {
      if (node.gatePhase === "work") {
        // Work phase: pass incomingFlow (optionally prefixed with lastFeedback).
        let flow = incomingFlow;
        if (node.lastFeedback) {
          flow = `Previous review feedback:\n${node.lastFeedback}\n\n${incomingFlow ?? ""}`;
        }
        if (node.workCursor) return demandsFor(node.workCursor, flow, task, profileResolver);
        return [];
      }
      // Review phase: workCursor.lastText is the flow context (§5.5 gateLoop rule).
      if (node.reviewCursor) {
        const flow = node.workCursor?.lastText ?? "";
        return demandsFor(node.reviewCursor, flow, task, profileResolver);
      }
      return [];
    }

    case "loop": {
      const li = node.loopIteration ?? 1;
      const prevText = node.prevIterationText;
      // Iteration 1: pass the parent's incomingFlow.
      // Iteration > 1: pass prevIterationText (the last iteration's output) (§5.5, §17.2).
      const flow = li > 1 ? (prevText ?? "") : incomingFlow;
      if (node.childCursor) return demandsFor(node.childCursor, flow, task, profileResolver);
      return [];
    }

    default:
      assertNever(node as never);
  }
}

// ── advanceComposeCursor (§7.2) ──────────────────────────────────────────────

/** Optional handler callbacks injected into {@link advanceComposeCursor}. */
export interface AdvanceHandlers {
  /**
   * Called when a gateLoop review has completed and produced a
   * {@link AgentRunResult} containing a {@link GateVerdict}.
   *
   * The handler receives the parent `gateLoop` cursor node (already navigated
   * to) and the just-completed agent result. It is responsible for:
   *   - Parsing the verdict from `result.verdict`
   *   - Setting `node.state = "done"` on approval, or advancing iteration +
   *     resetting workCursor for another round on rejection.
   *
   * When no handler is provided (e.g. during unit testing of atoms that do not
   * involve gateLoops), gateLoop nodes are simply left as-is after their
   * agent completes — the caller's handler wiring is responsible for any
   * further processing.
   */
  handleGateLoop?: (node: CursorNode, result: AgentRunResult) => void;
}

/**
 * Mark a successfully completed agent and propagate completion upward.
 *
 * This is called by the scheduler when an agent finishes **successfully**
 * (the retry layer handles failures independently, §8). Steps:
 *
 *   1. Locate the cursor node at `atomPath` via {@link getCursorByPath}.
 *   2. For `agent` nodes: set `state = "done"`, `lastText`, `sessionFile`.
 *   3. For `gateLoop` nodes: delegate to the optional
 *      {@link AdvanceHandlers.handleGateLoop} callback.
 *   4. Walk the entire compose tree from the root via
 *      {@link recomputeCompletion} to propagate changes upward — updating
 *      sequential childIndexes, marking completed containers, etc.
 *   5. Return whether the whole task's compose tree is now complete.
 *
 * @param task     the task runtime (cursor is mutated in place).
 * @param atomPath the `path` of the cursor node that just finished.
 * @param result   the result from the completed agent run.
 * @param handlers optional callbacks for gateLoop handling.
 * @returns an object indicating whether the compose tree is fully complete
 *          and whether the task needs a merge.
 */
export function advanceComposeCursor(
  task: TaskRuntime,
  atomPath: string,
  result: AgentRunResult,
  handlers?: AdvanceHandlers,
): { composeComplete: boolean; needsMerge: boolean } {
  // 1. Locate the node.
  const node = getCursorByPath(task.cursor, atomPath);
  if (node === undefined) {
    throw new Error(
      `advanceComposeCursor: no cursor node found at path "${atomPath}" for task ${task.id}`,
    );
  }

  // 2. Mark success.
  switch (node.kind) {
    case "agent":
      node.state = "done";
      node.lastText = result.lastText;
      node.sessionFile = result.sessionFile;

      // If this agent is a gateLoop sub-cursor (work or review), notify the
      // parent gateLoop via the injected handler. The parent path is derived
      // by stripping the ".work" or ".review" suffix from the atomPath.
      if (handlers?.handleGateLoop) {
        const parentPath = gateLoopParentPath(atomPath);
        if (parentPath !== undefined) {
          const parent = getCursorByPath(task.cursor, parentPath);
          if (parent !== undefined && parent.kind === "gateLoop") {
            handlers.handleGateLoop(parent, result);
          }
        }
      }
      break;

    case "gateLoop":
      // Delegate to the injected handler (or no-op if absent).
      handlers?.handleGateLoop?.(node, result);
      break;

    default:
      // Container nodes (sequential, parallel, loop) are not agents themselves
      // and should never be directly advanced. If we reach this, the caller
      // passed an atomPath pointing at a container node, which is a logic error.
      throw new Error(
        `advanceComposeCursor: unexpected direct advance of ${node.kind} node at "${atomPath}" — only agent and gateLoop nodes can finish directly`,
      );
  }

  // 3. Propagate completion upward via a top-down recompute pass.
  recomputeCompletion(task.cursor);

  // 4. Determine overall task completion.
  const composeComplete = task.cursor.state === "done";
  return { composeComplete, needsMerge: composeComplete };
}

// ── recomputeCompletion (§7.2, §5.5) ─────────────────────────────────────────

/**
 * Top-down propagation pass that walks the entire compose tree from `node`
 * and re-evaluates every composite node's completion state based on its
 * children's current states.
 *
 * This replaces the "parent pointer" pattern: instead of navigating upward
 * from a leaf, we walk the full tree after every agent completion and let
 * each composite node recompute itself. The pass is idempotent — calling it
 * on an already-stable tree is a no-op.
 *
 * Rules applied per kind (§5.5 result flow):
 *   - **sequential**: advance `childIndex` past any completed children; when
 *     `childIndex >= children.length`, mark node done. `lastText` = last
 *     child's `lastText`.
 *   - **parallel**: when all children are done, mark node done. `lastText` =
 *     headed concatenation (`<title>\n<text>\n\n` per child).
 *   - **gateLoop**: recurse into sub-cursors; completion is managed by the
 *     injected `handleGateLoop` handler (this pass only updates sub-cursor
 *     states, not the gateLoop node itself).
 *   - **loop**: when `childCursor` is done, advance `loopIteration`. If
 *     `loopIteration > count`, mark node done. Otherwise reset
 *     `childCursor.state` to `"pending"` and store the previous iteration's
 *     `lastText` as `prevIterationText`.
 */
function recomputeCompletion(node: CursorNode): void {
  if (node.state === "done") return;

  switch (node.kind) {
    case "agent":
      // Leaf node — nothing to recompute.
      return;

    case "sequential": {
      const children = node.children;
      if (children === undefined || children.length === 0) {
        node.state = "done";
        return;
      }

      // First, recurse into all children so their internal state is current.
      for (const child of children) {
        recomputeCompletion(child);
      }

      // Advance past completed children in order.
      let idx = node.childIndex ?? 0;
      while (idx < children.length) {
        const child = children[idx];
        if (child && child.state === "done") {
          idx++;
        } else {
          break;
        }
      }
      node.childIndex = idx;

      // If all children are done, the sequential itself is done.
      if (idx >= children.length) {
        node.state = "done";
        const lastChild = children[children.length - 1];
        if (lastChild) node.lastText = lastChild.lastText;
      }
      break;
    }

    case "parallel": {
      const children = node.children;
      if (children === undefined || children.length === 0) {
        node.state = "done";
        return;
      }

      for (const child of children) {
        recomputeCompletion(child);
      }

      if (children.every((c) => c.state === "done")) {
        node.state = "done";
        // Headed concatenation: each child's output prefixed with its label.
        node.lastText = children
          .map((c, i) => {
            const header = c.title ?? c.profile ?? `atom-${i}`;
            return `${header}\n${c.lastText ?? ""}`;
          })
          .join("\n\n");
      }
      break;
    }

    case "gateLoop": {
      // Recurse into sub-cursors so their states are up to date.
      if (node.workCursor) recomputeCompletion(node.workCursor);
      if (node.reviewCursor) recomputeCompletion(node.reviewCursor);
      // Completion of the gateLoop node itself is handled by the
      // handleGateLoop callback injected into advanceComposeCursor.
      break;
    }

    case "loop": {
      if (!node.childCursor) {
        node.state = "done";
        return;
      }

      recomputeCompletion(node.childCursor);

      if (node.childCursor.state === "done") {
        const prevText = node.childCursor.lastText;
        const li = node.loopIteration ?? 1;
        const ct = node.count ?? 1;
        const nextIteration = li + 1;

        if (nextIteration > ct) {
          // All iterations complete.
          node.state = "done";
          node.lastText = prevText;
          node.loopIteration = nextIteration;
        } else {
          // Advance to next iteration: store context and reset childCursor.
          node.prevIterationText = prevText;
          node.loopIteration = nextIteration;
          resetCursorToPending(node.childCursor);
        }
      }
      break;
    }

    default:
      assertNever(node as never);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * If `atomPath` ends with `.work` or `.review`, return the parent path (the
 * gateLoop node that owns the sub-cursor). Otherwise return undefined.
 *
 * This is used by {@link advanceComposeCursor} to detect when a gateLoop's
 * work or review agent has completed and notify the handler.
 */
export function gateLoopParentPath(atomPath: string): string | undefined {
  const dotIdx = atomPath.lastIndexOf(".");
  if (dotIdx === -1) return undefined;
  const suffix = atomPath.slice(dotIdx + 1);
  if (suffix === "work" || suffix === "review") {
    return atomPath.slice(0, dotIdx);
  }
  return undefined;
}
