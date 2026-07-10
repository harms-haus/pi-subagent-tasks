/**
 * pi-task-pools extension entry — factory for run_tasks + gate_verdict tools.
 *
 * @module index
 *
 * Registers the `run_tasks` and `gate_verdict` tools with the pi extension API.
 * On session_start / session_tree, seeds the merge-helper profile (idempotent).
 * On session_shutdown, hard-kills all tracked child processes and clears the
 * tracking set so the process doesn't orphan.
 *
 * Module-level declarations (childProcesses, extensionEntryPath, gitOpsCache)
 * are pure constant/let bindings — NO top-level side effects.  The factory
 * function MUST be called explicitly by the host.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import kill from "tree-kill";
import { registerGateVerdictTool } from "./gate-verdict";
import { createRunTasksTool } from "./run-tasks";
import { createRealAgentRunner } from "./agent-runner";
import { createGitOps } from "./git-op";
import { seedMergeHelperProfile } from "./profiles";

// ── Module-level state (NOT top-level resources) ──────────────────────────

/** Mutable set of spawned child processes, tracked for abort cleanup. */
const childProcesses = new Set<ChildProcess>();

/**
 * Absolute path to this extension's entry module.  Injected as
 * `--extension <path>` when spawning child agents so they load the
 * `gate_verdict` tool (FIX B1).
 */
const extensionEntryPath = fileURLToPath(new URL("./index.ts", import.meta.url));

/**
 * Cached GitOps instance, created lazily on first call to getGitOps().
 */
let gitOpsCache: ReturnType<typeof createGitOps> | undefined = undefined;

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Register all pi-task-pools tools and lifecycle handlers.
 *
 * **Must be called once** by the host during extension initialisation.
 * Calling multiple times is idempotent — `pi.registerTool` and `pi.on`
 * tolerate duplicate registrations.
 *
 * @param pi - The pi extension API provided by the host.
 */
export default function (pi: ExtensionAPI): void {
  // ── Lifecycle: seed merge-helper profile ──────────────────────────────
  pi.on("session_start", () => {
    try {
      seedMergeHelperProfile();
    } catch {
      /* best-effort — a missing default profile is non-fatal */
    }
  });

  pi.on("session_tree", () => {
    try {
      seedMergeHelperProfile();
    } catch {
      /* best-effort */
    }
  });

  // ── Lifecycle: hard-kill all tracked children on shutdown ──────────────
  pi.on("session_shutdown", () => {
    for (const proc of childProcesses) {
      try {
        if (proc.pid) {
          kill(proc.pid, "SIGKILL");
        }
      } catch {
        /* best-effort — process may already have exited */
      }
    }
    childProcesses.clear();
  });

  // ── Register tools ─────────────────────────────────────────────────────
  registerGateVerdictTool(pi);

  pi.registerTool(
    createRunTasksTool(pi, {
      getAgentRunner: () => createRealAgentRunner({ pi, childProcesses, extensionEntryPath }),
      getGitOps: () => {
        if (!gitOpsCache) {
          gitOpsCache = createGitOps(pi);
        }
        return gitOpsCache;
      },
      childProcesses,
    }),
  );
}
