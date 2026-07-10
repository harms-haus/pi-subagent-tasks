/**
 * Real AgentRunner adapter for pi-subagent-tasks.
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
 *   - Binary resolution: a deterministic `resolvePiBinary()` helper selects
 *     the spawn target with the preference order env override → `which pi` →
 *     `node <argv[1]>` (real fs path only) → bare `pi`.
 *   - An artifact-directive `--append-system-prompt` is unconditionally added
 *     to encourage writing run artifacts to the pool's `artifacts/` directory.
 *   - Session finding/renaming is handled after spawn completes.
 *
 * See §11 (agent spawning) and the AgentRunner interface in types.ts.
 */

import { execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { spawnAgent } from "./spawner";
import { resolveProfile, profileToArgs } from "./profiles";
import { buildSpawnSessionArgs, findSessionFileById, renameSession } from "./sessions";
import type { AgentRunner, AgentDemand, AgentRunOptions, AgentRunResult } from "./types";

// ── Binary resolution ────────────────────────────────────────────────────────

/**
 * A resolved spawn target.
 *
 * For the `node <script>` case `command` is `process.execPath` and
 * `argsPrefix` holds the entry-script path; for every other case `command` is
 * the binary string to exec and `argsPrefix` is empty (the real agent args
 * are appended by the caller).
 */
export interface ResolvedBinary {
  command: string;
  argsPrefix: string[];
}

/**
 * Resolve `pi` on PATH via `which pi`. Returns the absolute path reported by
 * `which`, or `null` when the binary is absent or `which` itself is
 * unavailable. The lookup is wrapped in try/catch so a missing `pi` degrades
 * gracefully instead of throwing.
 */
function whichPi(): string | null {
  try {
    const out = execSync("which pi", { stdio: ["ignore", "pipe", "ignore"] });
    const resolved = out.toString().trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Deterministically resolve the pi binary to spawn, using this preference
 * order:
 *
 * 1. Explicit override via `PI_TASK_POOLS_PI_BIN` (then `PI_BIN`).
 * 2. `pi` located on PATH (`which pi`).
 * 3. The `node <process.argv[1]>` heuristic — but only when `argv[1]` is a
 *    real filesystem path (not the bun virtual fs).
 * 4. The bare string `"pi"` as a final fallback.
 *
 * Exported so the §21 smoke-test suite can reuse the same resolution logic.
 */
export function resolvePiBinary(): ResolvedBinary {
  // 1. Explicit env override
  const override = process.env.PI_TASK_POOLS_PI_BIN ?? process.env.PI_BIN;
  if (override) {
    return { command: override, argsPrefix: [] };
  }

  // 2. `pi` on PATH
  const onPath = whichPi();
  if (onPath) {
    return { command: onPath, argsPrefix: [] };
  }

  // 3. node <argv[1]> heuristic — only when argv[1] is a real fs path
  const argv1 = process.argv[1];
  if (typeof argv1 === "string" && argv1 && !argv1.startsWith("/$bunfs/") && existsSync(argv1)) {
    return { command: process.execPath, argsPrefix: [argv1] };
  }

  // 4. Final fallback
  return { command: "pi", argsPrefix: [] };
}

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

      // 4. Binary resolution: deterministic preference order (env override →
      //    `which pi` → node <argv[1]> heuristic → bare "pi").
      const { command, argsPrefix } = resolvePiBinary();
      const commandArgs = [...argsPrefix, ...args];

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

      // 6. Find and rename the session file by its session id (only when a
      //    real process ran AND we captured the session id from the
      //    `type:"session"` header). Locating by id is deterministic and
      //    avoids the racy "globally newest" heuristic that misattributes
      //    files under concurrency (N1). When the id is absent (unexpected
      //    with a real pi binary) we leave sessionFile undefined rather than
      //    guessing.
      let sessionFile: string | undefined;
      if (result.exitCode !== -1 && result.sessionId !== undefined) {
        const found = findSessionFileById(runOpts.sessionDir, result.sessionId);
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
      //
      // Success = clean exit (0) without a loop-detection kill or null exit
      // (killed/aborted). We deliberately do NOT gate on non-empty
      // lastAssistantText: a tool-only final turn (e.g. gate_verdict with
      // terminate:true) legitimately emits no trailing text and should not be
      // misclassified as a failure (H4).
      return {
        success: result.exitCode === 0 && !result.loopDetected,
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
