import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  return { cwd };
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
    const data = JSON.parse(content.type === "text" ? content.text : "{}");
    expect(data.sessions).toHaveLength(2);
    expect(data.sessions[0].data).toHaveLength(2);
    expect(data.sessions[1].data[0].message.content).toBe("B");
  });
});
