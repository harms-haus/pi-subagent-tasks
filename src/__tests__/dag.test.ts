import { describe, it, expect } from "vitest";

import { resolveDeps, detectCycles, computeDownstreamCount } from "../dag";

// ── resolveDeps ──────────────────────────────────────────────────────────────

describe("resolveDeps", () => {
  it("auto-assigns t-<N> ids in declaration order when ids are missing", () => {
    const { assignedIds } = resolveDeps([{ title: "A" }, { title: "B" }, { title: "C" }]);
    expect(assignedIds).toEqual(["t-1", "t-2", "t-3"]);
  });

  it("keeps user-supplied ids and numbers auto-assigned ones by list position", () => {
    const { assignedIds } = resolveDeps([{ id: "foo" }, {}, {}]);
    expect(assignedIds).toEqual(["foo", "t-2", "t-3"]);
  });

  it("resolves title refs in dependsOn to the referenced task's id", () => {
    const { idMap, assignedIds } = resolveDeps([
      { id: "plan", title: "Plan" },
      { title: "Write tests", dependsOn: ["plan"] },
      { dependsOn: ["Write tests"] },
    ]);
    expect(assignedIds).toEqual(["plan", "t-2", "t-3"]);
    expect(idMap.get("plan")).toEqual([]);
    expect(idMap.get("t-2")).toEqual(["plan"]); // id ref
    expect(idMap.get("t-3")).toEqual(["t-2"]); // title ref → id
  });

  it("prefers an id match over a like-named title", () => {
    // "shared" is both an id (task 0) and a title (task 1 → "other"). Id wins.
    const { idMap } = resolveDeps([
      { id: "shared", title: "dup" },
      { id: "other", title: "shared" },
      { id: "c", dependsOn: ["shared"] },
    ]);
    expect(idMap.get("c")).toEqual(["shared"]);
  });

  it("dedupes dependsOn entries that resolve to the same id", () => {
    const { idMap } = resolveDeps([
      { id: "a", title: "Alpha" },
      { id: "b", dependsOn: ["a", "Alpha"] },
    ]);
    expect(idMap.get("b")).toEqual(["a"]);
  });

  it("returns an empty dep array for tasks without dependsOn", () => {
    const { idMap } = resolveDeps([{ id: "a" }, { id: "b" }]);
    expect(idMap.get("a")).toEqual([]);
    expect(idMap.get("b")).toEqual([]);
  });

  it("throws on a duplicate id", () => {
    expect(() => resolveDeps([{ id: "dup" }, { id: "dup" }])).toThrow(/Duplicate task id "dup"/);
  });

  it("throws when a dependsOn ref is neither an id nor a title, listing known ids/titles", () => {
    expect(() =>
      resolveDeps([
        { id: "a", title: "Alpha" },
        { id: "b", dependsOn: ["ghost"] },
      ]),
    ).toThrow(/unresolved ref "ghost".*Known ids: a, b.*Known titles: Alpha/);
  });

  it("throws when an unknown id that is also not a title is referenced", () => {
    expect(() => resolveDeps([{ id: "a" }, { id: "b", dependsOn: ["missing-id"] }])).toThrow(
      /unresolved ref "missing-id"/,
    );
  });

  it("lists (none) for known ids/titles when none exist", () => {
    expect(() => resolveDeps([{ id: "a" }, { id: "b", dependsOn: ["zzz"] }])).toThrow(
      /Known titles: \(none\)/,
    );
  });

  it("throws on duplicate titles", () => {
    expect(() =>
      resolveDeps([
        { id: "a", title: "X" },
        { id: "b", title: "X" },
      ]),
    ).toThrow(/Duplicate task title "X"/);
  });

  it("throws when a user-supplied id contains path-traversal characters", () => {
    expect(() => resolveDeps([{ id: "../evil" }, { id: "safe-id" }])).toThrow(
      /alphanumeric with dashes/,
    );
    expect(() => resolveDeps([{ id: "../../tmp/evil" }, { id: "b" }])).toThrow(
      /alphanumeric with dashes/,
    );
  });

  it("throws when a user-supplied id contains spaces or shell chars", () => {
    expect(() => resolveDeps([{ id: "bad id" }])).toThrow(/alphanumeric with dashes/);
    expect(() => resolveDeps([{ id: "a&b" }])).toThrow(/alphanumeric with dashes/);
  });

  it("returns empty for empty input", () => {
    const { idMap, assignedIds } = resolveDeps([]);
    expect(assignedIds).toEqual([]);
    expect(idMap.size).toBe(0);
  });
});

// ── detectCycles ─────────────────────────────────────────────────────────────

describe("detectCycles", () => {
  it("returns null for an acyclic graph", () => {
    const deps = new Map([
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
    ]);
    expect(detectCycles(["a", "b", "c"], deps)).toBeNull();
  });

  it("detects a self-cycle and returns the path", () => {
    const deps = new Map([["a", ["a"]]]);
    expect(detectCycles(["a"], deps)).toBe("a → a");
  });

  it("detects an A → B → A cycle and returns the path", () => {
    const deps = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(detectCycles(["a", "b"], deps)).toBe("a → b → a");
  });

  it("returns only the cycle nodes, not the entry path", () => {
    // entry a → b, then b → c → b (the actual cycle).
    const deps = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["b"]],
    ]);
    expect(detectCycles(["a", "b", "c"], deps)).toBe("b → c → b");
  });

  it("skips dep ids not in taskIds (no spurious cycle)", () => {
    const deps = new Map([["a", ["ghost"]]]);
    expect(detectCycles(["a"], deps)).toBeNull();
  });

  it("returns a cycle from multiple disjoint cycles", () => {
    // Two disjoint cycles: a→b→a and c→d→c. The function may find either.
    const deps = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["d"]],
      ["d", ["c"]],
    ]);
    const result = detectCycles(["a", "b", "c", "d"], deps);
    expect(result).not.toBeNull();
    expect(result).toMatch(/ → /);
  });

  it("flags a self-cycle through resolveDeps→detectCycles", () => {
    const { idMap, assignedIds } = resolveDeps([{ id: "a", dependsOn: ["a"] }]);
    const cycle = detectCycles(assignedIds, idMap);
    expect(cycle).toBe("a → a");
  });
});

// ── computeDownstreamCount ───────────────────────────────────────────────────

describe("computeDownstreamCount", () => {
  it("counts transitive downstream dependents for a chain", () => {
    // A (no deps) ← B (dep A) ← C (dep B)
    const deps = new Map([
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
    ]);
    const counts = computeDownstreamCount(["a", "b", "c"], deps);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
    expect(counts.get("c")).toBe(0);
  });

  it("counts each descendant once in a diamond", () => {
    //        a
    //       / \
    //      b   c
    //       \ /
    //        d
    const deps = new Map([
      ["a", []],
      ["b", ["a"]],
      ["c", ["a"]],
      ["d", ["b", "c"]],
    ]);
    const counts = computeDownstreamCount(["a", "b", "c", "d"], deps);
    expect(counts.get("a")).toBe(3); // b, c, d
    expect(counts.get("b")).toBe(1); // d
    expect(counts.get("c")).toBe(1); // d
    expect(counts.get("d")).toBe(0);
  });

  it("ignores dep ids not present in taskIds", () => {
    const deps = new Map([
      ["a", []],
      ["b", ["a", "ghost"]],
    ]);
    const counts = computeDownstreamCount(["a", "b"], deps);
    expect(counts.get("a")).toBe(1);
    expect(counts.get("b")).toBe(0);
  });

  it("returns 0 for every isolated node", () => {
    const deps = new Map([
      ["a", []],
      ["b", []],
    ]);
    const counts = computeDownstreamCount(["a", "b"], deps);
    expect(counts.get("a")).toBe(0);
    expect(counts.get("b")).toBe(0);
  });

  it("deduplicate duplicate raw dependency entries", () => {
    const deps = new Map([
      ["a", []],
      ["b", ["a", "a", "a"]],
    ]);
    const counts = computeDownstreamCount(["a", "b"], deps);
    expect(counts.get("a")).toBe(1); // counted once
    expect(counts.get("b")).toBe(0);
  });
});
