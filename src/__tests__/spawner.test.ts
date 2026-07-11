/**
 * Tests for the agent spawner module (§11).
 *
 * Covers: event parsing (message_end, tool_execution_end / gate_verdict),
 * loop detection, abort signal behaviour, spawn errors, UTF-8 split
 * reassembly, and idle-timeout auto-extend.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnOptions } from "../spawner";
import {
  LOOP_DETECT_COUNT,
  IDLE_TIMEOUT_MS,
  IDLE_DEBOUNCE_MS,
  ABORT_GRACE_MS,
  ABORT_FORCE_MS,
} from "../constants";

// ── Hoisted mock state ───────────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock() factories, which run before imports.
// These variables are the direct reference used in both the mock factory and
// test assertions – no temporal-dead-zone issues.

const { mockSpawn, mockKill, getMockProc } = vi.hoisted(() => {
  let currentProc: Record<string, unknown>;

  function createMockProcess() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter } = require("node:events");
    const proc = new EventEmitter() as Record<string, unknown>;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.pid = 12_345;
    currentProc = proc;
    return proc;
  }

  return {
    mockSpawn: vi.fn(createMockProcess),
    mockKill: vi.fn(),
    getMockProc: () => currentProc,
  };
});

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("tree-kill", () => ({
  default: mockKill,
}));

// ── SUT import (after mocks are wired) ────────────────────────────────────────

import { spawnAgent } from "../spawner";

// Expected generous character bound for the documented stderr tail.
const STDERR_TAIL_MAX_CHARS = 64 * 1024;

// ── Test helpers ──────────────────────────────────────────────────────────────

const defaultOpts: SpawnOptions = {
  command: "pi",
  args: ["agent", "run", "--no-tui"],
  env: { PI_ENV: "test" },
  stdinPrompt: "Do the thing",
  cwd: "/tmp/workdir",
};

/** Emit a string as a `data` event on the mock process's stdout. */
function emitStdout(data: string): void {
  const proc = getMockProc() as {
    stdout: { emit: (e: string, b: Buffer) => void };
  };
  proc.stdout.emit("data", Buffer.from(data, "utf8"));
}

/** Emit stderr data on the mock process. */
function emitStderr(data: string): void {
  const proc = getMockProc() as {
    stderr: { emit: (e: string, b: Buffer) => void };
  };
  proc.stderr.emit("data", Buffer.from(data, "utf8"));
}

/** Emit a `close` event on the mock process. */
function emitClose(code: number | null): void {
  const proc = getMockProc() as {
    emit: (e: string, c: number | null, s: null) => void;
  };
  proc.emit("close", code, null);
}

/** Emit an `exit` event on the mock process. */
function emitExit(code: number | null): void {
  const proc = getMockProc() as {
    emit: (e: string, c: number | null) => void;
  };
  proc.emit("exit", code);
}

/** Emit an `error` event on the mock process. */
function emitError(message: string): void {
  const proc = getMockProc() as {
    emit: (e: string, err: Error) => void;
  };
  proc.emit("error", new Error(message));
}

/** Advance mock process lifecycle: write stdout, then emit exit and close. */
function feedAndExit(lines: string[], exitCode = 0): void {
  for (const line of lines) {
    emitStdout(line + "\n");
  }
  emitExit(exitCode);
  emitClose(exitCode);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("spawnAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── (a) message_end → lastAssistantText ────────────────────────────────

  it("captures lastAssistantText from message_end events", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"message_end","message":{"content":[{"type":"text","text":"Hello world"}]}}`,
    ]);

    const result = await promise;
    expect(result.lastAssistantText).toBe("Hello world");
    expect(result.exitCode).toBe(0);
    expect(result.loopDetected).toBe(false);
  });

  it("uses the last text part when multiple exist", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"message_end","message":{"content":[{"type":"text","text":"first"},{"type":"text","text":"second"},{"type":"tool_use","name":"x"}]}}`,
    ]);

    const result = await promise;
    expect(result.lastAssistantText).toBe("second");
  });

  it("also handles turn_end events", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"turn_end","message":{"content":[{"type":"text","text":"Turn result"}]}}`,
    ]);

    const result = await promise;
    expect(result.lastAssistantText).toBe("Turn result");
  });

  // ── (b) gate_verdict ──────────────────────────────────────────────────

  // Real platform shape: tool_execution_end.result is the full AgentToolResult<T>,
  // i.e. { content: [...], details: { approved, feedback }, terminate? }.
  it("parses gate_verdict from the real tool_execution_end result.details shape", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"tool_execution_end","toolName":"gate_verdict","isError":false,"result":{"content":[{"type":"text","text":"Approved"}],"details":{"approved":true,"feedback":"Looks good"}}}`,
    ]);

    const result = await promise;
    expect(result.verdict).toEqual({ approved: true, feedback: "Looks good" });
  });

  it("parses a rejection verdict from result.details", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"tool_execution_end","toolName":"gate_verdict","isError":false,"result":{"content":[],"details":{"approved":false,"feedback":"Needs work"}}}`,
    ]);

    const result = await promise;
    expect(result.verdict).toEqual({ approved: false, feedback: "Needs work" });
  });

  it("tolerates a flat result (no details) as a defensive fallback", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"tool_execution_end","toolName":"gate_verdict","result":{"approved":true,"feedback":"flat"}}`,
    ]);

    const result = await promise;
    expect(result.verdict).toEqual({ approved: true, feedback: "flat" });
  });

  it("parses gate_verdict from args fallback when result is absent", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"tool_execution_end","toolName":"gate_verdict","args":{"approved":false,"feedback":"Needs work"}}`,
    ]);

    const result = await promise;
    expect(result.verdict).toEqual({ approved: false, feedback: "Needs work" });
  });

  it("yields undefined when result has no details and no boolean approved", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"tool_execution_end","toolName":"gate_verdict","result":{"content":[{"type":"text","text":"done"}]}}`,
    ]);

    const result = await promise;
    expect(result.verdict).toBeUndefined();
  });

  it("yields undefined when approved is not a boolean", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"tool_execution_end","toolName":"gate_verdict","result":{"content":[],"details":{"approved":"yes","feedback":"txt"}}}`,
    ]);

    const result = await promise;
    expect(result.verdict).toBeUndefined();
  });

  it("ignores tool_execution_end for other tools", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([`{"type":"tool_execution_end","toolName":"read","args":{"path":"x.txt"}}`]);

    const result = await promise;
    expect(result.verdict).toBeUndefined();
  });

  // ── (b2) Session id capture (N1) ─────────────────────────────────────

  it("captures sessionId from the type:session header event", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"session","version":3,"id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","timestamp":"2026-07-10T00:00:00Z","cwd":"/tmp/workdir"}`,
      `{"type":"message_end","message":{"content":[{"type":"text","text":"done"}]}}`,
    ]);

    const result = await promise;
    expect(result.sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("captures sessionId from a partial (no trailing newline) session header", async () => {
    const promise = spawnAgent(defaultOpts);

    // Session header arrives without a trailing newline — flushRemainders
    // parses it on close.
    emitStdout(`{"type":"session","version":3,"id":"sess-partial-id","cwd":"/tmp/workdir"}`);
    emitExit(0);
    emitClose(0);

    const result = await promise;
    expect(result.sessionId).toBe("sess-partial-id");
  });

  it("leaves sessionId undefined when no session header is emitted", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"message_end","message":{"content":[{"type":"text","text":"no header"}]}}`,
    ]);

    const result = await promise;
    expect(result.sessionId).toBeUndefined();
  });

  it("ignores a session header with a non-string id", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"session","version":3,"id":12345,"cwd":"/tmp/workdir"}`,
      `{"type":"message_end","message":{"content":[{"type":"text","text":"x"}]}}`,
    ]);

    const result = await promise;
    expect(result.sessionId).toBeUndefined();
  });

  it("captures only the first session header (ignores subsequent ones)", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"session","version":3,"id":"first-id","cwd":"/tmp/workdir"}`,
      `{"type":"session","version":3,"id":"second-id","cwd":"/tmp/workdir"}`,
    ]);

    const result = await promise;
    expect(result.sessionId).toBe("first-id");
  });

  it("captures sessionId even on a spawn error result", async () => {
    const promise = spawnAgent(defaultOpts);

    // Emit the session header before the error
    emitStdout(`{"type":"session","version":3,"id":"err-session-id","cwd":"/tmp/workdir"}\n`);
    emitError("spawn failed");

    const result = await promise;
    expect(result.sessionId).toBe("err-session-id");
    expect(result.exitCode).toBe(-1);
  });

  // ── (c) Loop detection ─────────────────────────────────────────────────

  it("detects loop when last LOOP_DETECT_COUNT signatures are identical", async () => {
    const promise = spawnAgent(defaultOpts);

    // Emit LOOP_DETECT_COUNT identical tool_execution_start events
    const toolEvent = `{"type":"tool_execution_start","toolName":"read","args":{"path":"foo.txt"}}`;
    for (let i = 0; i < LOOP_DETECT_COUNT; i++) {
      emitStdout(toolEvent + "\n");
    }

    // Loop detection should have fired → mockKill called
    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");

    // Close the process to resolve
    emitExit(0);
    emitClose(0);

    const result = await promise;
    expect(result.loopDetected).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("does NOT detect loop for fewer than LOOP_DETECT_COUNT signatures", async () => {
    const promise = spawnAgent(defaultOpts);

    const toolEvent = `{"type":"tool_execution_start","toolName":"read","args":{"path":"foo.txt"}}`;
    for (let i = 0; i < LOOP_DETECT_COUNT - 1; i++) {
      emitStdout(toolEvent + "\n");
    }

    emitExit(0);
    emitClose(0);

    const result = await promise;
    expect(result.loopDetected).toBe(false);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("detects loop from tool_execution_start events (different tool name)", async () => {
    const promise = spawnAgent(defaultOpts);

    const toolEvent = `{"type":"tool_execution_start","toolName":"read_file","args":{"path":"foo.txt"}}`;
    for (let i = 0; i < LOOP_DETECT_COUNT; i++) {
      emitStdout(toolEvent + "\n");
    }

    expect(mockKill).toHaveBeenCalledTimes(1);
    emitExit(0);
    emitClose(0);

    const result = await promise;
    expect(result.loopDetected).toBe(true);
  });

  // ── (d) Abort signal ──────────────────────────────────────────────────

  it("kills process tree when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();

    const promise = spawnAgent({ ...defaultOpts, signal: ac.signal });

    // killProcessTree is called synchronously in the constructor
    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");

    // Resolve by emitting close (simulating eventual process death)
    emitClose(null);

    const result = await promise;
    expect(result.exitCode).toBeNull();
  });

  it("kills process tree when signal aborts later", async () => {
    const ac = new AbortController();

    const promise = spawnAgent({ ...defaultOpts, signal: ac.signal });
    expect(mockKill).not.toHaveBeenCalled();

    ac.abort();

    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");

    emitClose(null);

    const result = await promise;
    expect(result.exitCode).toBeNull();
  });

  it("cancels abort escalation when the child closes during the grace period", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const onSettled = vi.fn();
    const promise = spawnAgent({ ...defaultOpts, signal: ac.signal }).then((result) => {
      onSettled(result);
      return result;
    });

    ac.abort();
    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenLastCalledWith(12_345, "SIGTERM");

    emitClose(null);
    const result = await promise;
    expect(result.exitCode).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(ABORT_GRACE_MS + ABORT_FORCE_MS + 1);
    await Promise.resolve();

    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("cancels abort escalation when the child emits a terminal error", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const promise = spawnAgent({ ...defaultOpts, signal: ac.signal });

    ac.abort();
    emitError("child failed while terminating");

    await expect(promise).resolves.toMatchObject({
      exitCode: -1,
      stderr: expect.stringContaining("child failed while terminating"),
    });

    vi.advanceTimersByTime(ABORT_GRACE_MS + ABORT_FORCE_MS + 1);
    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");
  });

  it("escalates and resolves within the abort bounds when the child never closes", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const promise = spawnAgent({ ...defaultOpts, signal: ac.signal });

    ac.abort();
    vi.advanceTimersByTime(ABORT_GRACE_MS - 1);
    expect(mockKill).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(mockKill).toHaveBeenNthCalledWith(2, 12_345, "SIGKILL");

    vi.advanceTimersByTime(ABORT_FORCE_MS);
    await expect(promise).resolves.toMatchObject({ exitCode: null });
    expect(mockKill).toHaveBeenCalledTimes(2);
  });

  // ── (e) Spawn error ───────────────────────────────────────────────────

  it("resolves with exitCode -1 on spawn error (ENOENT)", async () => {
    const promise = spawnAgent(defaultOpts);

    emitError("spawn pi ENOENT");

    const result = await promise;
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("spawn pi ENOENT");
    expect(result.stderr).toContain("cwd: /tmp/workdir");
    expect(result.lastAssistantText).toBe("");
    expect(result.loopDetected).toBe(false);
  });

  it("resolves once and terminates the child when stdin.write throws synchronously", async () => {
    const onSettled = vi.fn();
    const promise = spawnAgent({
      ...defaultOpts,
      onSpawn(proc) {
        proc.stdin!.write = vi.fn(() => {
          throw new Error("stdin write exploded");
        });
      },
    });
    void promise.then(onSettled, () => undefined);

    await expect(promise).resolves.toMatchObject({
      exitCode: -1,
      stderr: expect.stringContaining("stdin write exploded"),
      lastAssistantText: "",
      loopDetected: false,
    });
    emitClose(0);
    await Promise.resolve();

    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("resolves once and terminates the child when stdin.end throws synchronously", async () => {
    const onSettled = vi.fn();
    const promise = spawnAgent({
      ...defaultOpts,
      onSpawn(proc) {
        proc.stdin!.end = vi.fn(() => {
          throw new Error("stdin end exploded");
        });
      },
    });
    void promise.then(onSettled, () => undefined);

    await expect(promise).resolves.toMatchObject({
      exitCode: -1,
      stderr: expect.stringContaining("stdin end exploded"),
      lastAssistantText: "",
      loopDetected: false,
    });
    emitClose(0);
    await Promise.resolve();

    const proc = getMockProc() as {
      stdin: { write: ReturnType<typeof vi.fn> };
    };
    expect(proc.stdin.write).toHaveBeenCalledWith(defaultOpts.stdinPrompt);
    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  // ── (f) UTF-8 multi-byte split across chunks ──────────────────────────

  it("reassembles multi-byte UTF-8 split across data chunks", async () => {
    const line = `{"type":"message_end","message":{"content":[{"type":"text","text":"héllo"}]}}\n`;
    const buf = Buffer.from(line, "utf8");

    // "é" is U+00E9 → UTF-8 bytes 0xC3 0xA9.
    // Split right after the first byte (0xC3) so the second chunk starts
    // with 0xA9, which would be an illegal start byte on its own.
    const chunk1 = buf.subarray(0, 53); // known offset: byte 53 = first byte of 'é'
    const chunk2 = buf.subarray(53); // starts with second byte 0xA9

    const promise = spawnAgent(defaultOpts);

    const proc = getMockProc() as {
      stdout: { emit: (e: string, b: Buffer) => void };
    };
    proc.stdout.emit("data", chunk1);
    proc.stdout.emit("data", chunk2);

    emitExit(0);
    emitClose(0);

    const result = await promise;
    expect(result.lastAssistantText).toBe("héllo");
  });

  // ── (g) Idle timeout ──────────────────────────────────────────────────

  it("kills process after idle timeout with no stdout activity", async () => {
    vi.useFakeTimers();

    const promise = spawnAgent(defaultOpts);

    // Advance time past the idle threshold (elapsed >= IDLE_TIMEOUT_MS and
    // timeSinceActivity >= IDLE_DEBOUNCE_MS). The checker runs every 1s.
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + IDLE_DEBOUNCE_MS + 2_000);

    // Idle checker should have triggered killProcessTree (at minimum SIGTERM;
    // the force-resolve escalation may also call SIGKILL during timer advance).
    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");

    // Emit close to resolve (simulating process death after signal)
    emitClose(null);

    const result = await promise;
    expect(result.loopDetected).toBe(false);
    // exitCode is null because force-resolve path gives null, or close event
    // passes the code from emitClose
    expect(result.exitCode).toBeNull();
  });

  it("does NOT trigger idle timeout when valid events keep coming", async () => {
    vi.useFakeTimers();

    const promise = spawnAgent(defaultOpts);

    // Keep emitting parsed events within the debounce window.
    for (let tick = 0; tick < 10; tick++) {
      vi.advanceTimersByTime(IDLE_DEBOUNCE_MS / 2);
      emitStdout(`{"type":"ping"}\n`);
    }

    // Total elapsed is now 10 * (IDLE_DEBOUNCE_MS/2) ≈ 5 * IDLE_DEBOUNCE_MS
    // which is > IDLE_TIMEOUT_MS, but valid activity kept resetting the debounce.
    expect(mockKill).not.toHaveBeenCalled();

    emitExit(0);
    emitClose(0);
    const result = await promise;
    expect(result.loopDetected).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("times out despite repeated invalid complete stdout lines", async () => {
    vi.useFakeTimers();

    const promise = spawnAgent(defaultOpts);

    // Malformed complete lines arrive more frequently than the debounce, but
    // none are agent events and therefore none should extend the idle window.
    const interval = IDLE_DEBOUNCE_MS / 2;
    const emissions = Math.ceil((IDLE_TIMEOUT_MS + IDLE_DEBOUNCE_MS) / interval);
    for (let tick = 0; tick < emissions; tick++) {
      vi.advanceTimersByTime(interval);
      emitStdout("{not-json}\n");
    }

    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");

    emitClose(null);
    await promise;
  });

  it("resets idle activity when a valid event is parsed", async () => {
    vi.useFakeTimers();

    const promise = spawnAgent(defaultOpts);

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1_000);
    emitStdout(`{"type":"ping"}\n`);

    vi.advanceTimersByTime(IDLE_DEBOUNCE_MS - 1_000);
    expect(mockKill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");

    emitClose(null);
    await promise;
  });

  it("does not count partial JSON as idle activity before it is parsed", async () => {
    vi.useFakeTimers();

    const promise = spawnAgent(defaultOpts);

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1_000);
    emitStdout(`{"type":"ping"`);
    vi.advanceTimersByTime(2_000);

    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");

    emitClose(null);
    await promise;
  });

  it("resets idle activity only after split JSON is reassembled and parsed", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn();
    const promise = spawnAgent({ ...defaultOpts, onUpdate });

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1_000);
    emitStdout(`{"type":"ping"`);
    expect(onUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    emitStdout("}\n");
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Successful parsing just before the original idle deadline extends the
    // run by a full debounce window; receiving the partial chunk did not.
    vi.advanceTimersByTime(IDLE_DEBOUNCE_MS - 1);
    expect(mockKill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");

    emitClose(null);
    await promise;
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("ignores non-JSON stdout lines", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `plain log line`,
      `another non-json`,
      `{"type":"message_end","message":{"content":[{"type":"text","text":"after noise"}]}}`,
    ]);

    const result = await promise;
    expect(result.lastAssistantText).toBe("after noise");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr output", async () => {
    const promise = spawnAgent(defaultOpts);

    emitStderr("warning: something happened\n");
    emitStderr("error: failed\n");
    emitExit(1);
    emitClose(1);

    const result = await promise;
    expect(result.stderr).toBe("warning: something happened\nerror: failed\n");
    expect(result.exitCode).toBe(1);
  });

  it("retains stderr unchanged when it is within the documented tail bound", async () => {
    const promise = spawnAgent(defaultOpts);
    const stderr = "a".repeat(STDERR_TAIL_MAX_CHARS - 7) + "partial";

    emitStderr(stderr.slice(0, 31));
    emitStderr(stderr.slice(31));
    emitExit(1);
    emitClose(1);

    expect((await promise).stderr).toBe(stderr);
  });

  it("retains the deterministic newest stderr tail across chunks and a partial line", async () => {
    const promise = spawnAgent(defaultOpts);
    const discarded = "old-line\n".repeat(7);
    const newest = "n".repeat(STDERR_TAIL_MAX_CHARS - 8) + "partial!";
    const stderr = discarded + newest;

    emitStderr(stderr.slice(0, 17));
    emitStderr(stderr.slice(17, STDERR_TAIL_MAX_CHARS + 11));
    emitStderr(stderr.slice(STDERR_TAIL_MAX_CHARS + 11));
    emitExit(2);
    emitClose(2);

    const result = await promise;
    expect(result.stderr).toBe(stderr.slice(-STDERR_TAIL_MAX_CHARS));
    expect(result.stderr).toHaveLength(STDERR_TAIL_MAX_CHARS);
  });

  it("does not split a surrogate pair at the stderr tail boundary", async () => {
    const promise = spawnAgent(defaultOpts);
    // A code-unit slice at the bound would retain only the emoji's low surrogate.
    const stderr = "😀" + "x".repeat(STDERR_TAIL_MAX_CHARS - 1);

    emitStderr(stderr);
    emitExit(1);
    emitClose(1);

    const result = await promise;
    expect(result.stderr).toBe("x".repeat(STDERR_TAIL_MAX_CHARS - 1));
    expect(result.stderr).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("emits compact tool previews from message_end toolCall parts", async () => {
    const onOutput = vi.fn();
    const promise = spawnAgent({ ...defaultOpts, onOutput });

    feedAndExit([
      `{"type":"message_end","message":{"content":[{"type":"text","text":"Checking"},{"type":"toolCall","name":"read","arguments":{"path":"/tmp/test/file.ts","limit":10}}]}}`,
    ]);

    await promise;
    expect(onOutput).not.toHaveBeenCalledWith("Checking");
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith("📖 read -> /tmp/test/file.ts +10");
  });

  it("calls onUpdate for each parsed JSON event", async () => {
    const onUpdate = vi.fn();
    const promise = spawnAgent({ ...defaultOpts, onUpdate });

    feedAndExit([
      `{"type":"message_end","message":{"content":[{"type":"text","text":"A"}]}}`,
      `{"type":"tool_execution_start","toolName":"read","args":{}}`,
    ]);

    await promise;
    // Two JSON lines → two onUpdate calls
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not call onUpdate for non-JSON lines", async () => {
    const onUpdate = vi.fn();
    const promise = spawnAgent({ ...defaultOpts, onUpdate });

    feedAndExit([`just a log line`]);

    await promise;
    expect(onUpdate).toHaveBeenCalledTimes(0);
  });

  // ── Edge coverage (branch coverage holes) ────────────────────────────────

  it("extractLastText returns undefined when message has no text parts", async () => {
    const promise = spawnAgent(defaultOpts);

    feedAndExit([
      `{"type":"message_end","message":{"content":[{"type":"tool_use","name":"read"}]}}`,
    ]);

    const result = await promise;
    expect(result.lastAssistantText).toBe("");
  });

  it("handles more than LOOP_DETECT_COUNT signatures (shift path)", async () => {
    const promise = spawnAgent(defaultOpts);

    const toolEvent = `{"type":"tool_execution_start","toolName":"read","args":{"path":"foo.txt"}}`;
    // Push LOOP_DETECT_COUNT + 2 identical signatures to exercise shift()
    for (let i = 0; i < LOOP_DETECT_COUNT + 2; i++) {
      emitStdout(toolEvent + "\n");
    }

    // Loop detection should still fire after the 5th
    expect(mockKill).toHaveBeenCalledWith(12_345, "SIGTERM");
    emitExit(0);
    emitClose(0);

    const result = await promise;
    expect(result.loopDetected).toBe(true);
  });

  it("flushRemainders captures partial stdout line at exit", async () => {
    const promise = spawnAgent(defaultOpts);

    // Send a JSON line WITHOUT a trailing newline – it stays in the buffer
    emitStdout(`{"type":"message_end","message":{"content":[{"type":"text","text":"partial"}]}}`);
    emitExit(0);
    emitClose(0);

    const result = await promise;
    expect(result.lastAssistantText).toBe("partial");
  });

  it("flushRemainders captures partial stderr line at exit", async () => {
    const promise = spawnAgent(defaultOpts);

    // Stderr with no trailing newline
    emitStderr("error without newline");
    emitExit(1);
    emitClose(1);

    const result = await promise;
    expect(result.stderr).toBe("error without newline");
  });

  it("flushRemainders parses gate_verdict from partial stdout line", async () => {
    const promise = spawnAgent(defaultOpts);

    // Partial JSON line (no trailing newline) containing a real-shape gate verdict
    emitStdout(
      `{"type":"tool_execution_end","toolName":"gate_verdict","isError":false,"result":{"content":[],"details":{"approved":true,"feedback":"ok"}}}`,
    );
    emitExit(0);
    emitClose(0);

    const result = await promise;
    expect(result.verdict).toEqual({ approved: true, feedback: "ok" });
  });

  // ── (h) Exit/close ordering ──────────────────────────────────────────

  it("captures late stdout data arriving between exit and close", async () => {
    const promise = spawnAgent(defaultOpts);

    emitStdout(
      `{"type":"message_end","message":{"content":[{"type":"text","text":"before exit"}]}}\n`,
    );
    emitExit(0);
    // stdout listener stays alive between exit and close; late data is captured
    emitStdout(
      `{"type":"message_end","message":{"content":[{"type":"text","text":"late line"}]}}\n`,
    );
    emitClose(0);

    const result = await promise;
    expect(result.lastAssistantText).toBe("late line");
    expect(result.exitCode).toBe(0);
  });
});
