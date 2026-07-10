import { describe, it, expect } from "vitest";

import {
  buildCursor,
  serializeCursor,
  deserializeCursor,
  isComposeComplete,
  getCursorByPath,
} from "../cursor";
import type { ComposeAtom, CursorNode } from "../types";

/** Non-null index access helper (noUncheckedIndexedAccess: arrays are T|undefined). */
function child(node: CursorNode, i: number): CursorNode {
  const c = node.children;
  if (c === undefined) throw new Error("node has no children");
  return c[i]!;
}

// ── buildCursor ──────────────────────────────────────────────────────────────

describe("buildCursor", () => {
  it("builds a single agent leaf when compose is undefined", () => {
    const node = buildCursor(undefined, "0");
    expect(node).toEqual({
      kind: "agent",
      path: "0",
      state: "pending",
      profile: undefined,
      title: undefined,
    });
  });

  it("builds an explicit agent leaf, copying static profile/title", () => {
    const node = buildCursor({ type: "agent", profile: "reviewer", title: "lint" }, "1");
    expect(node).toEqual({
      kind: "agent",
      path: "1",
      state: "pending",
      profile: "reviewer",
      title: "lint",
    });
  });

  it("builds an agent leaf with no static fields", () => {
    const node = buildCursor({ type: "agent" }, "2");
    expect(node.kind).toBe("agent");
    expect(node.path).toBe("2");
    expect(node.state).toBe("pending");
    expect(node.profile).toBeUndefined();
    expect(node.title).toBeUndefined();
  });

  it("builds a sequential node with ordered children + childIndex 0", () => {
    const atom: ComposeAtom = {
      type: "sequential",
      atoms: [
        { type: "agent", title: "a" },
        { type: "agent", title: "b" },
        { type: "agent", title: "c" },
      ],
    };
    const node = buildCursor(atom, "0");
    expect(node.kind).toBe("sequential");
    expect(node.path).toBe("0");
    expect(node.state).toBe("pending");
    expect(node.childIndex).toBe(0);
    expect(node.children).toHaveLength(3);
    expect(node.children!.map((c) => c.path)).toEqual(["0.0", "0.1", "0.2"]);
    expect(node.children!.map((c) => c.title)).toEqual(["a", "b", "c"]);
    node.children!.forEach((c) => {
      expect(c.state).toBe("pending");
    });
  });

  it("builds a parallel node with ordered children (no childIndex)", () => {
    const atom: ComposeAtom = {
      type: "parallel",
      atoms: [
        { type: "agent", profile: "p1" },
        { type: "agent", profile: "p2" },
        { type: "agent", profile: "p3" },
      ],
    };
    const node = buildCursor(atom, "3");
    expect(node.kind).toBe("parallel");
    expect(node.path).toBe("3");
    expect(node.state).toBe("pending");
    expect(node.childIndex).toBeUndefined();
    expect(node.children).toHaveLength(3);
    expect(node.children!.map((c) => c.path)).toEqual(["3.0", "3.1", "3.2"]);
    expect(node.children!.map((c) => c.profile)).toEqual(["p1", "p2", "p3"]);
  });

  it("builds a gateLoop node with work/review sub-cursors + initial iteration/phase", () => {
    const atom: ComposeAtom = {
      type: "gateLoop",
      work: { type: "agent", title: "implementer" },
      review: { type: "agent", profile: "reviewer", title: "reviewer" },
      maxIterations: 4,
    };
    const node = buildCursor(atom, "0.1");
    expect(node.kind).toBe("gateLoop");
    expect(node.path).toBe("0.1");
    expect(node.state).toBe("pending");
    expect(node.iteration).toBe(1);
    expect(node.gatePhase).toBe("work");
    expect(node.maxIterations).toBe(4);

    expect(node.workCursor).toBeDefined();
    expect(node.workCursor!.kind).toBe("agent");
    expect(node.workCursor!.path).toBe("0.1.work");
    expect(node.workCursor!.title).toBe("implementer");

    expect(node.reviewCursor).toBeDefined();
    expect(node.reviewCursor!.kind).toBe("agent");
    expect(node.reviewCursor!.path).toBe("0.1.review");
    expect(node.reviewCursor!.profile).toBe("reviewer");
    expect(node.reviewCursor!.title).toBe("reviewer");
  });

  it("builds a gateLoop with undefined maxIterations when omitted", () => {
    const atom: ComposeAtom = {
      type: "gateLoop",
      work: { type: "agent" },
      review: { type: "agent" },
    };
    const node = buildCursor(atom, "g");
    expect(node.maxIterations).toBeUndefined();
  });

  it("builds a loop node with child cursor + loopIteration 1 + count", () => {
    const atom: ComposeAtom = {
      type: "loop",
      atom: { type: "agent", title: "step" },
      count: 5,
    };
    const node = buildCursor(atom, "L");
    expect(node.kind).toBe("loop");
    expect(node.path).toBe("L");
    expect(node.state).toBe("pending");
    expect(node.loopIteration).toBe(1);
    expect(node.count).toBe(5);

    expect(node.childCursor).toBeDefined();
    expect(node.childCursor!.kind).toBe("agent");
    expect(node.childCursor!.path).toBe("L.iter");
    expect(node.childCursor!.title).toBe("step");
  });

  it("throws when loop count exceeds 100", () => {
    const atom: ComposeAtom = {
      type: "loop",
      atom: { type: "agent" },
      count: 101,
    };
    expect(() => buildCursor(atom, "L")).toThrow(/Loop count must be <= 100/);
  });

  it("builds a deeply nested tree with correct dotted paths", () => {
    const atom: ComposeAtom = {
      type: "sequential",
      atoms: [
        { type: "agent" },
        {
          type: "gateLoop",
          work: {
            type: "parallel",
            atoms: [{ type: "agent" }, { type: "agent" }],
          },
          review: { type: "agent" },
        },
      ],
    };
    const node = buildCursor(atom, "root");
    expect(node.children!.map((c) => c.path)).toEqual(["root.0", "root.1"]);
    const gate = child(node, 1);
    expect(gate.path).toBe("root.1");
    expect(gate.kind).toBe("gateLoop");
    expect(gate.workCursor!.path).toBe("root.1.work");
    expect(gate.workCursor!.children!.map((c) => c.path)).toEqual([
      "root.1.work.0",
      "root.1.work.1",
    ]);
    expect(gate.reviewCursor!.path).toBe("root.1.review");
  });

  it("throws on unknown type (assertNever defense)", () => {
    expect(() => buildCursor({ type: "bogus" } as unknown as ComposeAtom, "0")).toThrow(
      "Unexpected compose kind",
    );
  });
});

// ── serialize / deserialize round-trip ──────────────────────────────────────

describe("serializeCursor / deserializeCursor", () => {
  /** Build a deep gateLoop-bearing tree and mutate scheduler-owned fields. */
  function richTree(): CursorNode {
    const node = buildCursor(
      {
        type: "sequential",
        atoms: [
          {
            type: "gateLoop",
            work: { type: "agent", title: "w" },
            review: { type: "agent", title: "r" },
            maxIterations: 3,
          },
          {
            type: "loop",
            atom: { type: "agent", title: "iter" },
            count: 2,
          },
          {
            type: "parallel",
            atoms: [{ type: "agent", profile: "p" }, { type: "agent" }],
          },
        ],
      },
      "t",
    );

    // Top-level sequential node
    node.state = "running";
    node.childIndex = 1;
    node.lastText = "seq-text";

    // gateLoop at index 0
    const gate = child(node, 0);
    gate.state = "running";
    gate.iteration = 2;
    gate.gatePhase = "review";
    gate.workSessionFile = "/tmp/work.jsonl";
    gate.lastFeedback = "please fix the tests";
    gate.workCursor!.state = "done";
    gate.workCursor!.lastText = "did the work";
    gate.workCursor!.sessionFile = "/tmp/w.jsonl";
    gate.workCursor!.executionCount = 1;
    gate.reviewCursor!.state = "running";
    gate.reviewCursor!.lastText = "reviewing";

    // loop at index 1
    const loop = child(node, 1);
    loop.state = "running";
    loop.loopIteration = 2;
    loop.prevIterationText = "prev iteration output";
    loop.childCursor!.lastText = "current iteration output";

    // parallel at index 2
    const par = child(node, 2);
    par.state = "running";
    par.children![0]!.state = "done";
    par.children![0]!.sessionFile = "/tmp/done.jsonl";

    return node;
  }

  it("round-trips a deep, mutated tree preserving every field", () => {
    const original = richTree();
    const round = deserializeCursor(serializeCursor(original));

    expect(round).toStrictEqual(original);
  });

  it("produces an independent deep copy (no shared references)", () => {
    const original = richTree();
    const round = deserializeCursor(serializeCursor(original));

    // Mutate the copy; original must be unaffected.
    round.state = "done";
    child(round, 0).iteration = 99;
    child(round, 1).childCursor!.lastText = "mutated";

    expect(original.state).toBe("running");
    expect(child(original, 0).iteration).toBe(2);
    expect(child(original, 1).childCursor!.lastText).toBe("current iteration output");
  });

  it("deserializeCursor accepts a plain serialized object directly", () => {
    const plain = serializeCursor(richTree());
    const viaJson = deserializeCursor(JSON.parse(JSON.stringify(plain)));
    expect(viaJson).toStrictEqual(richTree());
  });

  it("round-trips a minimal agent leaf", () => {
    const leaf = buildCursor({ type: "agent" }, "0");
    const round = deserializeCursor(serializeCursor(leaf));
    expect(round).toStrictEqual(leaf);
  });

  it("deserializeCursor throws on non-string kind", () => {
    expect(() => deserializeCursor({ kind: 42, path: "0", state: "pending" })).toThrow(
      "missing or non-string 'kind'",
    );
  });

  it("deserializeCursor throws on non-string path", () => {
    expect(() => deserializeCursor({ kind: "agent", path: null, state: "pending" })).toThrow(
      "missing or non-string 'path'",
    );
  });

  it("deserializeCursor throws on invalid state", () => {
    expect(() => deserializeCursor({ kind: "agent", path: "0", state: "bogus" })).toThrow(
      "invalid or missing 'state'",
    );
  });
});

// ── isComposeComplete ───────────────────────────────────────────────────────

describe("isComposeComplete", () => {
  it("agent: false when pending, true when done", () => {
    const pending = buildCursor({ type: "agent" }, "0");
    expect(isComposeComplete(pending)).toBe(false);
    pending.state = "running";
    expect(isComposeComplete(pending)).toBe(false);
    pending.state = "done";
    expect(isComposeComplete(pending)).toBe(true);
  });

  it("sequential: complete only when ALL children are done", () => {
    const node = buildCursor(
      {
        type: "sequential",
        atoms: [{ type: "agent" }, { type: "agent" }, { type: "agent" }],
      },
      "0",
    );
    expect(isComposeComplete(node)).toBe(false);

    child(node, 0).state = "done";
    expect(isComposeComplete(node)).toBe(false);

    child(node, 1).state = "done";
    expect(isComposeComplete(node)).toBe(false);

    child(node, 2).state = "done";
    expect(isComposeComplete(node)).toBe(true);
  });

  it("parallel: complete only when ALL children are done", () => {
    const node = buildCursor(
      {
        type: "parallel",
        atoms: [{ type: "agent" }, { type: "agent" }],
      },
      "0",
    );
    expect(isComposeComplete(node)).toBe(false);
    child(node, 0).state = "done";
    expect(isComposeComplete(node)).toBe(false);
    child(node, 1).state = "done";
    expect(isComposeComplete(node)).toBe(true);
  });

  it("gateLoop: complete when state done (short-circuit) OR both sub-cursors done", () => {
    const node = buildCursor(
      {
        type: "gateLoop",
        work: { type: "agent" },
        review: { type: "agent" },
      },
      "0",
    );

    // fresh: neither done
    expect(isComposeComplete(node)).toBe(false);

    node.workCursor!.state = "done";
    expect(isComposeComplete(node)).toBe(false);

    node.reviewCursor!.state = "done";
    expect(isComposeComplete(node)).toBe(true);

    // short-circuit via node.state === "done" even if sub-cursors reset
    node.workCursor!.state = "pending";
    node.state = "done";
    expect(isComposeComplete(node)).toBe(true);
  });

  it("loop: complete when loopIteration exceeds count", () => {
    const node = buildCursor({ type: "loop", atom: { type: "agent" }, count: 3 }, "0");
    expect(node.loopIteration).toBe(1);
    expect(isComposeComplete(node)).toBe(false);

    node.loopIteration = 3;
    expect(isComposeComplete(node)).toBe(false);

    node.loopIteration = 4;
    expect(isComposeComplete(node)).toBe(true);
  });

  it("loop: complete when node.state === done regardless of iteration", () => {
    const node = buildCursor({ type: "loop", atom: { type: "agent" }, count: 3 }, "0");
    node.state = "done";
    expect(isComposeComplete(node)).toBe(true);
  });

  it("handles a deeply nested tree: incomplete until every leaf done", () => {
    const node = buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent" },
          {
            type: "parallel",
            atoms: [{ type: "agent" }, { type: "agent" }],
          },
        ],
      },
      "0",
    );
    expect(isComposeComplete(node)).toBe(false);

    child(node, 0).state = "done";
    child(child(node, 1), 0).state = "done";
    expect(isComposeComplete(node)).toBe(false);

    child(child(node, 1), 1).state = "done";
    expect(isComposeComplete(node)).toBe(true);
  });

  it("throws on unknown kind (assertNever defense)", () => {
    const bad = buildCursor({ type: "agent" }, "0");
    (bad as { kind: string }).kind = "bogus";
    expect(() => isComposeComplete(bad)).toThrow("Unexpected compose kind");
  });
});

// ── getCursorByPath ─────────────────────────────────────────────────────────

describe("getCursorByPath", () => {
  /** Sequential[agent, gateLoop(agent, agent), agent]. */
  function tree(): CursorNode {
    return buildCursor(
      {
        type: "sequential",
        atoms: [
          { type: "agent", title: "first" },
          {
            type: "gateLoop",
            work: { type: "agent", title: "gw" },
            review: { type: "agent", title: "gr" },
          },
          { type: "agent", title: "last" },
        ],
      },
      "0",
    );
  }

  it("returns the root when path matches the root", () => {
    const root = tree();
    expect(getCursorByPath(root, "0")).toBe(root);
  });

  it("finds a direct child agent", () => {
    const root = tree();
    const first = getCursorByPath(root, "0.0");
    expect(first).toBeDefined();
    expect(first!.title).toBe("first");
  });

  it("finds a deep node via gateLoop sub-cursors", () => {
    const root = tree();
    const work = getCursorByPath(root, "0.1.work");
    expect(work).toBeDefined();
    expect(work!.title).toBe("gw");

    const review = getCursorByPath(root, "0.1.review");
    expect(review).toBeDefined();
    expect(review!.title).toBe("gr");
  });

  it("finds the gateLoop container node itself", () => {
    const root = tree();
    const gate = getCursorByPath(root, "0.1");
    expect(gate).toBeDefined();
    expect(gate!.kind).toBe("gateLoop");
  });

  it("returns undefined for a missing path", () => {
    const root = tree();
    expect(getCursorByPath(root, "9.9")).toBeUndefined();
    expect(getCursorByPath(root, "0.1.nope")).toBeUndefined();
    expect(getCursorByPath(root, "")).toBeUndefined();
  });

  it("navigates through a loop childCursor", () => {
    const root = buildCursor(
      {
        type: "loop",
        atom: { type: "agent", title: "body" },
        count: 2,
      },
      "L",
    );
    const body = getCursorByPath(root, "L.iter");
    expect(body).toBeDefined();
    expect(body!.title).toBe("body");
  });
});
