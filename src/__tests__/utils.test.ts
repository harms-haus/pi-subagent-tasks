import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  slugify,
  timecode,
  formatElapsed,
  getAgentDir,
  getGlobalProfilesDir,
  getProjectProfilesDir,
  poolDir,
} from "../utils";
import { STATE_DIR_REL } from "../constants";

// ── slugify ──────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("slugifies a basic labelled string", () => {
    expect(slugify("My Pool!")).toBe("my-pool");
  });

  it("lowercases letters and keeps digits", () => {
    expect(slugify("ABC123")).toBe("abc123");
  });

  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("returns empty string for all-punctuation input", () => {
    expect(slugify("---")).toBe("");
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
  });

  it("trims leading and trailing punctuation", () => {
    expect(slugify("  hello  ")).toBe("hello");
    expect(slugify("___hello___")).toBe("hello");
    expect(slugify("---abc")).toBe("abc");
    expect(slugify("abc...")).toBe("abc");
  });

  it("collapses runs of non-alphanumeric into a single dash", () => {
    expect(slugify("foo   bar")).toBe("foo-bar");
    expect(slugify("foo...bar")).toBe("foo-bar");
    expect(slugify("a b!c@d")).toBe("a-b-c-d");
    expect(slugify("release  feature  name")).toBe("release-feature-name");
  });
});

// ── timecode ─────────────────────────────────────────────────────────────────

describe("timecode", () => {
  it("matches the canonical UTC format YYYYMMDDTHHMMSSZ", () => {
    expect(timecode()).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("is 16 characters long and ends with Z", () => {
    const tc = timecode();
    expect(tc).toHaveLength(16);
    expect(tc.endsWith("Z")).toBe(true);
  });

  it("starts with the current UTC year", () => {
    const year = String(new Date().getUTCFullYear());
    expect(timecode().startsWith(year)).toBe(true);
  });
});

// ── formatElapsed ────────────────────────────────────────────────────────────

describe("formatElapsed", () => {
  it("renders sub-second durations as <1s", () => {
    expect(formatElapsed(0)).toBe("<1s");
    expect(formatElapsed(1)).toBe("<1s");
    expect(formatElapsed(999)).toBe("<1s");
  });

  it("renders seconds", () => {
    expect(formatElapsed(1000)).toBe("1s");
    expect(formatElapsed(5000)).toBe("5s");
    expect(formatElapsed(59999)).toBe("59s");
  });

  it("renders minutes", () => {
    expect(formatElapsed(60000)).toBe("1m");
    expect(formatElapsed(120000)).toBe("2m");
    expect(formatElapsed(3599999)).toBe("59m");
  });

  it("renders hours", () => {
    expect(formatElapsed(3600000)).toBe("1h");
    expect(formatElapsed(7200000)).toBe("2h");
  });
});

// ── env-dependent path helpers ───────────────────────────────────────────────

describe("getAgentDir", () => {
  const prev = process.env.PI_AGENT_DIR;

  afterEach(() => {
    if (prev === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = prev;
  });

  it("honors PI_AGENT_DIR when set", () => {
    process.env.PI_AGENT_DIR = "/custom/agent";
    expect(getAgentDir()).toBe("/custom/agent");
  });

  it("falls back to ~/.pi/agent when unset", () => {
    delete process.env.PI_AGENT_DIR;
    expect(getAgentDir()).toBe(join(homedir(), ".pi", "agent"));
  });
});

describe("profiles directories", () => {
  const prev = process.env.PI_AGENT_DIR;

  afterEach(() => {
    if (prev === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = prev;
  });

  it("global profiles dir is <agentDir>/profiles (NOT agent-profiles)", () => {
    process.env.PI_AGENT_DIR = "/custom/agent";
    expect(getGlobalProfilesDir()).toBe("/custom/agent/profiles");
  });

  it("project profiles dir is <cwd>/.pi/profiles", () => {
    expect(getProjectProfilesDir("/repo")).toBe(join("/repo", ".pi", "profiles"));
  });
});

// ── poolDir ──────────────────────────────────────────────────────────────────

describe("poolDir", () => {
  it("joins cwd + state dir + id", () => {
    expect(poolDir("/repo", "release-feature")).toBe(
      join("/repo", STATE_DIR_REL, "release-feature"),
    );
  });

  it("uses the STATE_DIR_REL constant (.pi/subagent-tasks)", () => {
    expect(poolDir("/repo", "x")).toBe("/repo/.pi/subagent-tasks/x");
  });
});
