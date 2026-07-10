/**
 * Integration tests for the run_tasks tool — e2e compose engine scenarios
 * with mock git and mock agent runner (§21, kb-26).
 *
 * Unlike run-tasks.test.ts which mocks the entire scheduler/pools/merge/state
 * layer, these tests import the REAL compose engine, scheduler, and merge
 * worker implementations and drive them through createRunTasksTool. Only
 * the GitOps and AgentRunner interfaces are mocked — the compose cursor
 * advancement, gateLoop state machine, retry logic, failure propagation,
 * prompt assembly, and merge pipeline all execute for real.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { execSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { Text } from "@earendil-works/pi-tui";

import { createRunTasksTool, type CreateRunTasksToolOptions } from "../run-tasks";
import { renderBoard } from "../render";
import { buildCursor } from "../cursor";
import type {
  AgentDemand,
  AgentRunResult,
  AgentRunner,
  ExecResult,
  PoolState,
  Status,
  TaskRuntime,
} from "../types";
import type { GitOps } from "../git-op";
import { createMockTheme } from "./helpers/mock-api";

// ── Temp repo management ──────────────────────────────────────────────────

const TEMP_DIRS: string[] = [];

/**
 * Create a temporary directory with a real git repository initialised with
 * one commit (user.email, user.name set). The directory is registered for
 * cleanup in afterAll.
 */
function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-pools-int-"));
  TEMP_DIRS.push(dir);
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m 'initial'", { cwd: dir, stdio: "pipe" });
  return dir;
}

afterAll(() => {
  for (const d of TEMP_DIRS) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── Mock GitOps factory ───────────────────────────────────────────────────

/**
 * Create a mock GitOps with sensible defaults for all integration test
 * scenarios. Individual methods can be overridden per-test via
 * `vi.mocked(gitOps.method).mockImplementation(...)`.
 *
 * All ref-mutating operations return `{ stdout: …, stderr: "", code: 0,
 * killed: false }`. Read-only operations return empty / zero values.
 * `gitExec` is set up with a default handler that returns success for the
 * basic probe commands the worktrees module calls.
 */
function createMockGitOps(): GitOps & { gitExec: ReturnType<typeof vi.fn> } {
  const gitExec = vi.fn((args: string[], _cwd?: string): Promise<ExecResult> => {
    const cmd = args.join(" ");
    if (cmd.includes("rev-parse --is-inside-work-tree")) {
      return Promise.resolve({
        stdout: "true\n",
        stderr: "",
        code: 0,
        killed: false,
      });
    }
    if (cmd.includes("worktree list --porcelain")) {
      return Promise.resolve({
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
      });
    }
    if (cmd.includes("rev-parse --git-common-dir")) {
      return Promise.resolve({
        stdout: `${_cwd ?? "."}/.git\n`,
        stderr: "",
        code: 0,
        killed: false,
      });
    }
    // Default: success with empty output
    return Promise.resolve({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    });
  });

  return {
    gitExec,
    lock: <T>(fn: () => Promise<T>) => fn(),
    statusPorcelain: vi.fn().mockResolvedValue(""),
    conflictedFiles: vi.fn().mockResolvedValue([]),
    worktreeList: vi.fn().mockResolvedValue([]),
    revParseHead: vi.fn().mockResolvedValue("abc123def456abc123def456"),
    worktreeAdd: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    worktreeRemove: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    worktreePrune: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    branchDelete: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    mergeFF: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    mergeAbort: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    commitAll: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
  };
}

// ── Mock API factory ──────────────────────────────────────────────────────

function createMockAPI() {
  return {
    registerTool: vi.fn(),
    on: vi.fn(),
    exec: vi.fn(),
    appendEntry: vi.fn(),
    registerMessageRenderer: vi.fn(),
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
}

// ── Tool options builder ────────────────────────────────────────────────────

function createToolOpts(overrides?: {
  agentRunner?: AgentRunner;
  gitOps?: GitOps;
}): CreateRunTasksToolOptions & { gitOps: GitOps } {
  const gitOps = overrides?.gitOps ?? createMockGitOps();
  const defaultRunner: AgentRunner = {
    runAgent: vi.fn().mockResolvedValue({
      success: true,
      lastText: "mock-output",
      exitCode: 0,
      durationMs: 0,
    } satisfies AgentRunResult),
  };

  return {
    getAgentRunner: () => overrides?.agentRunner ?? defaultRunner,
    getGitOps: () => gitOps,
    childProcesses: new Set(),
    gitOps,
  };
}

// ── Context helper ────────────────────────────────────────────────────────

function createContext(cwd: string) {
  return {
    cwd,
    mode: "tui",
    model: undefined,
    signal: undefined,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setToolsExpanded: vi.fn(),
      getToolsExpanded: vi.fn(() => false),
    },
    hasUI: false,
    sessionManager: {
      getBranch: vi.fn(() => []),
      getEntries: vi.fn(() => []),
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
}

/** Extract the text from a tool result (avoids repeated casts). */
function contentText(result: { content: Array<{ type?: string; text?: string }> }): string {
  const part = result.content[0];
  return part?.text ?? "";
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("integration tests (compose engine e2e)", () => {
  let cwd: string;
  let gitOps: ReturnType<typeof createMockGitOps>;
  let ctx: ReturnType<typeof createContext>;

  beforeEach(() => {
    cwd = createTempRepo();
    gitOps = createMockGitOps();
    ctx = createContext(cwd);
  });

  // ── Test 1: Full pool lifecycle ─────────────────────────────────────────

  it("runs 3 dependent tasks end-to-end (plan→tests→code)", async () => {
    const agentRunner: AgentRunner = {
      runAgent: vi.fn().mockResolvedValue({
        success: true,
        lastText: "mock-output",
        exitCode: 0,
        durationMs: 0,
      } satisfies AgentRunResult),
    };

    const pi = createMockAPI();
    const opts = createToolOpts({ agentRunner, gitOps });
    const tool = createRunTasksTool(pi, opts);

    const result = await tool.execute(
      "int-1",
      {
        name: "Full Lifecycle",
        tasks: [
          { id: "plan", prompt: "Plan the architecture" },
          { id: "tests", prompt: "Write tests", dependsOn: ["plan"] },
          { id: "code", prompt: "Implement", dependsOn: ["tests"] },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    // Summary should show all 3 done
    const text = contentText(result);
    expect(text).toContain("Pool: Full Lifecycle");
    expect(text).toContain("id: full-lifecycle");
    expect(text).toContain("3 done");
    expect(text).toContain("0 failed");
    expect(text).toContain("0 skipped");

    // All three agent calls were made
    expect(agentRunner.runAgent).toHaveBeenCalledTimes(3);

    // Tasks appear in the summary with checkmarks
    expect(text).toContain("✓ plan");
    expect(text).toContain("✓ tests");
    expect(text).toContain("✓ code");
  });

  // ── Test 2: Failure propagation ─────────────────────────────────────────

  it("propagates failures to dependent tasks", async () => {
    const callCount = new Map<string, number>();

    const agentRunner: AgentRunner = {
      runAgent: vi.fn(async (demand: AgentDemand) => {
        const path = demand.atomPath;
        const count = (callCount.get(path) ?? 0) + 1;
        callCount.set(path, count);

        // 'plan' agent always fails → exhaust all retry levels.
        // SOFT_RETRY_CAP = 4, default maxRetries = 2 (pool default).
        // Total failures needed: 5 per cycle × (maxRetries + 1) = 15.
        // To keep tests fast, we pass maxRetries: 0.
        if (demand.taskId === "plan") {
          return {
            success: false,
            lastText: "",
            exitCode: 1,
            durationMs: 0,
            error: "intentional failure",
          };
        }

        return {
          success: true,
          lastText: "mock-output",
          exitCode: 0,
          durationMs: 0,
        };
      }),
    };

    const pi = createMockAPI();
    const opts = createToolOpts({ agentRunner, gitOps });
    const tool = createRunTasksTool(pi, opts);

    const result = await tool.execute(
      "int-2",
      {
        name: "Failure Prop",
        tasks: [
          { id: "plan", prompt: "Plan the architecture" },
          { id: "tests", prompt: "Write tests", dependsOn: ["plan"] },
          { id: "code", prompt: "Implement", dependsOn: ["tests"] },
        ],
        maxRetries: 0, // one L2-restart cycle → 5 failures → task-fail
      },
      undefined,
      undefined,
      ctx,
    );

    // Wait for fixed point — the task should be permanently failed.
    // Soft-retry cap is 4, so 5 failures exhaust L1, then maxRetries=0
    // means no L2 retry → immediate L3 (task-fail).
    const text = contentText(result);
    expect(text).toContain("Pool: Failure Prop");
    expect(text).toContain("0 done");
    expect(text).toContain("1 failed");
    expect(text).toContain("2 skipped");

    // plan is genuinely failed
    expect(text).toContain("✗ plan");

    // tests and code are skipped due to transitive dependency failure
    expect(text).toContain("⊘ tests");
    expect(text).toContain("⊘ code");

    // N6 (§15): task_skipped audit events emitted for propagated tasks
    // so the audit log can distinguish a genuine failure from a transitive
    // skip. Read audit.jsonl and verify the events were written.
    const auditPath = join(cwd, ".pi", "task-pools", "failure-prop", "audit.jsonl");
    const auditContent = readFileSync(auditPath, "utf-8");
    const auditLines = auditContent
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const skippedIds = auditLines.filter((e) => e.type === "task_skipped").map((e) => e.taskId);
    expect(skippedIds).toContain("tests");
    expect(skippedIds).toContain("code");
    // plan was genuinely failed, not skipped.
    expect(skippedIds).not.toContain("plan");
  });

  // ── Test 3: gateLoop ────────────────────────────────────────────────────

  it("executes a gateLoop where the reviewer approves on the second iteration", async () => {
    const callCount = new Map<string, number>();

    const agentRunner: AgentRunner = {
      runAgent: vi.fn(async (demand: AgentDemand) => {
        const path = demand.atomPath;
        const count = (callCount.get(path) ?? 0) + 1;
        callCount.set(path, count);

        if (path.endsWith(".work")) {
          // Work agent always succeeds
          return {
            success: true,
            lastText: `work-output-iteration-${count}`,
            exitCode: 0,
            durationMs: 0,
          };
        }

        if (path.endsWith(".review")) {
          if (count === 1) {
            // First review: reject
            return {
              success: true,
              lastText: "Needs more detail",
              exitCode: 0,
              durationMs: 0,
              verdict: {
                approved: false,
                feedback: "Please add more detail to the plan",
              },
            };
          }
          // Second review: approve
          return {
            success: true,
            lastText: "Looks good now",
            exitCode: 0,
            durationMs: 0,
            verdict: {
              approved: true,
              feedback: "The plan is comprehensive",
            },
          };
        }

        return {
          success: true,
          lastText: "mock",
          exitCode: 0,
          durationMs: 0,
        };
      }),
    };

    const pi = createMockAPI();
    const opts = createToolOpts({ agentRunner, gitOps });
    const tool = createRunTasksTool(pi, opts);

    const result = await tool.execute(
      "int-3",
      {
        name: "GateLoop Test",
        tasks: [
          {
            id: "design",
            prompt: "Design the system architecture",
            compose: {
              type: "gateLoop",
              work: { type: "agent", title: "architect" },
              review: { type: "agent", title: "reviewer" },
              maxIterations: 3,
            },
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const text = contentText(result);
    expect(text).toContain("Pool: GateLoop Test");
    expect(text).toContain("1 done");
    expect(text).toContain("0 failed");

    // 4 agent calls: work(1) → review(1, reject) → work(2) → review(2, approve)
    expect(agentRunner.runAgent).toHaveBeenCalledTimes(4);
  });

  // ── Test 4: Concurrency limits ──────────────────────────────────────────

  it("limits concurrent agents to the total cap", async () => {
    // Use a mock that yields via setTimeout(0) so the scheduler's
    // tryAcquire/tryRelease flow operates with real concurrency tracking.
    let concurrentlyRunning = 0;
    let maxConcurrentlyRunning = 0;

    const agentRunner: AgentRunner = {
      runAgent: vi.fn(async (_demand: AgentDemand) => {
        concurrentlyRunning++;
        maxConcurrentlyRunning = Math.max(maxConcurrentlyRunning, concurrentlyRunning);
        await new Promise<void>((r) => setTimeout(r, 0));
        concurrentlyRunning--;
        return {
          success: true,
          lastText: "mock-output",
          exitCode: 0,
          durationMs: 0,
        };
      }),
    };

    const pi = createMockAPI();
    const opts = createToolOpts({ agentRunner, gitOps });
    const tool = createRunTasksTool(pi, opts);

    const result = await tool.execute(
      "int-4",
      {
        name: "Concurrency",
        tasks: [
          { id: "t1", prompt: "Task 1" },
          { id: "t2", prompt: "Task 2" },
          { id: "t3", prompt: "Task 3" },
          { id: "t4", prompt: "Task 4" },
          { id: "t5", prompt: "Task 5" },
        ],
        limits: { total: 2 },
      },
      undefined,
      undefined,
      ctx,
    );

    const text = contentText(result);
    expect(text).toContain("5 done");

    // The mock runner was called exactly 5 times (one per task).
    expect(agentRunner.runAgent).toHaveBeenCalledTimes(5);

    // At no point did more than `total` (2) agents run concurrently.
    expect(maxConcurrentlyRunning).toBeLessThanOrEqual(2);
  });

  // ── Test 5: Compose integration ─────────────────────────────────────────

  it("runs sequential([parallel([r1,r2,r3]), summarize]) with correct flow context", async () => {
    const capturedDemands: AgentDemand[] = [];

    const agentRunner: AgentRunner = {
      runAgent: vi.fn(async (demand: AgentDemand) => {
        capturedDemands.push(demand);
        return {
          success: true,
          lastText: `output-from-${demand.atomPath}`,
          exitCode: 0,
          durationMs: 0,
        };
      }),
    };

    const pi = createMockAPI();
    const opts = createToolOpts({ agentRunner, gitOps });
    const tool = createRunTasksTool(pi, opts);

    await tool.execute(
      "int-5",
      {
        name: "Compose Integration",
        tasks: [
          {
            id: "main",
            prompt: "Write a report on system architecture",
            compose: {
              type: "sequential",
              atoms: [
                {
                  type: "parallel",
                  atoms: [
                    { type: "agent", title: "Researcher" },
                    { type: "agent", title: "Analyst" },
                    { type: "agent", title: "Writer" },
                  ],
                },
                { type: "agent", title: "Editor" },
              ],
            },
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    // ── Verify agent demand structure ────────────────────────────────
    // The compose tree creates paths:
    //   "0.0.0"  — Researcher  (parallel child 0)
    //   "0.0.1"  — Analyst     (parallel child 1)
    //   "0.0.2"  — Writer      (parallel child 2)
    //   "0.1"    — Editor      (sequential child 1)

    const researcher = capturedDemands.find((d) => d.atomPath === "0.0.0");
    const analyst = capturedDemands.find((d) => d.atomPath === "0.0.1");
    const writer = capturedDemands.find((d) => d.atomPath === "0.0.2");
    const editor = capturedDemands.find((d) => d.atomPath === "0.1");

    expect(researcher).toBeDefined();
    expect(analyst).toBeDefined();
    expect(writer).toBeDefined();
    expect(editor).toBeDefined();

    // All 4 agents were called
    expect(agentRunner.runAgent).toHaveBeenCalledTimes(4);

    // ── Parallel agents receive only the task prompt (no flow context) ─
    const basePrompt = "Write a report on system architecture";
    expect(researcher!.effectivePrompt).toBe(basePrompt);
    expect(analyst!.effectivePrompt).toBe(basePrompt);
    expect(writer!.effectivePrompt).toBe(basePrompt);

    // ── Editor receives the headed concatenation of all parallel outputs ─
    const editorPrompt = editor!.effectivePrompt;

    // Each parallel output is prefixed with its title:
    expect(editorPrompt).toContain("Researcher");
    expect(editorPrompt).toContain("Analyst");
    expect(editorPrompt).toContain("Writer");

    // Each parallel output contains its atom's actual output:
    expect(editorPrompt).toContain("output-from-0.0.0");
    expect(editorPrompt).toContain("output-from-0.0.1");
    expect(editorPrompt).toContain("output-from-0.0.2");

    // The flow separator (---) separates the headed concatenation from the
    // task prompt:
    expect(editorPrompt).toContain("---");
    expect(editorPrompt).toContain(basePrompt);
  });

  // ── Test 6: Resume ──────────────────────────────────────────────────────

  it("resumes a completed pool from persisted state", async () => {
    const pi = createMockAPI();
    const opts = createToolOpts({ gitOps });
    const tool = createRunTasksTool(pi, opts);

    // Step 1: Create and complete a pool.
    const result1 = await tool.execute(
      "int-6a",
      {
        name: "Resume Me",
        tasks: [
          { id: "a", prompt: "Task A" },
          { id: "b", prompt: "Task B", dependsOn: ["a"] },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    const text1 = contentText(result1);
    expect(text1).toContain("2 done");

    // Verify state.json exists on disk.
    const stateFile = join(cwd, ".pi", "task-pools", "resume-me", "state.json");
    expect(existsSync(stateFile)).toBe(true);

    // Step 2: Create a fresh tool instance and resume the same pool.
    const freshPi = createMockAPI();
    const freshOpts = createToolOpts({ gitOps });
    const freshTool = createRunTasksTool(freshPi, freshOpts);

    const result2 = await freshTool.execute(
      "int-6b",
      { resume: "resume-me" },
      undefined,
      undefined,
      ctx,
    );

    const text2 = contentText(result2);
    expect(text2).toContain("Pool: Resume Me");
    expect(text2).toContain("id: resume-me");
    // The pool was already done — resume should report the same terminal state.
    expect(text2).toContain("2 done");
    expect(text2).toContain("✓ a");
    expect(text2).toContain("✓ b");
  });

  // ── Test 7: Resume after an abort in the merge window (N2a) ─────────────

  it("resumes a pool that was aborted mid-merge without hanging", async () => {
    const pi = createMockAPI();
    const opts = createToolOpts({ gitOps });
    const tool = createRunTasksTool(pi, opts);

    // Step 1: Create and complete a single-task pool.
    const result1 = await tool.execute(
      "int-7a",
      {
        name: "Mid Merge",
        tasks: [{ id: "solo", prompt: "Task solo" }],
      },
      undefined,
      undefined,
      ctx,
    );

    const text1 = contentText(result1);
    expect(text1).toContain("1 done");

    // Verify state.json exists on disk.
    const stateFile = join(cwd, ".pi", "task-pools", "mid-merge", "state.json");
    expect(existsSync(stateFile)).toBe(true);

    // Step 2: Simulate an abort in the merge window. Read the persisted
    // state and mutate it so the task looks like its atoms completed but
    // the merge never marked it done:
    //   - cursor stays structurally complete (state: "done")
    //   - status rewound to "running"
    //   - worktreePath set to null (worktree already removed by a
    //     successful merge+cleanup, but persisted status lagged)
    //   - mergeQueue cleared
    // This is exactly the N2a window: isComposeComplete(cursor) === true
    // but status !== "done".
    const rawState = JSON.parse(readFileSync(stateFile, "utf-8")) as PoolState;
    const soloTask = rawState.tasks.find((t) => t.id === "solo");
    expect(soloTask).toBeDefined();
    expect(soloTask!.cursor.state).toBe("done");
    soloTask!.status = "running";
    soloTask!.worktreePath = null;
    rawState.mergeQueue = [];
    writeFileSync(stateFile, JSON.stringify(rawState, null, 2), "utf-8");

    // Step 3: Resume with a fresh tool instance. The N2a reconciliation in
    // run-tasks.ts should detect the completed-but-unmerged task (worktree
    // already gone) and set it straight to "done" so the pool reaches a
    // fixed point instead of hanging.
    const freshPi = createMockAPI();
    const freshOpts = createToolOpts({ gitOps });
    const freshTool = createRunTasksTool(freshPi, freshOpts);

    // Race the resume against a timeout so a regression (missing
    // reconciliation) turns into a test failure, not a hung suite.
    const result2 = await Promise.race([
      freshTool.execute("int-7b", { resume: "mid-merge" }, undefined, undefined, ctx),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error("resume after mid-merge abort timed out (N2a hang)"));
        }, 15_000),
      ),
    ]);

    const text2 = contentText(result2);
    expect(text2).toContain("Pool: Mid Merge");
    // The task reconciled back to done — the pool completes.
    expect(text2).toContain("1 done");
    expect(text2).toContain("✓ solo");
    expect(text2).not.toContain("0 done");
  });
});

// ── Smoke-test infrastructure (opt-in; §21) ───────────────────────────────

/**
 * Resolve the pi binary for opt-in smoke tests. Honours an explicit `PI_BIN`
 * env override; otherwise probes `$PATH` via `command -v`/`which`. Returns
 * `null` when no binary is available so the smoke tests skip cleanly.
 */
function resolvePiBin(): string | null {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  try {
    const out = execSync("command -v pi 2>/dev/null || which pi 2>/dev/null", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Whether an LLM provider API key appears to be set. The smoke tests that
 * spawn a real `pi` run drive a live model, so they need a key in addition to
 * the binary.
 */
function hasApiKey(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.AZURE_OPENAI_API_KEY,
  );
}

const PI_BIN = resolvePiBin();
/** S1/S2/S4 need both a real `pi` binary and an LLM API key. */
const CAN_SMOKE = PI_BIN !== null && hasApiKey();

/** Result of an opt-in `pi` smoke run. */
interface PiRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Parsed JSON event lines from stdout. */
  events: Array<Record<string, unknown>>;
}

/**
 * Spawn the pi binary, feed it a prompt via stdin, and collect stdout/stderr
 * plus parsed JSON events. Resolves on process exit or after `timeoutMs`
 * (the child is SIGKILL'd on timeout so the test never hangs).
 */
function runPi(
  bin: string,
  args: string[],
  opts: { stdinPrompt?: string; cwd?: string; timeoutMs?: number },
): Promise<PiRunResult> {
  return new Promise<PiRunResult>((resolve) => {
    const proc = spawn(bin, args, {
      cwd: opts.cwd ?? process.cwd(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const events: Array<Record<string, unknown>> = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          events.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // non-JSON line (e.g. a stray log) — ignore
        }
      }
      resolve({ exitCode, stdout, stderr, events });
    };

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // process may already have exited
      }
      finish(null);
    }, opts.timeoutMs ?? 120_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      finish(code ?? null);
    });
    proc.on("error", () => {
      finish(-1);
    });

    if (opts.stdinPrompt !== undefined) {
      proc.stdin.write(opts.stdinPrompt);
    }
    proc.stdin.end();
  });
}

/** Recursively collect every `*.jsonl` file under `dir`. */
function findSessionFiles(dir: string): string[] {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push(full);
      }
    }
  }
  return found;
}

// ── Smoke-test data helpers (pure; used by S3) ────────────────────────────

/** Build a minimal {@link TaskRuntime} for board-render assertions. */
function makeSmokeTask(id: string, status: Status): TaskRuntime {
  const cursor = buildCursor(undefined, id);
  if (status === "done") cursor.state = "done";
  return {
    id,
    prompt: "smoke",
    dependsOn: [],
    compose: { type: "agent" },
    cursor,
    status,
    retryCount: 0,
    runningAgentCount: 0,
    worktreePath: `/tmp/wt/${id}`,
    branch: `pi-task-pool/${id}`,
    sessionFiles: [],
    downstreamCount: 0,
  };
}

/** Build a minimal {@link PoolState} wrapping the given tasks. */
function makeSmokePool(tasks: TaskRuntime[]): PoolState {
  return {
    id: "smoke-pool",
    name: "Smoke Pool",
    branch: "pi-task-pool/smoke",
    poolWorktree: "/tmp/pi-task-pool/smoke",
    baseBranch: "main",
    limits: { total: 4, provider: {}, model: {} },
    maxRetries: 2,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    status: "running",
    tasks,
    mergeQueue: [],
  };
}

// ── Smoke tests (opt-in: set PI_BIN + an LLM API key) ──────────────────────

/**
 * Real implementations of the §21 smoke tests.
 *
 * S1/S2/S4 spawn the actual `pi` binary and drive a live model, so they only
 * execute when BOTH the `PI_BIN` binary is resolvable AND an LLM API key is
 * present — otherwise they skip cleanly. S3 is a pure render assertion and
 * always runs.
 *
 * To run the live tests:
 *   PI_BIN=$(which pi) ANTHROPIC_API_KEY=... \
 *     npx vitest run src/__tests__/integration.test.ts -t "S[1-4]"
 */
describe("smoke tests (opt-in: set PI_BIN + an LLM API key)", () => {
  // ── S3: pure render assertion (no pi binary needed) ──────────────────

  it("S3: renderBoard renders all 100 tasks in expanded mode (no hard height cap)", () => {
    const tasks = Array.from({ length: 100 }, (_, i) => makeSmokeTask(`task-${i}`, "done"));
    const pool = makeSmokePool(tasks);
    const theme = createMockTheme();

    const container = renderBoard(pool, { expanded: true, isPartial: false }, theme);

    const rows = container.children.filter((c): c is Text => c instanceof Text);
    const rendered = rows.map((r) => r.render(80)[0] ?? "").join("\n");

    // COLLAPSED_ROW_CAP (20) must NOT clip the board in expanded mode — every
    // one of the 100 task ids must appear in the rendered output.
    for (let i = 0; i < 100; i++) {
      expect(rendered).toContain(`task-${i}`);
    }
  });

  // ── S1: session file persistence in -p/--mode json (no --no-session) ──

  (CAN_SMOKE ? it : it.skip)(
    "S1: -p/--mode json persists a session file to --session-dir (no --no-session)",
    { timeout: 180_000 },
    async () => {
      const sessionDir = mkdtempSync(join(tmpdir(), "pi-smoke-s1-"));
      TEMP_DIRS.push(sessionDir);

      const result = await runPi(
        PI_BIN as string,
        ["--mode", "json", "-p", "--session-dir", sessionDir],
        { stdinPrompt: "Reply with exactly: ok", timeoutMs: 150_000 },
      );

      // pi ran cleanly and persisted a `.jsonl` session file under the dir.
      expect(result.exitCode).toBe(0);
      const sessions = findSessionFiles(sessionDir);
      expect(sessions.length).toBeGreaterThan(0);
    },
  );

  // ── S2: resume-by-path appends without a session-cwd mismatch ────────

  (CAN_SMOKE ? it : it.skip)(
    "S2: --session <flat-path> resumes without a cwd mismatch and appends",
    { timeout: 240_000 },
    async () => {
      const sessionDir = mkdtempSync(join(tmpdir(), "pi-smoke-s2-"));
      TEMP_DIRS.push(sessionDir);

      // 1. Produce a session file (nested or flat — we search recursively).
      const first = await runPi(
        PI_BIN as string,
        ["--mode", "json", "-p", "--session-dir", sessionDir],
        { stdinPrompt: "Reply with exactly: first", timeoutMs: 150_000 },
      );
      expect(first.exitCode).toBe(0);
      const sessions = findSessionFiles(sessionDir);
      expect(sessions.length).toBeGreaterThan(0);

      // 2. Flatten to a stable path — resume-by-path, §11/§12.
      const flatPath = join(sessionDir, "resumed.jsonl");
      copyFileSync(sessions[0]!, flatPath);
      const sizeBefore = statSync(flatPath).size;

      // 3. Resume from the flat path with a follow-up prompt.
      const second = await runPi(
        PI_BIN as string,
        ["--mode", "json", "-p", "--session-dir", sessionDir, "--session", flatPath],
        { stdinPrompt: "Reply with exactly: second", timeoutMs: 150_000 },
      );

      // No session-cwd mismatch error; clean exit.
      expect(second.exitCode).toBe(0);
      expect(second.stderr).not.toMatch(/MissingSessionCwdError/i);
      expect(second.stderr).not.toMatch(/session[\s\S]*cwd[\s\S]*mismatch/i);

      // 4. The resumed file grew/appended (compaction/auto-save didn't relocate).
      const sizeAfter = statSync(flatPath).size;
      expect(sizeAfter).toBeGreaterThan(sizeBefore);
    },
  );

  // ── S4: gate_verdict visible + callable by a spawned child ───────────

  (CAN_SMOKE ? it : it.skip)(
    "S4: a spawned pi -p child can see + call gate_verdict (result.details.approved is boolean)",
    { timeout: 180_000 },
    async () => {
      // Absolute path to this extension's entry module (loaded via --extension).
      const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

      const result = await runPi(
        PI_BIN as string,
        ["--mode", "json", "-p", "--extension", extensionPath],
        {
          stdinPrompt:
            "Call the gate_verdict tool now with approved=true and feedback='smoke test'. " +
            "Do not do anything else.",
          timeoutMs: 150_000,
        },
      );

      expect(result.exitCode).toBe(0);

      const gateEvents = result.events.filter(
        (e) => e.type === "tool_execution_end" && e.toolName === "gate_verdict",
      );
      // gate_verdict MUST be visible to the spawned child — if it isn't, this
      // fails (the whole point of the smoke test, §21 / finding C1).
      expect(gateEvents.length).toBeGreaterThan(0);

      // The verdict is nested under `result.details` (AgentToolResult<T> shape).
      const firstEvent = gateEvents[0]!;
      const eventResult = firstEvent.result as Record<string, unknown> | undefined;
      const details = eventResult?.details as Record<string, unknown> | undefined;
      expect(typeof details?.approved).toBe("boolean");
    },
  );
});
