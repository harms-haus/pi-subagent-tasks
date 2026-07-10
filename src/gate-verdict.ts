/**
 * gate_verdict — terminating tool for gateLoop review verdicts (§9, D8).
 *
 * The reviewer calls this as its FINAL action after inspecting the work via
 * git diff, read files, etc. The tool marks itself with `terminate: true` so
 * the agent ends without an extra LLM turn.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface GateVerdictDetails {
  approved: boolean;
  feedback: string;
}

export const gateVerdictTool = defineTool({
  name: "gate_verdict",
  label: "Gate Verdict",
  description:
    "After reviewing the work in this worktree (git diff, read files), call this as your FINAL action with your verdict.",
  promptSnippet: "Render a review verdict (approved + feedback); call last.",
  promptGuidelines: [
    "Inspect the work (git diff, read files) BEFORE deciding.",
    "Call gate_verdict LAST with {approved, feedback}.",
  ],
  parameters: Type.Object({
    approved: Type.Boolean({ description: "Whether the work passes review" }),
    feedback: Type.String({
      description:
        "If rejected, specific actionable changes needed; if approved, a brief summary or empty string",
    }),
  }),

  execute(
    _toolCallId: string,
    params: { approved: boolean; feedback: string },
    _signal?: AbortSignal,
    _onUpdate?: unknown,
    _ctx?: unknown,
  ) {
    // Suppress unused-parameter warnings — the interface requires these.
    void _signal;
    void _onUpdate;
    void _ctx;

    return Promise.resolve({
      content: [
        { type: "text" as const, text: `Verdict: ${params.approved ? "approved" : "rejected"}` },
      ],
      details: {
        approved: params.approved,
        feedback: params.feedback,
      } satisfies GateVerdictDetails,
      terminate: true,
    });
  },

  renderResult(result, _options, theme, _context?) {
    void _context;
    const details = result.details as GateVerdictDetails | undefined;
    if (!details) {
      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "", 0, 0);
    }

    const label = details.approved
      ? theme.fg("success", theme.bold("✓ approved"))
      : theme.fg("error", theme.bold("✗ rejected"));
    const feedback = details.feedback ? `: ${details.feedback}` : "";
    return new Text(`${label}${feedback}`, 0, 0);
  },
});

export function registerGateVerdictTool(pi: ExtensionAPI): void {
  pi.registerTool(gateVerdictTool);
}
