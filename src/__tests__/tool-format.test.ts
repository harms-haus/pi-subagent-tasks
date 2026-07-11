import { describe, expect, it } from "vitest";

import { toolPreview } from "../tool-format";

describe("toolPreview", () => {
  it("renders a compact tool-only line with cwd-relative paths", () => {
    expect(toolPreview("read", { path: "/repo/src/file.ts" }, "/repo")).toBe(
      "📖 read -> ./src/file.ts",
    );
  });

  it("keeps paths outside cwd absolute", () => {
    expect(toolPreview("read", { path: "/tmp/file.ts" }, "/repo")).toBe("📖 read -> /tmp/file.ts");
  });
});
