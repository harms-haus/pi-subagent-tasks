/** Tool for retrieving every agent response produced by one pool task. */

import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SESSION_DIR_NAME } from "./constants";
import { poolDir } from "./utils";
import { readState } from "./state";

const taskHistoryParams = Type.Object(
  {
    poolId: Type.String({ description: "Pool id returned by run_tasks" }),
    taskId: Type.String({ description: "Task id returned by run_tasks" }),
    fullSessionData: Type.Optional(
      Type.Boolean({
        description:
          "Include every JSONL entry from each session file (default false). This can be large.",
      }),
    ),
  },
  { additionalProperties: false },
);

async function readSessionData(
  path: string,
  sessionsDir: string,
): Promise<unknown[] | { error: string }> {
  try {
    const [resolvedSessionsDir, resolvedPath] = await Promise.all([
      realpath(sessionsDir),
      realpath(path),
    ]);
    const pathFromSessionsDir = relative(resolvedSessionsDir, resolvedPath);
    if (
      pathFromSessionsDir === "" ||
      pathFromSessionsDir === ".." ||
      pathFromSessionsDir.startsWith(`..${sep}`) ||
      isAbsolute(pathFromSessionsDir)
    ) {
      throw new Error("Session file is outside the pool sessions directory.");
    }
    if (!(await stat(resolvedPath)).isFile()) {
      throw new Error("Session file is not a regular file.");
    }

    return (await readFile(resolvedPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Create the parent-only task response history tool. */
export function createTaskHistoryTool(pi: ExtensionAPI): ReturnType<typeof defineTool> {
  void pi;
  return defineTool({
    name: "get_task_history",
    label: "Get Task History",
    description:
      "Get all final agent responses for a run_tasks task in completion order. " +
      "Optionally includes the complete JSONL data for every session used by the task.",
    parameters: taskHistoryParams,

    async execute(
      _toolCallId: string,
      params: { poolId: string; taskId: string; fullSessionData?: boolean },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: unknown,
    ) {
      const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
      const requestedPoolDir = poolDir(cwd, params.poolId);
      const state = readState(requestedPoolDir);
      if (!state) throw new Error(`Pool "${params.poolId}" not found.`);

      const task = state.tasks.find((candidate) => candidate.id === params.taskId);
      if (!task) {
        throw new Error(
          `Task "${params.taskId}" not found in pool "${params.poolId}". Available task ids: ${state.tasks.map((candidate) => candidate.id).join(", ")}`,
        );
      }

      const responses = (task.responseHistory ?? []).map((entry) => ({
        atomPath: entry.atomPath,
        success: entry.success,
        completedAt: entry.completedAt,
        response: entry.lastText,
        ...(entry.error !== undefined ? { error: entry.error } : {}),
        ...(entry.sessionFile !== undefined ? { sessionFile: entry.sessionFile } : {}),
      }));

      const result: Record<string, unknown> = {
        poolId: state.id,
        taskId: task.id,
        responses,
      };

      if (params.fullSessionData === true) {
        const files = [
          ...new Set(
            (task.responseHistory ?? [])
              .map((entry) => entry.sessionFile)
              .filter((path): path is string => path !== undefined),
          ),
        ];
        result.sessions = await Promise.all(
          files.map(async (sessionFile) => ({
            sessionFile,
            data: await readSessionData(sessionFile, join(requestedPoolDir, SESSION_DIR_NAME)),
          })),
        );
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
