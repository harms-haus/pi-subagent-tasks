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
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRunTasksTool, type CreateRunTasksToolOptions } from "../run-tasks";
import type { AgentDemand, AgentRunResult, AgentRunner, ExecResult } from "../types";
import type { GitOps } from "../git-op";

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
    lsFiles: vi.fn().mockResolvedValue([]),
    revParseHead: vi.fn().mockResolvedValue("abc123def456abc123def456"),
    symbolicRefHead: vi.fn().mockResolvedValue("refs/heads/main"),
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
    checkoutIn: vi.fn().mockResolvedValue({
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
        // SOFT_RETRY_CAP = 5, default maxRetries = 2 (pool default).
        // Total failures needed: 6 per cycle × (maxRetries + 1) = 18.
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
        maxRetries: 0, // one L2-restart cycle → 6 failures → task-fail
      },
      undefined,
      undefined,
      ctx,
    );

    // Wait for fixed point — the task should be permanently failed.
    // Soft-retry cap is 5, so 6 failures exhaust L1, then maxRetries=0
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
});

// ── Smoke test stubs (require real pi binary; run manually) ────────────────

/**
 * Smoke test stubs for manual verification using the real `pi` binary.
 *
 * These tests require:
 *   - A real `pi` binary on $PATH
 *   - No `--no-session` flag set (S1, S2)
 *   - A real TUI or --mode json (S1, S2, S3)
 *   - The extension loaded via --extension injection (S4)
 *
 * To run:
 *   npx vitest run --no-coverage src/__tests__/integration.test.ts -t "S[1-4]"
 *
 * (describe.skip prevents them from running in CI)
 */
describe.skip("smoke test stubs (manual)", () => {
  it.todo(
    "S1: `pi --mode json -p --session-dir <tmp> <prompt>` writes a session " +
      "file FLAT (no `--<cwd>--` nesting) without `--no-session`",
  );

  it.todo(
    "S2: `--session <flat-abs-path> --session-dir <parent>` resumes without " +
      "MissingSessionCwdError and appends",
  );

  it.todo(
    "S3: renderResult with 100 rows has no built-in height-cap clipping " + "(manual visual check)",
  );

  it.todo(
    "S4: a spawned `pi -p` child can see + call gate_verdict (extension " +
      "loaded via --extension injection)",
  );
});
