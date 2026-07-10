import { vi } from "vitest";

import type {
  AgentDemand,
  AgentRunOptions,
  AgentRunResult,
  AgentRunner,
  ExecResult,
} from "../../types";

/**
 * A mock {@link AgentRunner} exposing extra test-only knobs. It implements the
 * real interface so it can be passed anywhere the scheduler expects an
 * `AgentRunner`, while tests can drive outcomes via `setResult` /
 * `setResultFn`.
 */
export interface MockAgentRunner extends AgentRunner {
  /** Every demand ever passed to `runAgent`, in call order. */
  received: AgentDemand[];
  /** Every opts object ever passed to `runAgent`, in call order. */
  receivedOpts: AgentRunOptions[];
  /** Override the result returned for a specific `atomPath`. */
  setResult(atomPath: string, result: Partial<AgentRunResult>): void;
  /** Install a function that computes every result (overrides per-path map). */
  setResultFn(fn: (demand: AgentDemand, opts: AgentRunOptions) => AgentRunResult): void;
}

/**
 * Creates a mock {@link AgentRunner} for engine tests.
 *
 * - By default each run returns a successful result keyed by `demand.atomPath`.
 * - Per-path overrides are merged over a sensible default via {@link MockAgentRunner.setResult}.
 * - A global override fn (via {@link MockAgentRunner.setResultFn}) wins over the per-path map.
 * - Every demand/opts pair passed to `runAgent` is recorded in
 *   {@link MockAgentRunner.received} / {@link MockAgentRunner.receivedOpts}.
 * - A failing override (`success: false`) with no explicit `exitCode` defaults to `exitCode: 1`.
 */
export function createMockAgentRunner(): MockAgentRunner {
  const received: AgentDemand[] = [];
  const receivedOpts: AgentRunOptions[] = [];
  const results = new Map<string, Partial<AgentRunResult>>();
  let fn: ((demand: AgentDemand, opts: AgentRunOptions) => AgentRunResult) | undefined;

  const runner: MockAgentRunner = {
    received,
    receivedOpts,
    setResult(atomPath, result) {
      results.set(atomPath, result);
    },
    setResultFn(next) {
      fn = next;
    },
    async runAgent(demand: AgentDemand, opts: AgentRunOptions): Promise<AgentRunResult> {
      received.push(demand);
      receivedOpts.push(opts);
      if (fn) return fn(demand, opts);
      const override = results.get(demand.atomPath);
      const base: AgentRunResult = {
        success: true,
        lastText: `mock-output-for-${demand.atomPath}`,
        exitCode: 0,
        durationMs: 0,
      };
      const merged: AgentRunResult = { ...base, ...override };
      // A failing result without an explicit exit code must not report 0.
      if (override && override.success === false && override.exitCode === undefined) {
        merged.exitCode = 1;
      }
      return merged;
    },
  };

  return runner;
}

/**
 * Creates a mock git exec function. Returns a successful empty `ExecResult`
 * by default; tests override per-command via `mockImplementation`.
 */
export function createMockGitExec() {
  return vi.fn<(...args: unknown[]) => ExecResult>(() => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
  }));
}
