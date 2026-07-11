/** Tool for retrieving every agent response produced by one pool task. */

import { readFile } from "node:fs/promises";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

async function readSessionData(path: string): Promise<unknown[] | { error: string }> {
  try {
    return (await readFile(path, "utf8"))
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
      const state = readState(poolDir(cwd, params.poolId));
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
            data: await readSessionData(sessionFile),
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
