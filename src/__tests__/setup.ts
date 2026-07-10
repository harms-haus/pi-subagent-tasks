import { vi, beforeEach } from "vitest";

import type { Component } from "@earendil-works/pi-tui";

vi.mock("@earendil-works/pi-tui", () => ({
  Text: class implements Component {
    constructor(public content: string) {}
    setText = vi.fn((text: string) => {
      this.content = text;
    });
    setCustomBgFn = vi.fn((_fn?: (text: string) => string) => {});
    invalidate = vi.fn(() => {});
    render = vi.fn(() => [this.content]);
  },
  Container: class implements Component {
    children: object[] = [];
    addChild = vi.fn((c: object) => {
      this.children.push(c);
    });
    removeChild = vi.fn((_c: unknown) => {});
    clear = vi.fn(() => {
      this.children = [];
    });
    invalidate = vi.fn(() => {});
    render = vi.fn(() => [] as string[]);
  },
  Spacer: class implements Component {
    constructor(public lines = 1) {}
    setLines = vi.fn((_lines: number) => {});
    invalidate = vi.fn(() => {});
    render = vi.fn(() => [] as string[]);
  },
  Box: class implements Component {
    children: object[] = [];
    addChild = vi.fn((c: object) => {
      this.children.push(c);
    });
    removeChild = vi.fn((_c: unknown) => {});
    clear = vi.fn(() => {
      this.children = [];
    });
    setBgFn = vi.fn((_fn?: (text: string) => string) => {});
    invalidate = vi.fn(() => {});
    render = vi.fn(() => [] as string[]);
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});
