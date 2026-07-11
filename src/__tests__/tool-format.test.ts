import { describe, expect, it } from "vitest";

import { toolPreview } from "../tool-format";

describe("toolPreview", () => {
  const cwd = "/repo";

  it("renders read calls with cwd-relative paths, offsets, and limits", () => {
    expect(toolPreview("read", { path: "/repo/src/file.ts", offset: 12, limit: 4 }, cwd)).toBe(
      "📖 read -> ./src/file.ts:12 +4",
    );
  });

  it("uses filePath and keeps paths outside cwd absolute", () => {
    expect(toolPreview("read", { filePath: "/tmp/file.ts" }, cwd)).toBe("📖 read -> /tmp/file.ts");
  });

  it("renders missing and malformed read arguments with the path fallback", () => {
    expect(toolPreview("read", { path: 42, offset: true, limit: {} }, cwd)).toBe(
      "📖 read -> ...:... +...",
    );
    expect(toolPreview("read", {}, cwd)).toBe("📖 read -> ...");
  });

  it("counts non-blank lines written and stringifies numeric content", () => {
    expect(toolPreview("write", { path: "/repo/out.ts", content: "one\n\n  \r\ntwo" }, cwd)).toBe(
      "📝 write -> ./out.ts +2",
    );
    expect(toolPreview("write", { path: "", content: 17 }, cwd)).toBe("📝 write -> ... +1");
    expect(toolPreview("write", { content: {} }, cwd)).toBe("📝 write -> ... +0");
  });

  it("totals non-blank replacement lines while ignoring malformed edits", () => {
    expect(
      toolPreview(
        "edit",
        {
          path: "/repo/a.ts",
          edits: [
            { oldText: "old\n\nline", newText: "new\nline\nthird" },
            null,
            "invalid",
            { oldText: 3, newText: undefined },
          ],
        },
        cwd,
      ),
    ).toBe("✏️ edit -> ./a.ts +3/-3");
    expect(toolPreview("edit", { edits: "invalid" }, cwd)).toBe("✏️ edit -> ... +0/-0");
  });

  it("shows only the first command line and falls back for malformed commands", () => {
    expect(toolPreview("bash", { command: "npm test\necho done" }, cwd)).toBe(
      "💻 bash -> npm test",
    );
    expect(toolPreview("bash", { command: null }, cwd)).toBe("💻 bash -> ...");
  });

  it("formats grep with optional paths", () => {
    expect(toolPreview("grep", { pattern: "needle", path: "/repo/src" }, cwd)).toBe(
      "🔍 grep -> /needle/ -> ./src",
    );
    expect(toolPreview("grep", { pattern: 9 }, cwd)).toBe("🔍 grep -> /9/");
    expect(toolPreview("grep", { pattern: "", path: 7 }, cwd)).toBe("🔍 grep -> /.../ -> ...");
  });

  it("formats find with optional paths", () => {
    expect(toolPreview("find", { pattern: "*.ts", path: "/repo" }, cwd)).toBe(
      "🔍 find -> *.ts in .",
    );
    expect(toolPreview("find", {}, cwd)).toBe("🔍 find -> ...");
    expect(toolPreview("find", { pattern: false, path: 7 }, cwd)).toBe("🔍 find -> ... in ...");
  });

  it("defaults ls to cwd for missing or malformed paths", () => {
    expect(toolPreview("ls", { path: "/repo/src" }, cwd)).toBe("📂 ls -> ./src");
    expect(toolPreview("ls", {}, cwd)).toBe("📂 ls -> .");
    expect(toolPreview("ls", { path: 7 }, cwd)).toBe("📂 ls -> .");
  });

  it("formats web searches from q or query with malformed fallback", () => {
    expect(toolPreview("web_search", { q: "vitest coverage" }, cwd)).toBe(
      '🔍 web_search -> "vitest coverage"',
    );
    expect(toolPreview("web_search", { query: "fallback query" }, cwd)).toBe(
      '🔍 web_search -> "fallback query"',
    );
    expect(toolPreview("web_search", { q: false }, cwd)).toBe('🔍 web_search -> "..."');
  });

  it("formats todo tool arms and their malformed fallbacks", () => {
    expect(toolPreview("write_todos", { todos: [{ title: "one" }, { title: "two" }] }, cwd)).toBe(
      "✅ write_todos -> 2 todos written",
    );
    expect(toolPreview("write_todos", { todos: {} }, cwd)).toBe(
      "✅ write_todos -> 0 todos written",
    );
    expect(toolPreview("edit_todos", { action: "complete" }, cwd)).toBe(
      "✅ edit_todos -> complete",
    );
    expect(toolPreview("edit_todos", { action: "" }, cwd)).toBe("✅ edit_todos -> ?");
  });

  it("formats workflow steps and malformed actions", () => {
    expect(toolPreview("workflow_step", { action: "advance" }, cwd)).toBe(
      "▶️ workflow_step -> advance",
    );
    expect(toolPreview("workflow_step", { action: null }, cwd)).toBe("▶️ workflow_step -> ?");
  });

  it("serializes default-arm arguments while preserving known default-arm emoji", () => {
    expect(toolPreview("fetch_content", { url: "https://example.test" }, cwd)).toBe(
      '🌐 fetch_content {"url":"https://example.test"}',
    );
    expect(toolPreview("list_todos", {}, cwd)).toBe("✅ list_todos");
  });

  it("uses the generic fallback for empty and unknown tools", () => {
    expect(toolPreview("unknown_tool", { count: 2 }, cwd)).toBe('🔧 unknown_tool {"count":2}');
    expect(toolPreview("unknown_tool", {}, cwd)).toBe("🔧 unknown_tool");
    expect(toolPreview("", {}, cwd)).toBe("🔧 ");
  });
});
