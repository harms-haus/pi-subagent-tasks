import { vi } from "vitest";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/**
 * Creates a mock of the pi {@link ExtensionAPI} surface.
 *
 * Tools registered via `registerTool` are captured into `capturedTools`
 * (keyed by `tool.name`); event handlers attached via `on` are captured into
 * `capturedHandlers` (keyed by event name). The remaining methods are no-op
 * `vi.fn()`s that individual tests can override with `mockImplementation`.
 *
 * @returns `{ api, capturedTools, capturedHandlers }`.
 */
export function createMockAPI() {
  const capturedTools = new Map<string, unknown>();
  const capturedHandlers: Record<string, unknown> = {};

  const api = {
    registerTool: vi.fn((tool: { name: string }) => {
      capturedTools.set(tool.name, tool);
    }),
    on: vi.fn((event: string, handler: unknown) => {
      capturedHandlers[event] = handler;
    }),
    exec: vi.fn(),
    appendEntry: vi.fn(),
    registerMessageRenderer: vi.fn(),
  } as unknown as ExtensionAPI;

  return { api, capturedTools, capturedHandlers };
}

/**
 * Creates a mock {@link ExtensionContext}. The defaults match the surfaces
 * engine/render code touches (cwd, mode, model, signal, sessionManager, ui,
 * hasUI). Pass `overrides` to swap any field; the result is cast to
 * `ExtensionContext`.
 *
 * Members intentionally left absent (the cast bypasses them): `modelRegistry`,
 * `isIdle`, `isProjectTrusted`, `abort`, `hasPendingMessages`, `shutdown`,
 * `getContextUsage`, `compact`, `getSystemPrompt`.
 */
export function createMockContext(overrides: Record<string, unknown> = {}) {
  const context = {
    cwd: "/test",
    mode: "tui",
    model: undefined,
    signal: undefined,
    sessionManager: {
      getBranch: vi.fn(() => []),
      getEntries: vi.fn(() => []),
    },
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setToolsExpanded: vi.fn(),
      getToolsExpanded: vi.fn(() => false),
    },
    hasUI: false,
    ...overrides,
  } as unknown as ExtensionContext;

  return context;
}

/**
 * Creates a mock {@link Theme}. Each styler passes its `text` argument through
 * unmodified so assertions stay readable.
 */
export function createMockTheme() {
  const theme = {
    fg: vi.fn((_c: string, text: string) => text),
    bg: vi.fn((_c: string, text: string) => text),
    bold: vi.fn((t: string) => t),
  } as unknown as Theme;

  return theme;
}
