/**
 * Compose execution cursor — build, serialize, and walk (§7.2, §5.4, §12).
 *
 * The cursor is a per-task execution-state tree that mirrors a task's
 * {@link ComposeAtom} tree. Where wisp flattens work into a DAG, pi-subagent-tasks
 * walks a TREE: one {@link CursorNode} per atom node, with recursive
 * sub-cursors modeling container atoms (`sequential`/`parallel` get `children`;
 * `gateLoop` gets `workCursor`/`reviewCursor`; `loop` gets `childCursor`).
 *
 * Mutable fields (`state`, `lastText`, `sessionFile`, `iteration`,
 * `gatePhase`, …) are populated by the scheduler as it advances; the cursor is
 * the single source of truth for "where is this task in its compose tree".
 *
 * This module is PURE: no I/O, no globals. The full cursor round-trips through
 * `serializeCursor` → `state.json` → `deserializeCursor` (§12) losslessly.
 *
 *   §5.4  compose atom kinds
 *   §7.2  cursor / nextWantedAgents
 *   §12   cursor serialized to state.json
 */

import { assertNever } from "./utils";
import type { ComposeAtom, CursorNode } from "./types";

// ── Build (§7.2) ─────────────────────────────────────────────────────────────

/**
 * Materialize the execution-state tree for a compose atom (§7.2).
 *
 * Every node starts `state: "pending"`; static fields are copied from the
 * originating atom (`kind`, `profile`, `title`, `maxIterations`, `count`) and
 * each node's `path` is the dotted position within the tree (e.g. `"0.1.0"`).
 *
 * A bare task with no `compose` is equivalent to a single `{ type: "agent" }`
 * (§5.1) — hence `compose === undefined` builds a plain agent leaf.
 *
 * @param compose      the compose atom tree (undefined → single agent leaf)
 * @param pathPrefix   dotted path assigned to this node (caller-supplied root,
 *                     e.g. the task's cursor root path)
 * @returns the fresh {@link CursorNode} tree mirroring `compose`.
 */
export function buildCursor(compose: ComposeAtom | undefined, pathPrefix: string): CursorNode {
  if (compose === undefined) {
    return buildCursor({ type: "agent" }, pathPrefix);
  }

  switch (compose.type) {
    case "agent": {
      const node: Record<string, unknown> = {
        kind: "agent",
        path: pathPrefix,
        state: "pending",
      };
      if (compose.profile !== undefined) node.profile = compose.profile;
      if (compose.title !== undefined) node.title = compose.title;
      return node as unknown as CursorNode;
    }

    case "sequential":
      return {
        kind: "sequential",
        path: pathPrefix,
        state: "pending",
        childIndex: 0,
        children: compose.atoms.map((a, i) => buildCursor(a, `${pathPrefix}.${i}`)),
      };

    case "parallel":
      return {
        kind: "parallel",
        path: pathPrefix,
        state: "pending",
        children: compose.atoms.map((a, i) => buildCursor(a, `${pathPrefix}.${i}`)),
      };

    case "gateLoop": {
      const node: Record<string, unknown> = {
        kind: "gateLoop",
        path: pathPrefix,
        state: "pending",
        iteration: 1,
        gatePhase: "work",
        workCursor: buildCursor(compose.work, `${pathPrefix}.work`),
        reviewCursor: buildCursor(compose.review, `${pathPrefix}.review`),
      };
      if (compose.maxIterations !== undefined) node.maxIterations = compose.maxIterations;
      return node as unknown as CursorNode;
    }

    case "loop":
      if (compose.count > 100) {
        throw new Error("Loop count must be <= 100; got: " + String(compose.count));
      }
      return {
        kind: "loop",
        path: pathPrefix,
        state: "pending",
        loopIteration: 1,
        count: compose.count,
        childCursor: buildCursor(compose.atom, `${pathPrefix}.iter`),
      };

    default:
      assertNever(compose);
  }
}

// ── Serialize / deserialize (§12) ────────────────────────────────────────────

/**
 * Recursively produce a fresh, JSON-safe plain object mirroring `node`.
 *
 * Every field is copied — including the nested `children`, `workCursor`,
 * `reviewCursor`, and `childCursor` sub-cursors (recursed), and any mutable
 * runtime state (`lastText`, `sessionFile`, `iteration`, `gatePhase`, …). The
 * result shares no references with `node`, so it is safe to hand to
 * `JSON.stringify` for `state.json` (§12). Round-trips losslessly through
 * {@link deserializeCursor}.
 *
 * @returns a defensive deep copy as a plain object.
 */
export function serializeCursor(node: CursorNode): object {
  return deepCopyCursor(node);
}

/**
 * Reconstruct a full {@link CursorNode} tree from a serialized plain object
 * (the inverse of {@link serializeCursor}).
 *
 * Sub-cursors (`children`, `workCursor`, `reviewCursor`, `childCursor`) are
 * recursed so the entire tree — with all fields — is rebuilt. The result is a
 * fresh tree (no shared references) and round-trips losslessly:
 * `deserializeCursor(serializeCursor(n))` is structurally equal to `n`.
 *
 * @param obj a serialized cursor (e.g. parsed from `state.json`, §12).
 * @throws {Error} if `obj` lacks valid string `kind`, string `path`, or a
 *   valid `state` field.
 */
export function deserializeCursor(obj: object): CursorNode {
  const VALID_STATES = ["pending", "running", "done", "failed"] as const;
  const dict = obj as Record<string, unknown>;

  if (typeof dict.kind !== "string") {
    throw new Error(
      `deserializeCursor: missing or non-string 'kind' field (got ${typeof dict.kind})`,
    );
  }

  if (typeof dict.path !== "string") {
    throw new Error(
      `deserializeCursor: missing or non-string 'path' field (got ${typeof dict.path})`,
    );
  }

  if (!VALID_STATES.includes(dict.state as (typeof VALID_STATES)[number])) {
    throw new Error(
      `deserializeCursor: invalid or missing 'state' field — got ${JSON.stringify(dict.state)}, expected one of ${VALID_STATES.join(", ")}`,
    );
  }

  return deepCopyCursor(obj as CursorNode);
}

/**
 * Structural deep copy of a {@link CursorNode}, recursing into every sub-cursor
 * field so the result is an independent tree preserving all fields. Shared by
 * {@link serializeCursor} and {@link deserializeCursor}.
 *
 * Uses structural iteration over `Object.entries(node)` instead of a
 * hardcoded field list — any future fields added to {@link CursorNode} are
 * copied automatically, making this lossless and self-maintaining.
 */
function deepCopyCursor(node: CursorNode): CursorNode {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      result[key] = value.map(deepCopyCursor);
    } else if (value !== null && typeof value === "object") {
      result[key] = deepCopyCursor(value as CursorNode);
    } else {
      result[key] = value;
    }
  }

  return result as unknown as CursorNode;
}

// ── Completion (§7.2) ────────────────────────────────────────────────────────

/**
 * Recursively decide whether a compose tree has fully executed (§7.2).
 *
 * A node is complete when its `state === "done"` OR all of its sub-cursors are
 * complete. Concretely:
 *   - `agent`      — complete only once `state === "done"` (no sub-cursors);
 *   - `sequential` / `parallel` — complete when every child has completed;
 *   - `gateLoop`   — complete when both the `workCursor` and `reviewCursor`
 *                    sub-cursors have completed (the scheduler flips the node
 *                    to `"done"` on final approval, which short-circuits here);
 *   - `loop`       — complete once the configured iteration count is exhausted
 *                    (`loopIteration > count`). The childCursor is not checked
 *                    here because the scheduler sets `state = "done"` on the
 *                    loop node when all iterations have finished; the
 *                    childCursor may still be in a terminal "done" state from
 *                    the last iteration.
 *
 * A node missing the sub-cursors its kind requires (malformed/degenerate input)
 * is treated as incomplete rather than vacuously complete.
 *
 * @returns `true` iff every leaf agent in the subtree has reached `state === "done"`.
 */
export function isComposeComplete(node: CursorNode): boolean {
  if (node.state === "done") return true;

  switch (node.kind) {
    case "agent":
      // Leaf: no sub-cursors — complete only via the `state === "done"` path above.
      return false;

    case "sequential":
    case "parallel": {
      const children = node.children;
      if (children === undefined) return false;
      return children.every(isComposeComplete);
    }

    case "gateLoop": {
      const work = node.workCursor;
      const review = node.reviewCursor;
      if (work === undefined || review === undefined) return false;
      return isComposeComplete(work) && isComposeComplete(review);
    }

    case "loop": {
      const li = node.loopIteration;
      const ct = node.count;
      if (li === undefined || ct === undefined) return false;
      return li > ct;
    }

    default:
      assertNever(node as never);
  }
  return false;
}

// ── Navigation ───────────────────────────────────────────────────────────────

/**
 * Locate the cursor node at `path` within the tree rooted at `node`.
 *
 * Paths are the dotted positions assigned by {@link buildCursor} (e.g.
 * `"0.1.work"` — the work sub-cursor of a `gateLoop` at `0.1`). The search
 * recurses through `children`, `workCursor`, `reviewCursor`, and `childCursor`
 * so any node — leaf or container — is reachable.
 *
 * @returns the matching {@link CursorNode}, or `undefined` when no node carries
 *          `path` (including when `path` is the root's own path, which matches).
 */
export function getCursorByPath(node: CursorNode, path: string): CursorNode | undefined {
  if (node.path === path) return node;

  if (node.children) {
    for (const child of node.children) {
      const found = getCursorByPath(child, path);
      if (found !== undefined) return found;
    }
  }

  for (const sub of [node.workCursor, node.reviewCursor, node.childCursor]) {
    if (sub !== undefined) {
      const found = getCursorByPath(sub, path);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

// ── Mutation helpers ────────────────────────────────────────────────────────────

/**
 * Recursively reset mutable runtime fields in a cursor subtree back to their
 * initial (pre-run) values, matching the fresh-build state per kind.
 *
 * Used by atoms.ts (loop iteration reset) and gateloop.ts (gateLoop rejection
 * resetting workCursor / work result resetting reviewCursor).
 *
 * Each kind resets only its own tracked fields (matching what {@link buildCursor}
 * sets as initial defaults). Shared mutable fields (`lastText`, `sessionFile`,
 * `executionCount`) are cleared only where each kind initially tracks them.
 * Structural metadata (path, kind, profile, title, count, maxIterations, etc.)
 * is preserved.
 *
 * NOTE: parallel nodes deliberately do NOT clear `sessionFile` — matching
 * atoms.ts semantics where the parallel's sessionFile aggregates the headed
 * concatenation and should persist across resets.
 */
export function resetCursorToPending(node: CursorNode): void {
  switch (node.kind) {
    case "agent":
      node.state = "pending";
      node.lastText = undefined;
      node.sessionFile = undefined;
      node.executionCount = undefined;
      return;

    case "sequential":
      node.state = "pending";
      node.childIndex = 0;
      node.lastText = undefined;
      node.sessionFile = undefined;
      if (node.children) {
        for (const child of node.children) {
          resetCursorToPending(child);
        }
      }
      return;

    case "parallel":
      node.state = "pending";
      node.lastText = undefined;
      // sessionFile deliberately NOT cleared — see NOTE above.
      if (node.children) {
        for (const child of node.children) {
          resetCursorToPending(child);
        }
      }
      return;

    case "gateLoop":
      node.state = "pending";
      node.gatePhase = "work";
      node.iteration = 1;
      node.lastFeedback = undefined;
      node.workSessionFile = undefined;
      if (node.workCursor) resetCursorToPending(node.workCursor);
      if (node.reviewCursor) resetCursorToPending(node.reviewCursor);
      return;

    case "loop":
      node.state = "pending";
      node.loopIteration = 1;
      node.prevIterationText = undefined;
      if (node.childCursor) resetCursorToPending(node.childCursor);
      return;

    default:
      assertNever(node as never);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
