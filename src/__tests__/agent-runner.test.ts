/**
 * Tests for the real AgentRunner adapter (§11, kb-17).
 *
 * Covers:
 *   - Arg assembly: --mode json -p, --session-dir <dir>, --extension <path>
 *   - FIX B1: --extension ALWAYS present, NO --no-session
 *   -- resumeSessionFile → --session flag added
 *   - Profile loading via resolveProfile + profileToArgs
 *   - Result mapping: success, failure, error, verdict, loopDetected
 *   - Session finding + renaming after spawn
 *   - artifact-dir --append-system-prompt present
 *   - childProcesses tracking (add on spawn, remove on close)
 *   - Empty profileName throws clear error
 *   - exitCode -1 (spawn error) skips session handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { SpawnResult } from "../spawner";
import type { Profile } from "../profiles";
import type { AgentDemand, AgentRunOptions, AgentRunResult, AgentRunner } from "../types";

// ── Hoisted mock state ───────────────────────────────────────────────────────
// Using vi.hoisted so mock factories and test code share the same references.

const {
  mockSpawnAgent,
  mockResolveProfile,
  mockProfileToArgs,
  mockFindSessionFileById,
  mockRenameSession,
  mockExecSync,
} = vi.hoisted(() => ({
  mockSpawnAgent: vi.fn<(opts: Record<string, unknown>) => Promise<SpawnResult>>(),
  mockResolveProfile: vi.fn<(name: string, cwd: string) => Profile>(),
  mockProfileToArgs: vi.fn<(profile: Profile) => { args: string[]; env: Record<string, string> }>(),
  mockFindSessionFileById: vi.fn<(sessionDir: string, sessionId: string) => string | undefined>(),
  mockRenameSession: vi.fn<(src: string, dir: string, name: string) => string>(),
  // Stands in for `which pi` inside resolvePiBinary(). Default impl (set in
  // beforeEach) reports `pi` as absent so binary resolution is deterministic
  // regardless of the host PATH.
  mockExecSync: vi.fn<(...args: unknown[]) => unknown>(),
}));

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../spawner", () => ({
  spawnAgent: mockSpawnAgent,
}));

vi.mock("../profiles", () => ({
  resolveProfile: mockResolveProfile,
  profileToArgs: mockProfileToArgs,
}));

// Keep buildSpawnSessionArgs real; mock findSessionFileById and renameSession.
vi.mock("../sessions", async () => {
  const actual = await vi.importActual<typeof import("../sessions")>("../sessions");
  return {
    ...actual,
    findSessionFileById: mockFindSessionFileById,
    renameSession: mockRenameSession,
  };
});

// Mock execSync (used by resolvePiBinary's `which pi`) so binary resolution is
// deterministic; everything else in node:child_process stays real (the
// ChildProcess type import is unaffected at runtime).
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execSync: mockExecSync,
  };
});

// ── SUT ──────────────────────────────────────────────────────────────────────

import { createRealAgentRunner, resolvePiBinary } from "../agent-runner";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockProc(): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as unknown as Record<string, unknown>).pid = 12_345;
  // Satisfy the ChildProcess shape minimally
  Object.defineProperty(proc, "stdout", { value: new EventEmitter(), writable: false });
  Object.defineProperty(proc, "stderr", { value: new EventEmitter(), writable: false });
  Object.defineProperty(proc, "stdin", {
    value: { write: vi.fn(), end: vi.fn(), readable: false, writable: true },
    writable: false,
  });
  return proc;
}

/** Extract the first spawnAgent call arguments into a plain object. */
function getSpawnOpts(): Record<string, unknown> {
  const lastCall = mockSpawnAgent.mock.lastCall;
  expect(lastCall).toBeDefined();
  return lastCall![0];
}

const defaultDemand: AgentDemand = {
  atomPath: "sequential[0].agent[0]",
  profileName: "coder",
  effectivePrompt: "Write unit tests for the module.",
  cwd: "/tmp/workdir",
  taskId: "t-1",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
};

const defaultRunOpts: AgentRunOptions = {
  sessionDir: "/tmp/sessions",
  poolId: "pool-1",
};

function createRunner(childProcesses?: Set<ChildProcess>): AgentRunner {
  return createRealAgentRunner({
    pi: {} as never,
    childProcesses: childProcesses ?? new Set(),
    extensionEntryPath: "/ext/entry.js",
  });
}

function successfulSpawnResult(overrides?: Partial<SpawnResult>): SpawnResult {
  return {
    exitCode: 0,
    stderr: "",
    lastAssistantText: "Some assistant output",
    verdict: undefined,
    loopDetected: false,
    durationMs: 1200,
    sessionId: "test-session-id",
    ...overrides,
  };
}

const defaultProfile: Profile = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  origin: "global",
};

const defaultProfileArgs = { args: ["--provider", "anthropic"], env: {} };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createRealAgentRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default `which pi` lookup reports `pi` as absent → deterministic binary
    // resolution for the runAgent tests below (see resolvePiBinary describe
    // block for tier-by-tier coverage).
    mockExecSync.mockImplementation(() => {
      throw new Error("spawn which ENOENT");
    });

    // Default mock implementations
    mockResolveProfile.mockReturnValue(defaultProfile);
    mockProfileToArgs.mockReturnValue(defaultProfileArgs);
    mockSpawnAgent.mockImplementation(async (opts: Record<string, unknown>) => {
      // If caller provided onSpawn, invoke it with a mock proc
      const onSpawn = opts.onSpawn as ((proc: ChildProcess) => void) | undefined;
      if (onSpawn) {
        onSpawn(createMockProc());
      }
      return successfulSpawnResult();
    });
    mockFindSessionFileById.mockReturnValue("/tmp/sessions/raw_session.jsonl");
    mockRenameSession.mockImplementation(
      (_src: string, dir: string, name: string) =>
        `${dir}/20260709T120000Z-${name.replace(/[^a-z0-9]+/g, "-")}.jsonl`,
    );
  });

  // ── (a) Arg assembly ───────────────────────────────────────────────────

  it("assembles args containing --mode json -p, --session-dir, and --extension", async () => {
    const runner = createRunner();

    await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const opts = getSpawnOpts();
    const args = opts.args as string[];

    // --mode json -p
    const modeIdx = args.indexOf("--mode");
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(args[modeIdx + 1]).toBe("json");
    expect(args).toContain("-p");

    // --session-dir <dir>
    expect(args).toContain("--session-dir");
    const sdirIdx = args.indexOf("--session-dir");
    expect(args[sdirIdx + 1]).toBe(defaultRunOpts.sessionDir);

    // FIX B1: --extension ALWAYS present, NO --no-session
    expect(args).toContain("--extension");
    const extIdx = args.indexOf("--extension");
    expect(args[extIdx + 1]).toBe("/ext/entry.js");
    expect(args).not.toContain("--no-session");
  });

  // ── (b) Profile --no-extensions cannot suppress --extension ──────────

  it("places --extension AFTER profile args so --no-extensions can't suppress it", async () => {
    const runner = createRunner();
    // Simulate a profile that emits --no-extensions
    mockProfileToArgs.mockReturnValue({ args: ["--no-extensions"], env: {} });

    await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const opts = getSpawnOpts();
    const args = opts.args as string[];

    // --no-extensions must appear before --extension
    const noExtIdx = args.indexOf("--no-extensions");
    const extIdx = args.indexOf("--extension");
    expect(noExtIdx).toBeGreaterThanOrEqual(0);
    expect(extIdx).toBeGreaterThanOrEqual(0);
    expect(extIdx).toBeGreaterThan(noExtIdx);
    // The --extension value must still be correct
    expect(args[extIdx + 1]).toBe("/ext/entry.js");
  });

  // ── (c) Resume session flag ────────────────────────────────────────────

  it("adds --session flag when demand.resumeSessionFile is set", async () => {
    const runner = createRunner();
    const demandWithResume: AgentDemand = {
      ...defaultDemand,
      resumeSessionFile: "/tmp/sessions/prev.jsonl",
    };

    await runner.runAgent(demandWithResume, defaultRunOpts);

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const opts = getSpawnOpts();
    const args = opts.args as string[];

    expect(args).toContain("--session");
    const sessionIdx = args.indexOf("--session");
    expect(args[sessionIdx + 1]).toBe("/tmp/sessions/prev.jsonl");
  });

  it("does NOT add --session flag when resumeSessionFile is absent", async () => {
    const runner = createRunner();

    await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const opts = getSpawnOpts();
    const args = opts.args as string[];

    expect(args).not.toContain("--session");
  });

  // ── (d) Profile loading ────────────────────────────────────────────────

  it("resolves profile via resolveProfile + profileToArgs", async () => {
    const runner = createRunner();

    await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(mockResolveProfile).toHaveBeenCalledWith("coder", defaultDemand.cwd);
    expect(mockProfileToArgs).toHaveBeenCalledWith(defaultProfile);
  });

  it("includes profile-derived args (--provider, --model) in the spawn args", async () => {
    const runner = createRunner();
    mockProfileToArgs.mockReturnValue({
      args: ["--provider", "anthropic", "--model", "claude-sonnet-4-5"],
      env: {},
    });

    await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const opts = getSpawnOpts();
    const args = opts.args as string[];

    expect(args).toContain("--provider");
    expect(args).toContain("anthropic");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-5");
  });

  it("merges profileEnv into process.env for the child", async () => {
    const runner = createRunner();
    mockProfileToArgs.mockReturnValue({ args: [], env: { PI_API_KEY: "sk-test" } });

    await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const opts = getSpawnOpts();
    const env = opts.env as Record<string, string>;
    // profileEnv should be present alongside process.env
    expect(env.PI_API_KEY).toBe("sk-test");
  });

  // ── (e) Success mapping ────────────────────────────────────────────────

  it("maps exitCode 0 + lastText → success:true + sessionFile set", async () => {
    const runner = createRunner();
    mockFindSessionFileById.mockReturnValue("/tmp/sessions/raw_abc.jsonl");
    mockRenameSession.mockReturnValue("/tmp/sessions/20260709T120000Z-sequential-0-agent-0.jsonl");

    const result: AgentRunResult = await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(result.success).toBe(true);
    expect(result.lastText).toBe("Some assistant output");
    expect(result.exitCode).toBe(0);
    expect(result.sessionFile).toBe("/tmp/sessions/20260709T120000Z-sequential-0-agent-0.jsonl");
    expect(result.error).toBeUndefined();
    expect(result.loopDetected).toBe(false);
  });

  it("sets success:true when exitCode 0 even if lastText is empty (H4)", async () => {
    // H4: a tool-only final turn (e.g. gate_verdict with terminate:true)
    // legitimately emits no trailing text and must NOT be misclassified as
    // a failure.
    mockSpawnAgent.mockResolvedValue(successfulSpawnResult({ lastAssistantText: "" }));
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.lastText).toBe("");
  });

  // ── (f) Failure mapping ────────────────────────────────────────────────

  it("maps non-zero exitCode → success:false + error from stderr", async () => {
    mockSpawnAgent.mockResolvedValue(
      successfulSpawnResult({
        exitCode: 1,
        stderr: "Something went wrong",
        lastAssistantText: "",
      }),
    );
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("Something went wrong");
    expect(result.lastText).toBe("");
  });

  it("maps exitCode null (force-resolved) → exitCode -1 in result", async () => {
    mockSpawnAgent.mockResolvedValue(
      successfulSpawnResult({
        exitCode: null,
        stderr: "killed",
        lastAssistantText: "",
      }),
    );
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(result.exitCode).toBe(-1);
    expect(result.success).toBe(false);
  });

  // ── Session handling ───────────────────────────────────────────────────

  it("skips session finding when exitCode is -1 (spawn error)", async () => {
    mockSpawnAgent.mockResolvedValue(
      successfulSpawnResult({
        exitCode: -1,
        lastAssistantText: "",
      }),
    );
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(result.sessionFile).toBeUndefined();
    expect(mockFindSessionFileById).not.toHaveBeenCalled();
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it("skips session finding when sessionId is undefined (no session header captured)", async () => {
    // N1: when the spawner didn't capture a session id (unexpected with a
    // real pi binary, but possible), we must NOT fall back to the racy
    // globally-newest heuristic — leave sessionFile undefined instead.
    mockSpawnAgent.mockResolvedValue(successfulSpawnResult({ sessionId: undefined }));
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(result.sessionFile).toBeUndefined();
    expect(mockFindSessionFileById).not.toHaveBeenCalled();
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  it("invokes findSessionFileById and renameSession on success", async () => {
    mockFindSessionFileById.mockReturnValue("/tmp/sessions/raw_xyz.jsonl");
    mockRenameSession.mockReturnValue("/tmp/sessions/20260709T120000Z-canonical.jsonl");
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    // findSessionFileById is called with the session id captured from the
    // spawn result (N1 — deterministic lookup by id, not globally-newest).
    expect(mockFindSessionFileById).toHaveBeenCalledWith(
      defaultRunOpts.sessionDir,
      "test-session-id",
    );
    expect(mockRenameSession).toHaveBeenCalledWith(
      "/tmp/sessions/raw_xyz.jsonl",
      defaultRunOpts.sessionDir,
      defaultDemand.atomPath,
    );
    expect(result.sessionFile).toBe("/tmp/sessions/20260709T120000Z-canonical.jsonl");
  });

  it("does not set sessionFile when findSessionFileById returns undefined", async () => {
    mockFindSessionFileById.mockReturnValue(undefined);
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(result.sessionFile).toBeUndefined();
    expect(mockRenameSession).not.toHaveBeenCalled();
  });

  // ── (g) renameSession error-handling ───────────────────────────────

  it("does not fail runAgent when renameSession throws", async () => {
    mockRenameSession.mockImplementation(() => {
      throw new Error("Permission denied");
    });
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    // The agent result should still be successful
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.lastText).toBe("Some assistant output");
    // sessionFile should be undefined (graceful degradation)
    expect(result.sessionFile).toBeUndefined();
  });

  // ── (h) artifact-dir --append-system-prompt ────────────────────────────

  it("includes --append-system-prompt with artifact dir instruction", async () => {
    const runner = createRunner();

    await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const opts = getSpawnOpts();
    const args = opts.args as string[];

    const appendIdx = args.indexOf("--append-system-prompt");
    expect(appendIdx).toBeGreaterThanOrEqual(0);
    expect(args[appendIdx + 1]).toMatch(/write.*artifacts/i);
  });

  // ── (i) childProcesses tracking (add on spawn, remove on close) ────────

  it("adds child process to childProcesses on spawn", async () => {
    const childProcesses = new Set<ChildProcess>();
    const runner = createRunner(childProcesses);

    await runner.runAgent(defaultDemand, defaultRunOpts);

    // The mock spawnAgent calls onSpawn with a mock proc → it should be in the set
    expect(childProcesses.size).toBe(1);
    const proc = childProcesses.values().next().value;
    expect((proc as unknown as Record<string, unknown>).pid).toBe(12_345);
  });

  it("removes child process from childProcesses on close", async () => {
    const childProcesses = new Set<ChildProcess>();
    const runner = createRunner(childProcesses);

    await runner.runAgent(defaultDemand, defaultRunOpts);

    // The proc should be in the set
    expect(childProcesses.size).toBe(1);
    const proc = childProcesses.values().next().value as ChildProcess;

    // Emit close → should be removed
    proc.emit("close");

    expect(childProcesses.size).toBe(0);
  });

  // ── (j) Verdict and loop detection passthrough ─────────────────────────

  it("passes through verdict from spawnAgent result", async () => {
    const verdict = { approved: false, feedback: "Needs more tests" };
    mockSpawnAgent.mockResolvedValue(successfulSpawnResult({ verdict }));
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(result.verdict).toEqual(verdict);
  });

  it("passes through loopDetected flag", async () => {
    mockSpawnAgent.mockResolvedValue(successfulSpawnResult({ loopDetected: true }));
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(result.loopDetected).toBe(true);
  });

  it("passes through durationMs", async () => {
    mockSpawnAgent.mockResolvedValue(successfulSpawnResult({ durationMs: 3400 }));
    const runner = createRunner();

    const result = await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(result.durationMs).toBe(3400);
  });

  // ── (k) Empty profileName ──────────────────────────────────────────────

  it("throws a clear error when demand.profileName is empty", async () => {
    const runner = createRunner();
    const demandNoProfile: AgentDemand = { ...defaultDemand, profileName: "" };

    await expect(runner.runAgent(demandNoProfile, defaultRunOpts)).rejects.toThrow(
      /no profile resolvable/,
    );
  });

  // ── (l) Signal passthrough ─────────────────────────────────────────────

  it("passes through abort signal to spawnAgent", async () => {
    const ac = new AbortController();
    const runner = createRunner();

    await runner.runAgent(defaultDemand, { ...defaultRunOpts, signal: ac.signal });

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const opts = getSpawnOpts();
    expect(opts.signal).toBe(ac.signal);
  });

  // ── (m) Binary resolution ──────────────────────────────────────────────
  //
  // Detailed tier-by-tier coverage lives in the `resolvePiBinary` describe
  // block below; these tests verify runAgent wires the resolved binary into
  // spawnAgent (command + argsPrefix prepended to the agent args). `which pi`
  // is mocked absent in beforeEach so argv[1] drives the result.

  it("uses process.execPath + argv[1] when argv[1] is a real fs path", async () => {
    const origArgv1 = process.argv[1] as string;
    // argv[1] must be a real filesystem path for the node heuristic tier
    const testEntry = join(tmpdir(), `pi-subagent-tasks-entry-${Date.now()}.js`);
    writeFileSync(testEntry, "");
    process.argv[1] = testEntry;
    try {
      const runner = createRunner();
      await runner.runAgent(defaultDemand, defaultRunOpts);

      expect(mockSpawnAgent).toHaveBeenCalledOnce();
      const opts = getSpawnOpts();
      expect(opts.command).toBe(process.execPath);
      const commandArgs = opts.args as string[];
      expect(commandArgs[0]).toBe(testEntry);
    } finally {
      process.argv[1] = origArgv1;
      rmSync(testEntry, { force: true });
    }
  });

  it("uses bare 'pi' command when running from bun virtual fs", async () => {
    const origArgv1 = process.argv[1] as string;
    process.argv[1] = "/$bunfs/some-virtual-path";

    try {
      const runner = createRunner();
      await runner.runAgent(defaultDemand, defaultRunOpts);

      expect(mockSpawnAgent).toHaveBeenCalledOnce();
      const opts = getSpawnOpts();
      expect(opts.command).toBe("pi");
    } finally {
      process.argv[1] = origArgv1;
    }
  });

  it("uses bare 'pi' command when argv[1] is undefined", async () => {
    const origArgv1 = process.argv[1] as string;
    // @ts-expect-error - testing undefined argv[1]
    process.argv[1] = undefined;

    try {
      const runner = createRunner();
      await runner.runAgent(defaultDemand, defaultRunOpts);

      expect(mockSpawnAgent).toHaveBeenCalledOnce();
      const opts = getSpawnOpts();
      expect(opts.command).toBe("pi");
    } finally {
      process.argv[1] = origArgv1;
    }
  });

  it("uses the `pi` resolved on PATH when no override is set", async () => {
    mockExecSync.mockImplementation(() => "/usr/local/bin/pi\n");
    const origArgv1 = process.argv[1] as string;
    // A real-ish path that would otherwise hit the node heuristic tier
    process.argv[1] = join(tmpdir(), "some-real-entry.js");
    try {
      const runner = createRunner();
      await runner.runAgent(defaultDemand, defaultRunOpts);

      expect(mockSpawnAgent).toHaveBeenCalledOnce();
      const opts = getSpawnOpts();
      expect(opts.command).toBe("/usr/local/bin/pi");
      const commandArgs = opts.args as string[];
      // No script prefix — agent args start at --mode
      expect(commandArgs[0]).toBe("--mode");
    } finally {
      process.argv[1] = origArgv1;
    }
  });

  // ── (n) cwd passthrough ────────────────────────────────────────────────

  it("passes demand.cwd as spawnAgent cwd", async () => {
    const runner = createRunner();
    await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const opts = getSpawnOpts();
    expect(opts.cwd).toBe(defaultDemand.cwd);
  });

  // ── (o) stdinPrompt passthrough ────────────────────────────────────────

  it("passes demand.effectivePrompt as stdinPrompt verbatim", async () => {
    const runner = createRunner();
    await runner.runAgent(defaultDemand, defaultRunOpts);

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const opts = getSpawnOpts();
    expect(opts.stdinPrompt).toBe(defaultDemand.effectivePrompt);
  });
});

// ── resolvePiBinary ──────────────────────────────────────────────────────────
//
// Unit tests for the deterministic binary-resolution helper, exercising each
// preference tier in isolation. `which pi` (execSync) and the binary-override
// env vars are fully controlled per test.

describe("resolvePiBinary", () => {
  // Snapshot of shared global state so each test runs in isolation.
  const origArgv1 = process.argv[1] as string;
  let origEnvTask: string | undefined;
  let origEnvBin: string | undefined;

  beforeEach(() => {
    origEnvTask = process.env.PI_TASK_POOLS_PI_BIN;
    origEnvBin = process.env.PI_BIN;
    delete process.env.PI_TASK_POOLS_PI_BIN;
    delete process.env.PI_BIN;
    process.argv[1] = origArgv1;
    mockExecSync.mockReset();
    // Default: `which pi` finds nothing on PATH.
    mockExecSync.mockImplementation(() => {
      throw new Error("spawn which ENOENT");
    });
  });

  afterEach(() => {
    if (origEnvTask === undefined) delete process.env.PI_TASK_POOLS_PI_BIN;
    else process.env.PI_TASK_POOLS_PI_BIN = origEnvTask;
    if (origEnvBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = origEnvBin;
    process.argv[1] = origArgv1;
  });

  it("PI_TASK_POOLS_PI_BIN env override wins over every other tier", () => {
    process.env.PI_TASK_POOLS_PI_BIN = "/override/pi";
    process.env.PI_BIN = "/secondary/pi";
    mockExecSync.mockImplementation(() => "/usr/local/bin/pi\n");

    expect(resolvePiBinary()).toEqual({ command: "/override/pi", argsPrefix: [] });
    // The override short-circuits before any PATH lookup.
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("PI_BIN is honoured as a secondary env override", () => {
    process.env.PI_BIN = "/secondary/pi";
    mockExecSync.mockImplementation(() => "/usr/local/bin/pi\n");

    expect(resolvePiBinary()).toEqual({ command: "/secondary/pi", argsPrefix: [] });
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("resolves `pi` on PATH when no env override is set", () => {
    mockExecSync.mockImplementation(() => "/usr/local/bin/pi\n");

    expect(resolvePiBinary()).toEqual({ command: "/usr/local/bin/pi", argsPrefix: [] });
    expect(mockExecSync).toHaveBeenCalledWith("which pi", expect.anything());
  });

  it("falls back to node <argv[1]> when pi is off PATH and argv[1] is a real path", () => {
    const tmp = join(tmpdir(), `pi-entry-${Date.now()}.mjs`);
    writeFileSync(tmp, "");
    process.argv[1] = tmp;
    try {
      expect(resolvePiBinary()).toEqual({
        command: process.execPath,
        argsPrefix: [tmp],
      });
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("skips the node heuristic when argv[1] is a bun virtual path", () => {
    process.argv[1] = "/$bunfs/some-virtual-path";
    expect(resolvePiBinary()).toEqual({ command: "pi", argsPrefix: [] });
  });

  it("skips the node heuristic when argv[1] is not a real fs path", () => {
    process.argv[1] = "/does/not/exist/entry.ts";
    expect(resolvePiBinary()).toEqual({ command: "pi", argsPrefix: [] });
  });

  it("returns bare 'pi' as the final fallback when argv[1] is undefined", () => {
    // @ts-expect-error - testing undefined argv[1]
    process.argv[1] = undefined;
    expect(resolvePiBinary()).toEqual({ command: "pi", argsPrefix: [] });
  });

  it("treats an empty `which pi` result as not-found", () => {
    mockExecSync.mockImplementation(() => "\n");
    process.argv[1] = "/$bunfs/x"; // force past the node heuristic too
    expect(resolvePiBinary()).toEqual({ command: "pi", argsPrefix: [] });
  });
});
