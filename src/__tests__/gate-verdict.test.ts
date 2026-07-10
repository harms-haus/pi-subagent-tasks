import { describe, it, expect } from "vitest";

import { gateVerdictTool, registerGateVerdictTool } from "../gate-verdict";
import { createMockAPI, createMockContext, createMockTheme } from "./helpers/mock-api";

describe("gateVerdictTool", () => {
  describe("definition", () => {
    it("has the correct name", () => {
      expect(gateVerdictTool.name).toBe("gate_verdict");
    });

    it("has a label", () => {
      expect(gateVerdictTool.label).toBe("Gate Verdict");
    });

    it("has a description", () => {
      expect(gateVerdictTool.description).toContain("git diff");
    });

    it("has promptSnippet with render-review-verdict instruction", () => {
      expect(gateVerdictTool.promptSnippet).toContain("review verdict");
    });

    it("has promptGuidelines with inspect-then-call-last instructions", () => {
      expect(gateVerdictTool.promptGuidelines).toBeDefined();
      const guidelines = gateVerdictTool.promptGuidelines!;
      expect(guidelines.length).toBeGreaterThanOrEqual(2);
      expect(guidelines[0]!).toContain("Inspect the work");
      expect(guidelines[1]!).toContain("gate_verdict LAST");
    });

    it("has parameters with approved and feedback", () => {
      const params = gateVerdictTool.parameters as { properties?: Record<string, unknown> };
      expect(params.properties).toBeDefined();
      expect(params.properties!["approved"]).toBeDefined();
      expect(params.properties!["feedback"]).toBeDefined();
    });
  });

  describe("execute", () => {
    const mockCtx = createMockContext();

    it("returns terminate: true for approval", async () => {
      const result = await gateVerdictTool.execute(
        "call-1",
        { approved: true, feedback: "Good work" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.terminate).toBe(true);
    });

    it("returns terminate: true for rejection", async () => {
      const result = await gateVerdictTool.execute(
        "call-2",
        { approved: false, feedback: "Fix the tests" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.terminate).toBe(true);
    });

    it("returns details with approved and feedback", async () => {
      const result = await gateVerdictTool.execute(
        "call-3",
        { approved: true, feedback: "Looks great" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.details).toEqual({
        approved: true,
        feedback: "Looks great",
      });
    });

    it("returns content with approved text", async () => {
      const result = await gateVerdictTool.execute(
        "call-4",
        { approved: true, feedback: "LGTM" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0]!.type).toBe("text");
      expect((result.content[0]! as { text: string }).text).toContain("approved");
    });

    it("returns content with rejected text", async () => {
      const result = await gateVerdictTool.execute(
        "call-5",
        { approved: false, feedback: "Needs changes" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0]!.type).toBe("text");
      expect((result.content[0]! as { text: string }).text).toContain("rejected");
    });
  });

  describe("renderResult", () => {
    it("renders approved with checkmark", () => {
      const theme = createMockTheme();
      const result = {
        content: [{ type: "text" as const, text: "Verdict: approved" }],
        details: { approved: true, feedback: "All good" },
      };
      const component = gateVerdictTool.renderResult!(result, {} as never, theme, {} as never);
      // pi-tui Text renders its content verbatim
      expect(component.render(80)).toEqual(["✓ approved: All good"]);
    });

    it("renders rejected with cross mark and feedback", () => {
      const theme = createMockTheme();
      const result = {
        content: [{ type: "text" as const, text: "Verdict: rejected" }],
        details: { approved: false, feedback: "Fix the logic" },
      };
      const component = gateVerdictTool.renderResult!(result, {} as never, theme, {} as never);
      expect(component.render(80)).toEqual(["✗ rejected: Fix the logic"]);
    });

    it("renders approved with empty feedback", () => {
      const theme = createMockTheme();
      const result = {
        content: [{ type: "text" as const, text: "Verdict: approved" }],
        details: { approved: true, feedback: "" },
      };
      const component = gateVerdictTool.renderResult!(result, {} as never, theme, {} as never);
      expect(component.render(80)).toEqual(["✓ approved"]);
    });

    it("falls back to content text when details are missing", () => {
      const theme = createMockTheme();
      const result = {
        content: [{ type: "text" as const, text: "Verdict: approved" }],
      };
      const component = gateVerdictTool.renderResult!(
        result as never,
        {} as never,
        theme,
        {} as never,
      );
      expect(component.render(80)).toEqual(["Verdict: approved"]);
    });

    it("renders empty string when content array is empty and details are missing", () => {
      const theme = createMockTheme();
      const result = {
        content: [] as never[],
      };
      const component = gateVerdictTool.renderResult!(
        result as never,
        {} as never,
        theme,
        {} as never,
      );
      expect(component.render(80)).toEqual([""]);
    });
  });
});

describe("registerGateVerdictTool", () => {
  it("calls pi.registerTool with gate_verdict", () => {
    const { api, capturedTools } = createMockAPI();
    registerGateVerdictTool(api);
    expect(capturedTools.has("gate_verdict")).toBe(true);
    expect(capturedTools.get("gate_verdict")).toBe(gateVerdictTool);
  });
});
