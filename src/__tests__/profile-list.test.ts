import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTaskProfileListTool } from "../profile-list";
import { createMockAPI, createMockContext } from "./helpers/mock-api";

const dirs: string[] = [];

afterEach(() => {
  dirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
  delete process.env.PI_AGENT_DIR;
});

function writeProfile(dir: string, name: string, model: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\nmodel: ${model}\n---\n`);
}

describe("list_task_profiles", () => {
  it("lists resolved profiles with canonical project overrides", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "profile-list-project-"));
    const agentDir = mkdtempSync(join(tmpdir(), "profile-list-global-"));
    dirs.push(cwd, agentDir);
    process.env.PI_AGENT_DIR = agentDir;

    writeProfile(join(agentDir, "profiles"), "global-only", "global-model");
    writeProfile(join(agentDir, "profiles"), "shared", "global-model");
    writeProfile(join(cwd, ".pi", "agent", "profiles"), "shared", "project-model");

    const { api } = createMockAPI();
    const tool = createTaskProfileListTool(api);
    const result = await tool.execute("call", {}, undefined, undefined, createMockContext({ cwd }));
    const details = result.details as {
      profiles: Array<{ name: string; model?: string; origin?: string }>;
      directories: Record<string, string>;
    };

    expect(tool.name).toBe("list_task_profiles");
    expect(tool.name).not.toBe("list_subagent_profiles");
    expect(details.profiles).toEqual([
      { name: "global-only", origin: "global", model: "global-model" },
      { name: "shared", origin: "project", model: "project-model" },
    ]);
    expect(details.directories.project).toBe(join(cwd, ".pi", "agent", "profiles"));
    expect(details.directories.global).toBe(join(agentDir, "profiles"));
  });

  it("refreshes the profile cache on every call", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "profile-list-refresh-"));
    const agentDir = mkdtempSync(join(tmpdir(), "profile-list-global-"));
    dirs.push(cwd, agentDir);
    process.env.PI_AGENT_DIR = agentDir;
    const globalDir = join(agentDir, "profiles");
    writeProfile(globalDir, "first", "m1");

    const { api } = createMockAPI();
    const tool = createTaskProfileListTool(api);
    await tool.execute("call-1", {}, undefined, undefined, createMockContext({ cwd }));
    writeProfile(globalDir, "second", "m2");
    const result = await tool.execute(
      "call-2",
      {},
      undefined,
      undefined,
      createMockContext({ cwd }),
    );
    const details = result.details as { profiles: Array<{ name: string }> };

    expect(details.profiles.map(({ name }) => name)).toEqual(["first", "second"]);
  });
});
