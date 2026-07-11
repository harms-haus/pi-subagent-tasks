/** Parent-only tool for listing profiles available to run_tasks atoms. */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadProfiles } from "./profiles";
import { getGlobalProfilesDir, getProjectProfilesDir } from "./utils";

const params = Type.Object({}, { additionalProperties: false });

/** Create the task-profile listing tool. Named to avoid list_subagent_profiles. */
export function createTaskProfileListTool(pi: ExtensionAPI): ReturnType<typeof defineTool> {
  void pi;
  return defineTool({
    name: "list_task_profiles",
    label: "List Task Profiles",
    description:
      "List profiles available to run_tasks. Project profiles override global profiles with the same name.",
    parameters: params,

    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: unknown,
    ) {
      const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
      const loadedProfiles = await Promise.resolve(loadProfiles(cwd, true));
      const profiles = [...loadedProfiles.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, profile]) => ({
          name,
          origin: profile.origin,
          ...(profile.provider !== undefined ? { provider: profile.provider } : {}),
          ...(profile.model !== undefined ? { model: profile.model } : {}),
          ...(profile.thinkingLevel !== undefined ? { thinkingLevel: profile.thinkingLevel } : {}),
        }));
      const result = {
        profiles,
        directories: {
          project: getProjectProfilesDir(cwd),
          global: getGlobalProfilesDir(),
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
