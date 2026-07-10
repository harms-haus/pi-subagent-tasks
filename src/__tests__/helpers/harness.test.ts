import { describe, it, expect } from "vitest";

import { Text, Container, Spacer, Box } from "@earendil-works/pi-tui";

import { createMockAPI, createMockContext, createMockTheme } from "./mock-api";
import { createMockAgentRunner, createMockGitExec } from "./mock-runner";

// Self-test for the test doubles shared by every engine test. Guards against
// regressions in the harness contract (captured tools, recorded demands,
// per-path / fn overrides, opts capture, default git exec, context & theme
// surfaces).

describe("createMockAPI", () => {
  it("captures registered tools keyed by name and stores the exact object", () => {
    const { api, capturedTools } = createMockAPI();
    const tool = { name: "x" };
    api.registerTool(tool as never);
    expect(capturedTools.get("x")).toBe(tool);
  });
});

describe("createMockContext", () => {
  it("exposes cwd, sessionManager.getBranch, ui.setToolsExpanded, and mode 'tui'", () => {
    const ctx = createMockContext();
    expect(ctx.cwd).toBe("/test");
    expect(typeof ctx.sessionManager.getBranch).toBe("function");
    expect(typeof ctx.ui.setToolsExpanded).toBe("function");
    expect(ctx.mode).toBe("tui");
    expect(ctx.signal).toBeUndefined();
    expect(ctx.model).toBeUndefined();
    expect(ctx.hasUI).toBe(false);
    expect(createMockContext({ mode: "rpc" }).mode).toBe("rpc");
  });
});

describe("createMockTheme", () => {
  it("fg/bold pass their text argument through unmodified", () => {
    const theme = createMockTheme();
    expect(theme.fg("warning", "x")).toBe("x");
    expect(theme.bold("y")).toBe("y");
  });
});

describe("createMockAgentRunner", () => {
  it("returns a per-path merged result and records the demand", async () => {
    const r = createMockAgentRunner();
    r.setResult("a", { lastText: "hi" });
    const out = await r.runAgent({ atomPath: "a" } as never, {
      sessionDir: "/s",
      poolId: "p",
    });
    expect(out.lastText).toBe("hi");
    expect(r.received).toHaveLength(1);
  });

  it("setResultFn overrides per-path results", async () => {
    const r = createMockAgentRunner();
    r.setResultFn(() => ({ success: true, lastText: "fn", exitCode: 0, durationMs: 0 }));
    expect(
      (
        await r.runAgent({ atomPath: "a" } as never, {
          sessionDir: "/s",
          poolId: "p",
        })
      ).lastText,
    ).toBe("fn");
  });

  it("falls back to a default result when nothing is configured", async () => {
    const r = createMockAgentRunner();
    const out = await r.runAgent({ atomPath: "b" } as never, {
      sessionDir: "/s",
      poolId: "p",
    });
    expect(out.lastText).toBe("mock-output-for-b");
    expect(out.success).toBe(true);
  });

  it("derives a non-zero exitCode for a failing override without an explicit code", async () => {
    const r = createMockAgentRunner();
    r.setResult("f", { success: false, error: "boom" });
    const out = await r.runAgent({ atomPath: "f" } as never, {
      sessionDir: "/s",
      poolId: "p",
    });
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.error).toBe("boom");
  });

  it("captures the opts passed to runAgent", async () => {
    const r = createMockAgentRunner();
    await r.runAgent({ atomPath: "a" } as never, {
      sessionDir: "/sessions",
      poolId: "pool-1",
    });
    expect(r.receivedOpts).toHaveLength(1);
    expect(r.receivedOpts[0]?.sessionDir).toBe("/sessions");
    expect(r.receivedOpts[0]?.poolId).toBe("pool-1");
  });
});

describe("createMockGitExec", () => {
  it("returns code 0 by default", () => {
    const exec = createMockGitExec();
    const res = exec(["status"]);
    expect(res.code).toBe(0);
  });
});

describe("pi-tui mocks", () => {
  it("Text renders content and setText updates it", () => {
    expect(new Text("x").render(80)).toEqual(["x"]);
    const t = new Text("a");
    t.setText("b");
    expect(t.render(80)).toEqual(["b"]);
  });

  it("Container tracks children and clears them", () => {
    const c = new Container();
    c.addChild(new Text("y"));
    expect(c.children).toHaveLength(1);
    c.clear();
    expect(c.children).toHaveLength(0);
  });

  it("Text exposes setText and invalidate as functions", () => {
    const t = new Text("x");
    expect(typeof t.setText).toBe("function");
    expect(typeof t.invalidate).toBe("function");
  });

  it("Container exposes addChild, removeChild, clear, invalidate as functions", () => {
    const c = new Container();
    expect(typeof c.addChild).toBe("function");
    expect(typeof c.removeChild).toBe("function");
    expect(typeof c.clear).toBe("function");
    expect(typeof c.invalidate).toBe("function");
  });

  it("Spacer exposes setLines and invalidate as functions", () => {
    const s = new Spacer();
    expect(typeof s.setLines).toBe("function");
    expect(typeof s.invalidate).toBe("function");
  });

  it("Box exposes addChild, removeChild, clear, setBgFn, invalidate as functions", () => {
    const b = new Box();
    expect(typeof b.addChild).toBe("function");
    expect(typeof b.removeChild).toBe("function");
    expect(typeof b.clear).toBe("function");
    expect(typeof b.setBgFn).toBe("function");
    expect(typeof b.invalidate).toBe("function");
  });
});
