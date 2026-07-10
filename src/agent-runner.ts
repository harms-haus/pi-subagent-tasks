/**
 * Real AgentRunner adapter for pi-task-pools.
 *
 * @module agent-runner
 *
 * Swaps real spawner/profiles/sessions into the {@link AgentRunner} seam so
 * the scheduler, atoms, and retry logic can spawn actual pi-agent subprocesses
 * without modification.
 *
 * Key design decisions:
 *   - FIX B1 (CRITICAL): `--extension <entryPath>` is ALWAYS injected so
 *     every spawned child loads the `gate_verdict` tool (§9).
 *   - Binary resolution: when running from a real script (not bun virtual fs),
 *     the runner re-executes via `node <script>` to preserve the extension
 *     environment; otherwise it falls back to the `pi` CLI.
 *   - An artifact-directive `--append-system-prompt` is unconditionally added
 *     to encourage writing run artifacts to the pool's `artifacts/` directory.
 *   - Session finding/renaming is handled after spawn completes.
 *
 * See §11 (agent spawning) and the AgentRunner interface in types.ts.
 */

import { type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { spawnAgent } from "./spawner";
import { resolveProfile, profileToArgs } from "./profiles";
import { buildSpawnSessionArgs, findSessionFile, renameSession } from "./sessions";
import type { AgentRunner, AgentDemand, AgentRunOptions, AgentRunResult } from "./types";

// ── Options for createRealAgentRunner ────────────────────────────────────────

/**
 * Options for {@link createRealAgentRunner}.
 */
export interface RealAgentRunnerOptions {
  /** The pi extension API (used for integration points). */
  pi: ExtensionAPI;
  /**
   * Mutable set of all tracked child processes. The runner adds proc on spawn
   * and removes on close. The caller (e.g. pool lifecycle) can iterate or
   * abort the set during shutdown.
   */
  childProcesses: Set<ChildProcess>;
  /**
   * Absolute path to the extension's entry module. Injected as
   * `--extension <entryPath>` to ensure the `gate_verdict` tool is loaded
   * by every spawned agent session (FIX B1).
   */
  extensionEntryPath: string;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a real {@link AgentRunner} that spawns pi-agent subprocesses using
 * the live spawner, profiles, and sessions modules.
 *
 * @param opts - Configuration including the pi API, child-process tracking
 *               set, and the extension entry path.
 * @returns An {@link AgentRunner} whose `runAgent` method drives a real
 *          subprocess lifecycle.
 */
export function createRealAgentRunner(opts: RealAgentRunnerOptions): AgentRunner {
  return {
    async runAgent(demand: AgentDemand, runOpts: AgentRunOptions): Promise<AgentRunResult> {
      // 1. Resolve profile and convert to CLI args / env
      const profileName = demand.profileName;
      if (!profileName) {
        throw new Error("no profile resolvable");
      }
      const profile = resolveProfile(profileName, demand.cwd);
      const { args: profileArgs, env: profileEnv } = profileToArgs(profile);

      // 2. Build session-dir arguments (always --session-dir, optionally --session)
      const sessionArgs = buildSpawnSessionArgs(runOpts.sessionDir, demand.resumeSessionFile);

      // 3. Assemble the full arg list
      //    FIX B1: --extension is ALWAYS injected so gate_verdict is loaded
      //    and is placed AFTER ...profileArgs so a profile's --no-extensions
      //    (last-wins) cannot suppress it.
      const args = [
        "--mode",
        "json",
        "-p",
        ...sessionArgs,
        ...profileArgs,
        "--extension",
        opts.extensionEntryPath,
        "--append-system-prompt",
        "Write any run artifacts to the pool's artifacts/ directory (rare).",
      ];

      // 4. Binary resolution: use `node <script>` when running from a real
      //    filesystem script, else fall back to the bare `pi` CLI.
      const argv1 = process.argv[1];
      const scriptPath =
        typeof argv1 === "string" && argv1 && !argv1.startsWith("/$bunfs/") ? argv1 : null;
      const command = scriptPath ? process.execPath : "pi";
      const commandArgs = scriptPath ? [scriptPath, ...args] : args;

      // 5. Spawn the agent
      const result = await spawnAgent({
        command,
        args: commandArgs,
        env: { ...(process.env as Record<string, string>), ...profileEnv },
        stdinPrompt: demand.effectivePrompt,
        cwd: demand.cwd,
        signal: runOpts.signal,
        // Track the child process in the managed set
        onSpawn(proc: ChildProcess) {
          opts.childProcesses.add(proc);
          proc.on("close", () => {
            opts.childProcesses.delete(proc);
          });
        },
      });

      // 6. Find and rename the session file (only when a real process ran)
      let sessionFile: string | undefined;
      if (result.exitCode !== -1) {
        const found = findSessionFile(runOpts.sessionDir);
        if (found) {
          try {
            sessionFile = renameSession(found, runOpts.sessionDir, demand.atomPath);
          } catch (err) {
            console.warn(
              "[agent-runner] renameSession failed for %s: %s",
              found,
              (err as Error).message,
            );
            // Leave sessionFile undefined — the raw file still exists.
          }
        }
      }

      // 7. Map SpawnResult → AgentRunResult
      return {
        success: result.exitCode === 0 && result.lastAssistantText.length > 0,
        lastText: result.lastAssistantText,
        sessionFile,
        exitCode: result.exitCode ?? -1,
        error: result.exitCode !== 0 && result.exitCode !== null ? result.stderr : undefined,
        verdict: result.verdict,
        durationMs: result.durationMs,
        loopDetected: result.loopDetected,
      };
    },
  };
}
