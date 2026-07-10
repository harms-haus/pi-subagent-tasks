/**
 * Agent spawner for pi-task-pools.
 *
 * @module spawner
 *
 * Spawns a child process (typically the pi-agent CLI), feeds it a prompt via
 * stdin, line-buffers its JSON event stream on stdout, and tracks:
 *   - Last assistant text (from `message_end` / `turn_end`)
 *   - GateLoop verdicts (from `tool_execution_end` with toolName `gate_verdict`)
 *   - Repetitive tool-call loop detection
 *   - Idle-timeout auto-extend
 *   - Signal-based abort with graceful escalation (SIGTERM → SIGKILL → force-resolve)
 *
 * See the extension spec §11 (Agent spawner), §9 (gate_verdict), §17.6 (loop
 * detection tuning), and D14 (abort behaviour).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import kill from "tree-kill";
import {
  LOOP_DETECT_COUNT,
  IDLE_TIMEOUT_MS,
  IDLE_DEBOUNCE_MS,
  IDLE_CHECK_INTERVAL_MS,
  ABORT_GRACE_MS,
  ABORT_FORCE_MS,
} from "./constants";
import type { GateVerdict } from "./types";

// ── Public interfaces ────────────────────────────────────────────────────────

/** Options for {@link spawnAgent}. */
export interface SpawnOptions {
  /** CLI binary to spawn (e.g. "pi" or a path). */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
  /** Environment variable overrides for the child process. */
  env: Record<string, string>;
  /** Text written to the child's stdin before it is closed. */
  stdinPrompt: string;
  /** Working directory for the spawned process. */
  cwd: string;
  /** Optional {@link AbortSignal} for a hard-kill (D14). */
  signal?: AbortSignal;
  /**
   * Callback invoked after every successfully-parsed JSON event from stdout.
   * Debouncing (throttling UI updates) is the caller's responsibility.
   */
  onUpdate?: () => void;
  /**
   * Callback invoked after the child process is spawned, with the raw
   * {@link ChildProcess} reference. Enables the caller (e.g. agent-runner)
   * to track the process in a managed set for lifecycle management.
   */
  onSpawn?: (proc: ChildProcess) => void;
}

/** Result returned by {@link spawnAgent}. */
export interface SpawnResult {
  /** Process exit code, or `null` if force-resolved (D-state guard). */
  exitCode: number | null;
  /** Everything the child wrote to stderr (decoded as UTF-8). */
  stderr: string;
  /** The last assistant text emitted in a `message_end` / `turn_end` event. */
  lastAssistantText: string;
  /** Parsed gateLoop verdict (present on review atoms only, §9). */
  verdict?: GateVerdict;
  /** `true` when repetitive tool-call loop detection fired (§17.6). */
  loopDetected: boolean;
  /** Wall-clock duration of the agent run in milliseconds. */
  durationMs: number;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Try to parse one line of stdout as a JSON agent event.
 *
 * Returns a parsed event record on success, or `null` for non-JSON lines.
 * This function is extracted for clarity; the runtime never rejects.
 */
function tryParseEvent(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Scan an event's `.message.content` array **backward** for the last text part.
 * Returns the text content, or `undefined` if none found.
 */
function extractLastText(event: Record<string, unknown>): string | undefined {
  const msg = event.message as Record<string, unknown> | undefined;
  if (!msg?.content || !Array.isArray(msg.content)) return undefined;
  const content = msg.content as Array<Record<string, unknown>>;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part?.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return undefined;
}

/**
 * Extract a {@link GateVerdict} from a `tool_execution_end` event whose
 * `toolName` is `"gate_verdict"`. Returns `undefined` when the event doesn't
 * carry a toolName match or lacks usable result/args fields.
 */
function extractVerdict(event: Record<string, unknown>): GateVerdict | undefined {
  const toolName = event.toolName as string | undefined;
  if (toolName !== "gate_verdict") return undefined;
  const result = (event.result ?? event.args ?? {}) as Record<string, unknown>;
  return {
    approved: Boolean(result.approved),
    feedback: typeof result.feedback === "string" ? result.feedback : "",
  };
}

/**
 * Build a tool-call signature for loop detection.
 *
 * Format: `${toolName}:${JSON.stringify(args, sorted keys)}`
 */
function toolSignature(event: Record<string, unknown>): string {
  const toolName = typeof event.toolName === "string" ? event.toolName : "?";
  const rawArgs = (event.args as Record<string, unknown> | undefined) || {};
  const sortedKeys = Object.keys(rawArgs).sort();
  const sortedArgs: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedArgs[key] = rawArgs[key];
  }
  return `${toolName}:${JSON.stringify(sortedArgs)}`;
}

/**
 * Check whether the most recent tool-call signatures indicate a loop.
 *
 * Returns `true` when the last {@link LOOP_DETECT_COUNT} signatures are all
 * identical **and** non-empty.
 */
function isLoopDetected(signatures: string[]): boolean {
  if (signatures.length < LOOP_DETECT_COUNT) return false;
  const first = signatures[0];
  if (!first) return false;
  // We only keep the last LOOP_DETECT_COUNT entries in the sliding window,
  // so a simple `.every()` is correct.
  return signatures.every((s) => s === first);
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Spawn an agent process, feed it a prompt, and stream back results.
 *
 * The function never rejects — every terminal condition (spawn error, abort,
 * idle timeout, normal exit) is mapped to a {@link SpawnResult}.
 */
export function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const start = Date.now();

  // ── Mutable accumulator state ──────────────────────────────────────────
  let stderrOutput = "";
  let lastAssistantText = "";
  let verdict: GateVerdict | undefined;
  let loopDetected = false;
  let storedExitCode: number | null = null;
  const recentSignatures: string[] = [];
  let lastActivityAt = Date.now();
  let resolved = false;
  let killed = false;
  let idleInterval: ReturnType<typeof setInterval> | undefined;

  return new Promise<SpawnResult>((resolve) => {
    // ── Safe single-resolution guard ────────────────────────────────────
    function safeResolve(result: SpawnResult): void {
      if (!resolved) {
        resolved = true;
        clearInterval(idleInterval);
        // Clean up abort signal listener to prevent leaks (fix #2)
        if (opts.signal) {
          opts.signal.removeEventListener("abort", onAbort);
        }
        resolve(result);
      }
    }

    // ── Kill-process-tree with escalation (D14) ─────────────────────────
    function killProcessTree(pid: number | undefined): void {
      if (pid === undefined || killed) return;
      killed = true;
      try {
        kill(pid, "SIGTERM");
      } catch {
        // PID may be stale or process already gone
      }
      setTimeout(() => {
        try {
          kill(pid, "SIGKILL");
        } catch {
          // May already be dead or zombie
        }
        // Force-resolve safety guard (D-state guard, D14)
        setTimeout(() => {
          const durationMs = Date.now() - start;
          safeResolve({
            exitCode: null,
            stderr: stderrOutput,
            lastAssistantText,
            verdict,
            loopDetected,
            durationMs,
          });
        }, ABORT_FORCE_MS);
      }, ABORT_GRACE_MS);
    }

    // ── Unified event handler (DRY fix #4) ──────────────────────────────
    function handleEvent(event: Record<string, unknown>): void {
      // 1. Last assistant text (message_end / turn_end)
      if (event.type === "message_end" || event.type === "turn_end") {
        const text = extractLastText(event);
        if (text !== undefined) lastAssistantText = text;
      }

      // 2. GateLoop verdict (tool_execution_end · gate_verdict)
      if (event.type === "tool_execution_end") {
        const v = extractVerdict(event);
        if (v) verdict = v;
      }

      // 3. Loop detection (tool_execution_start only — fix #3)
      if (event.type === "tool_execution_start") {
        const sig = toolSignature(event);
        recentSignatures.push(sig);
        if (recentSignatures.length > LOOP_DETECT_COUNT) {
          recentSignatures.shift();
        }
        if (!loopDetected && isLoopDetected(recentSignatures)) {
          loopDetected = true;
          killProcessTree(proc.pid);
        }
      }

      // 4. Caller notification
      opts.onUpdate?.();
    }

    // ── Abort signal handler (named ref for cleanup) ─────────────────────
    function onAbort(): void {
      killProcessTree(proc.pid);
    }

    // ── Spawn the child process ─────────────────────────────────────────
    const proc = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });

    // ── Notify caller of the spawned process ────────────────────────────
    opts.onSpawn?.(proc);

    // ── Abort signal plumbing ────────────────────────────────────────────
    if (opts.signal?.aborted) {
      killProcessTree(proc.pid);
    } else if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // ── Stdin ─────────────────────────────────────────────────────────────
    proc.stdin.write(opts.stdinPrompt);
    proc.stdin.end();

    // ── Idle-timeout checker ──────────────────────────────────────────────
    idleInterval = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= IDLE_TIMEOUT_MS) {
        const timeSinceActivity = Date.now() - lastActivityAt;
        if (timeSinceActivity >= IDLE_DEBOUNCE_MS) {
          killProcessTree(proc.pid);
        }
      }
    }, IDLE_CHECK_INTERVAL_MS);

    // ── Stdout line buffering & event parsing ────────────────────────────
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutBuffer = "";

    function onStdoutData(chunk: Buffer): void {
      stdoutBuffer += stdoutDecoder.write(chunk);
      const lines = stdoutBuffer.split("\n");
      // Keep the trailing (possibly partial) line in the buffer
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = tryParseEvent(line);
        if (!event) continue;
        handleEvent(event);
      }

      lastActivityAt = Date.now();
    }

    proc.stdout.on("data", onStdoutData);

    // ── Stderr line buffering ────────────────────────────────────────────
    const stderrDecoder = new StringDecoder("utf8");
    let stderrBuffer = "";

    function onStderrData(chunk: Buffer): void {
      stderrBuffer += stderrDecoder.write(chunk);
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      // Accumulate complete lines (preserve newlines)
      for (const line of lines) {
        stderrOutput += line + "\n";
      }
    }

    proc.stderr.on("data", onStderrData);

    // ── Terminal state handlers ───────────────────────────────────────────
    function flushRemainders(): void {
      // Flush any partial stdout line
      stdoutBuffer += stdoutDecoder.end();
      if (stdoutBuffer.trim()) {
        const event = tryParseEvent(stdoutBuffer);
        if (event) handleEvent(event);
      }

      // Flush any partial stderr line
      stderrBuffer += stderrDecoder.end();
      if (stderrBuffer) {
        stderrOutput += stderrBuffer;
      }
    }

    // Fix #1: exit → stash exit code only; close → flush & resolve
    proc.on("exit", (code) => {
      storedExitCode = code ?? null;
    });

    proc.on("close", () => {
      flushRemainders();
      safeResolve({
        exitCode: storedExitCode,
        stderr: stderrOutput,
        lastAssistantText,
        verdict,
        loopDetected,
        durationMs: Date.now() - start,
      });
    });

    proc.on("error", (err: Error) => {
      safeResolve({
        exitCode: -1,
        stderr: err.message,
        lastAssistantText: "",
        verdict: undefined,
        loopDetected: false,
        durationMs: Date.now() - start,
      });
    });
  });
}
