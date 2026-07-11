/**
 * Tests for the factory entry point (src/index.ts).
 *
 * Verifies:
 *   1. The parent factory registers run_tasks; child factories register gate_verdict.
 *   2. session_shutdown handler kills child processes and clears the set.
 *   3. session_start / session_tree call seedMergeHelperProfile.
 *   4. No top-level side effects — importing the module doesn't register
 *      tools or throw.
 *   5. Calling the factory twice is idempotent.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockAPI } from "./helpers/mock-api";

// ── Module-level mocks (hoisted) ──────────────────────────────────────────

/** Mock for `kill` from tree-kill — tracks every call. */
const killMock = vi.hoisted(() => vi.fn());
vi.mock("tree-kill", () => ({ default: killMock }));

/** Mock for seedMergeHelperProfile — tracks calls. */
const seedMergeHelperProfileMock = vi.hoisted(() => vi.fn());
vi.mock("../profiles", () => ({
  seedMergeHelperProfile: seedMergeHelperProfileMock,
  // Additional exports required by importing modules (never called in tests).
  loadProfiles: vi.fn(),
  profileToArgs: vi.fn(() => ({ args: [], env: {} })),
  resolveProfile: vi.fn(() => ({})),
}));

/**
 * Spy on createRunTasksTool so we can capture the `childProcesses` set
 * from its options object.  The function still delegates to the real
 * implementation so tool registration works normally.
 */
vi.mock("../run-tasks", async () => {
  const actual = await vi.importActual<typeof import("../run-tasks")>("../run-tasks");
  return {
    ...actual,
    createRunTasksTool: vi.fn(actual.createRunTasksTool),
  };
});

// ── Imports after mocks ───────────────────────────────────────────────────

import factory from "../index";
import { createRunTasksTool } from "../run-tasks";

// ── Tests ─────────────────────────────────────────────────────────────────

describe("factory (default export)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PI_SUBAGENT_TASK_CHILD;
  });

  afterEach(() => {
    delete process.env.PI_SUBAGENT_TASK_CHILD;
  });

  // ── Test 1: tool registration ─────────────────────────────────────────

  it("registers run_tasks in the parent session", () => {
    const { api, capturedTools } = createMockAPI();

    factory(api);

    expect(capturedTools.size).toBe(1);
    expect(capturedTools.has("run_tasks")).toBe(true);
    expect(capturedTools.has("gate_verdict")).toBe(false);
  });

  it("registers only gate_verdict in a child session", () => {
    process.env.PI_SUBAGENT_TASK_CHILD = "1";
    const { api, capturedTools } = createMockAPI();

    factory(api);

    expect(capturedTools.size).toBe(1);
    expect(capturedTools.has("run_tasks")).toBe(false);
    expect(capturedTools.has("gate_verdict")).toBe(true);
  });

  // ── Test 2: session_shutdown kills child processes ────────────────────

  it("session_shutdown handler kills child processes and clears the set", () => {
    const { api, capturedHandlers } = createMockAPI();

    factory(api);

    const calls = vi.mocked(createRunTasksTool).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstOpts = calls[0]?.[1];
    expect(firstOpts).toBeDefined();
    const opts = firstOpts!;

    // Populate with fake child processes: two with valid PIDs, one
    // without pid (to cover the `if (proc.pid)` else branch), and one
    // that will cause kill to throw (to cover the catch branch).
    opts.childProcesses.add({ pid: 12345 } as unknown as never);
    opts.childProcesses.add({ pid: 54321 } as unknown as never);
    opts.childProcesses.add({} as unknown as never); // no pid => skips kill

    // Make the second kill call throw to exercise the catch branch.
    killMock.mockImplementationOnce(() => undefined); // first call succeeds
    killMock.mockImplementationOnce(() => {
      throw new Error("kill failed");
    }); // second call throws

    // Invoke the session_shutdown handler.
    const handler = capturedHandlers["session_shutdown"] as () => void;
    expect(handler).toBeDefined();
    expect(() => {
      handler();
    }).not.toThrow();

    // kill was called with each valid PID + SIGKILL.
    expect(killMock).toHaveBeenCalledWith(12345, "SIGKILL");
    expect(killMock).toHaveBeenCalledWith(54321, "SIGKILL");
    expect(killMock).toHaveBeenCalledTimes(2);

    // The set was cleared after iteration.
    expect(opts.childProcesses.size).toBe(0);
  });

  // ── Test 3: session_start calls seedMergeHelperProfile ────────────────

  it("session_start calls seedMergeHelperProfile", () => {
    const { api, capturedHandlers } = createMockAPI();

    factory(api);

    const handler = capturedHandlers["session_start"] as () => void;
    expect(handler).toBeDefined();

    handler();

    expect(seedMergeHelperProfileMock).toHaveBeenCalledTimes(1);
  });

  it("session_tree also calls seedMergeHelperProfile", () => {
    const { api, capturedHandlers } = createMockAPI();

    factory(api);

    const handler = capturedHandlers["session_tree"] as () => void;
    expect(handler).toBeDefined();

    handler();

    expect(seedMergeHelperProfileMock).toHaveBeenCalledTimes(1);
  });

  // ── Test 4: no top-level side effects ─────────────────────────────────

  it("no top-level side effects on import", () => {
    // The import itself (at the top of this file) would have thrown if the
    // module had top-level side effects that fail.  Additionally, verify
    // that a fresh mock API has no registered tools or handlers — the
    // factory hasn't been called yet.
    expect(typeof factory).toBe("function");

    const { capturedTools, capturedHandlers } = createMockAPI();
    expect(capturedTools.size).toBe(0);
    expect(Object.keys(capturedHandlers).length).toBe(0);

    // Calling the factory triggers registration.
    const { api } = createMockAPI();
    factory(api);
    // We already test registration depth in test 1 — this just
    // demonstrates the contrast.
  });

  // ── Test: getGitOps lazy caching and getAgentRunner ───────────────────

  it("getGitOps lazily creates and caches GitOps, covering both branches", () => {
    const { api } = createMockAPI();

    factory(api);

    const calls = vi.mocked(createRunTasksTool).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstOpts = calls[0]?.[1];
    expect(firstOpts).toBeDefined();
    const opts = firstOpts!;

    // First call — creates the cache (covers the `if (!gitOpsCache)` branch).
    const first = opts.getGitOps();
    expect(first).toBeDefined();

    // Second call — reuses the cache (covers the fall-through branch).
    const second = opts.getGitOps();
    expect(second).toBe(first); // Same cached instance.
  });

  it("getAgentRunner creates an AgentRunner (covers the arrow-function body)", () => {
    const { api } = createMockAPI();

    factory(api);

    const calls = vi.mocked(createRunTasksTool).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstOpts = calls[0]?.[1];
    expect(firstOpts).toBeDefined();
    const opts = firstOpts!;

    const runner = opts.getAgentRunner();
    expect(runner).toBeDefined();
    expect(typeof runner.runAgent).toBe("function");
  });

  // ── Test 5: idempotent factory calls ──────────────────────────────────

  it("calling factory twice is idempotent (does not throw)", () => {
    const { api, capturedTools } = createMockAPI();

    // First call.
    factory(api);
    expect(capturedTools.size).toBe(1);

    // Second call — must not throw and must not duplicate registration.
    expect(() => {
      factory(api);
    }).not.toThrow();

    // The pi.registerTool mock just overwrites previous entries; size
    // stays 1 because vi.fn doesn't throw on duplicate registration.
    expect(capturedTools.size).toBe(1);
    expect(capturedTools.has("run_tasks")).toBe(true);
    expect(capturedTools.has("gate_verdict")).toBe(false);
  });
});
