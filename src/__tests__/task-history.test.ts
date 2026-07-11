import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTaskHistoryTool } from "../task-history";
import { createMockAPI, createMockContext } from "./helpers/mock-api";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "task-history-"));
  dirs.push(cwd);
  const poolPath = join(cwd, ".pi", "subagent-tasks", "pool-1");
  const sessions = join(poolPath, "sessions");
  mkdirSync(sessions, { recursive: true });
  const a = join(sessions, "a.jsonl");
  const b = join(sessions, "b.jsonl");
  writeFileSync(
    a,
    '{"type":"session","id":"a"}\n{"type":"message","message":{"role":"assistant","content":"A"}}\n',
  );
  writeFileSync(b, '{"type":"message","message":{"role":"assistant","content":"B"}}\n');
  writeFileSync(
    join(poolPath, "state.json"),
    JSON.stringify({
      id: "pool-1",
      name: "Pool",
      worktree: false,
      branch: "",
      poolWorktree: cwd,
      baseBranch: "",
      limits: { total: 1, provider: {}, model: {} },
      maxRetries: 2,
      createdAt: 1,
      updatedAt: 2,
      status: "done",
      mergeQueue: [],
      tasks: [
        {
          id: "task-1",
          prompt: "x",
          dependsOn: [],
          compose: { type: "agent" },
          cursor: { kind: "agent", path: "0", state: "done", executionCount: 1 },
          status: "done",
          retryCount: 0,
          runningAgentCount: 0,
          worktreePath: null,
          branch: null,
          sessionFiles: [a, b],
          downstreamCount: 0,
          responseHistory: [
            {
              atomPath: "0.work",
              lastText: "first",
              success: true,
              completedAt: 10,
              sessionFile: a,
            },
            {
              atomPath: "0.review",
              lastText: "reject",
              success: true,
              completedAt: 20,
              sessionFile: b,
            },
            {
              atomPath: "0.work",
              lastText: "second",
              success: true,
              completedAt: 30,
              sessionFile: a,
            },
          ],
        },
      ],
    }),
  );
  return { cwd, poolPath, sessions, a };
}

function setResponseSessionFiles(poolPath: string, sessionFiles: string[]): void {
  const statePath = join(poolPath, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.tasks[0].responseHistory = sessionFiles.map((sessionFile, index) => ({
    atomPath: `0.${index}`,
    lastText: `response-${index}`,
    success: true,
    completedAt: index,
    sessionFile,
  }));
  writeFileSync(statePath, JSON.stringify(state));
}

async function getFullSessionData(cwd: string) {
  const tool = createTaskHistoryTool(createMockAPI().api);
  const result = await tool.execute(
    "call",
    { poolId: "pool-1", taskId: "task-1", fullSessionData: true },
    undefined,
    undefined,
    createMockContext({ cwd }),
  );
  const content = result.content[0]!;
  expect(content.type).toBe("text");
  return JSON.parse(content.type === "text" ? content.text : "{}");
}

describe("get_task_history", () => {
  it("returns all final responses in completion order by default", async () => {
    const { cwd } = fixture();
    const tool = createTaskHistoryTool(createMockAPI().api);
    const result = await tool.execute(
      "call",
      { poolId: "pool-1", taskId: "task-1" },
      undefined,
      undefined,
      createMockContext({ cwd }),
    );
    const content = result.content[0]!;
    expect(content.type).toBe("text");
    const data = JSON.parse(content.type === "text" ? content.text : "{}");
    expect(data.responses.map((entry: { response: string }) => entry.response)).toEqual([
      "first",
      "reject",
      "second",
    ]);
    expect(data.sessions).toBeUndefined();
  });

  it("optionally returns complete JSONL data once per session file", async () => {
    const { cwd } = fixture();
    const data = await getFullSessionData(cwd);
    expect(data.sessions).toHaveLength(2);
    expect(data.sessions[0].data).toHaveLength(2);
    expect(data.sessions[1].data[0].message.content).toBe("B");
  });

  it.each([
    {
      name: "an absolute path outside the pool",
      sessionFile: ({ cwd }: ReturnType<typeof fixture>) => join(cwd, "outside.jsonl"),
    },
    {
      name: "a parent-directory traversal",
      sessionFile: ({ sessions }: ReturnType<typeof fixture>) => `${sessions}/../../outside.jsonl`,
    },
    {
      name: "an absolute path in a sibling pool",
      sessionFile: ({ cwd }: ReturnType<typeof fixture>) =>
        join(cwd, ".pi", "subagent-tasks", "pool-10", "sessions", "outside.jsonl"),
    },
    {
      name: "a sessions-directory prefix collision",
      sessionFile: ({ poolPath }: ReturnType<typeof fixture>) =>
        join(poolPath, "sessions-evil", "outside.jsonl"),
    },
  ])("rejects $name without exposing its contents", async ({ sessionFile }) => {
    const paths = fixture();
    const persistedPath = sessionFile(paths);
    const outside = resolve(persistedPath);
    mkdirSync(join(outside, ".."), { recursive: true });
    writeFileSync(outside, '{"secret":"must-not-be-returned"}\n');
    setResponseSessionFiles(paths.poolPath, [paths.a, persistedPath]);

    const data = await getFullSessionData(paths.cwd);

    expect(data.sessions).toHaveLength(2);
    expect(data.sessions[0]).toMatchObject({
      sessionFile: paths.a,
      data: [{ type: "session", id: "a" }, expect.any(Object)],
    });
    expect(data.sessions[1].sessionFile).toBe(persistedPath);
    expect(data.sessions[1].data).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(data.sessions[1])).not.toContain("must-not-be-returned");
  });

  it("rejects a non-regular target inside the sessions directory", async () => {
    const paths = fixture();
    const directory = join(paths.sessions, "not-a-session.jsonl");
    mkdirSync(directory);
    setResponseSessionFiles(paths.poolPath, [directory]);

    const data = await getFullSessionData(paths.cwd);

    expect(data.sessions).toEqual([
      {
        sessionFile: directory,
        data: { error: expect.any(String) },
      },
    ]);
  });

  it("rejects an in-pool symlink that resolves to an outside regular file", async () => {
    const paths = fixture();
    const outside = join(paths.cwd, "symlink-target.jsonl");
    const link = join(paths.sessions, "linked-session.jsonl");
    writeFileSync(outside, '{"secret":"symlink-secret-must-not-be-returned"}\n');
    symlinkSync(outside, link);
    setResponseSessionFiles(paths.poolPath, [link]);

    const data = await getFullSessionData(paths.cwd);

    expect(data.sessions).toEqual([
      {
        sessionFile: link,
        data: { error: expect.any(String) },
      },
    ]);
    expect(JSON.stringify(data.sessions[0])).not.toContain("symlink-secret-must-not-be-returned");
  });
});
