/**
 * Tests for the profiles module.
 *
 * Covers:
 *   - loadProfiles (global → project override, empty dirs, TTL cache)
 *   - profileToArgs (flags, env vars, scoped apiKey, extraArg validation)
 *   - resolveProfile (found, missing with available list)
 *   - seedMergeHelperProfile (write-if-absent, skip-if-present)
 *   - Security: shell injection rejection, restricted flags rejection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  loadProfiles,
  profileToArgs,
  resolveProfile,
  seedMergeHelperProfile,
  type Profile,
} from "../profiles";
import { getGlobalProfilesDir, getProjectProfilesDir } from "../utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temporary directory and return its path. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `profiles-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a profile markdown file. */
function writeProfile(
  dir: string,
  name: string,
  frontmatter: Record<string, unknown>,
  body = "",
): void {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (typeof value === "boolean") {
      lines.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${String(item)}`);
      }
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push("---");
  if (body) lines.push(body);
  lines.push(""); // trailing newline
  const content = lines.join("\n");
  writeFileSync(join(dir, `${name}.md`), content, "utf-8");
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("profiles module", () => {
  let tempDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir();
    prevAgentDir = process.env.PI_AGENT_DIR;
    process.env.PI_AGENT_DIR = tempDir;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = prevAgentDir;
    }
    // Clean up temp dir
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ── loadProfiles ───────────────────────────────────────────────────────────

  describe("loadProfiles", () => {
    it("returns an empty map when both directories are empty", () => {
      const profiles = loadProfiles("/nonexistent");
      expect(profiles.size).toBe(0);
    });

    it("reads profiles from the global directory", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });

      writeProfile(
        globalDir,
        "coder",
        {
          name: "coder",
          model: "anthropic/claude-sonnet-4-5",
          provider: "anthropic",
        },
        "You are a coding assistant.",
      );

      const profiles = loadProfiles(tempDir);
      expect(profiles.size).toBe(1);
      const coder = profiles.get("coder")!;
      expect(coder.model).toBe("anthropic/claude-sonnet-4-5");
      expect(coder.provider).toBe("anthropic");
      expect(coder.systemPrompt).toBe("You are a coding assistant.");
    });

    it("reads profiles from the project directory", () => {
      const projectDir = getProjectProfilesDir(tempDir);
      mkdirSync(projectDir, { recursive: true });

      writeProfile(
        projectDir,
        "reviewer",
        {
          name: "reviewer",
          thinkingLevel: "high",
          noTools: true,
        },
        "Review the code.",
      );

      const profiles = loadProfiles(tempDir);
      expect(profiles.size).toBe(1);
      const reviewer = profiles.get("reviewer")!;
      expect(reviewer.thinkingLevel).toBe("high");
      expect(reviewer.noTools).toBe(true);
      expect(reviewer.systemPrompt).toBe("Review the code.");
    });

    it("project profiles override global profiles with the same name", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });
      const projectDir = getProjectProfilesDir(tempDir);
      mkdirSync(projectDir, { recursive: true });

      // Global: model = claude-sonnet
      writeProfile(
        globalDir,
        "my-agent",
        {
          name: "my-agent",
          model: "anthropic/claude-sonnet-4-5",
        },
        "Global system prompt.",
      );

      // Project: override with different model
      writeProfile(
        projectDir,
        "my-agent",
        {
          name: "my-agent",
          model: "openai/gpt-4o",
        },
        "Project system prompt.",
      );

      const profiles = loadProfiles(tempDir);
      const agent = profiles.get("my-agent")!;
      // Project should override
      expect(agent.model).toBe("openai/gpt-4o");
      expect(agent.systemPrompt).toBe("Project system prompt.");
    });

    it("preserves global-only and project-only profiles when names differ", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });
      const projectDir = getProjectProfilesDir(tempDir);
      mkdirSync(projectDir, { recursive: true });

      writeProfile(globalDir, "global-agent", { name: "global-agent", model: "m1" }, "G");
      writeProfile(projectDir, "local-agent", { name: "local-agent", model: "m2" }, "L");

      const profiles = loadProfiles(tempDir);
      expect(profiles.size).toBe(2);
      expect(profiles.get("global-agent")!.model).toBe("m1");
      expect(profiles.get("local-agent")!.model).toBe("m2");
    });

    it("reads tools, extensions, skills, and other frontmatter fields from YAML arrays", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });

      const content = `\
---
name: full-agent
model: claude-4
noExtensions: true
tools: bash, read, write
extensions: my-ext, other-ext
suggestedSkills: skill-a, skill-b
loadSkills: skill-c
excludeTools: rm, del
appendSystemPrompt: "Always ask before deleting"
apiKey: sk-123
noSkills: true
noContextFiles: true
---
Do the thing.
`;
      writeFileSync(join(globalDir, "full-agent.md"), content, "utf-8");

      const profiles = loadProfiles(tempDir);
      const agent = profiles.get("full-agent")!;
      expect(agent.model).toBe("claude-4");
      expect(agent.tools).toEqual(["bash", "read", "write"]);
      expect(agent.excludeTools).toEqual(["rm", "del"]);
      expect(agent.noExtensions).toBe(true);
      expect(agent.extensions).toEqual(["my-ext", "other-ext"]);
      expect(agent.suggestedSkills).toEqual(["skill-a", "skill-b"]);
      expect(agent.loadSkills).toEqual(["skill-c"]);
      expect(agent.appendSystemPrompt).toBe("Always ask before deleting");
      expect(agent.apiKey).toBe("sk-123");
      expect(agent.noSkills).toBe(true);
      expect(agent.noContextFiles).toBe(true);
      expect(agent.systemPrompt).toBe("Do the thing.");
    });

    it("parses extraArgs from a YAML array", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });

      const content = `\
---
name: extra-agent
extraArgs:
  - "--verbose"
  - "--temperature=0.5"
---
Body text.
`;
      writeFileSync(join(globalDir, "extra-agent.md"), content, "utf-8");

      const profiles = loadProfiles(tempDir);
      const agent = profiles.get("extra-agent")!;
      expect(agent.extraArgs).toEqual(["--verbose", "--temperature=0.5"]);
    });

    it("skips files without a name in frontmatter", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });

      writeProfile(globalDir, "nameless", { provider: "anthropic" }, "No name.");
      writeProfile(globalDir, "good", { name: "good", model: "m1" }, "Has name.");

      const profiles = loadProfiles(tempDir);
      expect(profiles.size).toBe(1);
      expect(profiles.has("good")).toBe(true);
    });

    it("skips non-markdown files in the directory", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });

      writeFileSync(join(globalDir, "readme.txt"), "hello", "utf-8");
      writeFileSync(join(globalDir, "data.json"), '{"name":"x"}', "utf-8");

      const profiles = loadProfiles(tempDir);
      expect(profiles.size).toBe(0);
    });
  });

  // ── TTL cache ──────────────────────────────────────────────────────────────

  describe("loadProfiles TTL cache", () => {
    it("caches results for 5 seconds keyed by cwd", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });
      writeProfile(globalDir, "fast", { name: "fast", model: "m1" }, "Cached.");

      // First call — populates cache
      const first = loadProfiles(tempDir);
      expect(first.size).toBe(1);

      // Add a second profile on disk
      writeProfile(globalDir, "slow", { name: "slow", model: "m2" }, "Not yet.");

      // Second call — still cached (within 5s TTL)
      const second = loadProfiles(tempDir);
      expect(second.size).toBe(1); // cached, still only "fast"
      expect(second.has("slow")).toBe(false);
    });

    it("reloads after cache expiry", () => {
      vi.useFakeTimers();

      try {
        const globalDir = getGlobalProfilesDir();
        mkdirSync(globalDir, { recursive: true });
        writeProfile(globalDir, "alpha", { name: "alpha", model: "m1" }, "Initial.");

        // Populate cache
        loadProfiles(tempDir);

        // Add new profile
        writeProfile(globalDir, "beta", { name: "beta", model: "m2" }, "Later.");

        // Advance time past TTL (5s)
        vi.advanceTimersByTime(6000);

        // Should re-read from disk now
        const reloaded = loadProfiles(tempDir);
        expect(reloaded.size).toBe(2);
        expect(reloaded.has("alpha")).toBe(true);
        expect(reloaded.has("beta")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── profileToArgs ──────────────────────────────────────────────────────────

  describe("profileToArgs", () => {
    it("produces --provider and --model flags", () => {
      const profile: Profile = {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--provider");
      expect(args).toContain("anthropic");
      expect(args).toContain("--model");
      expect(args).toContain("claude-sonnet-4-5");
    });

    it("produces --system-prompt with the system prompt body", () => {
      const profile: Profile = {
        systemPrompt: "You are a helpful assistant.",
      };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--system-prompt");
      expect(args).toContain("You are a helpful assistant.");
    });

    it("produces --append-system-prompt when set", () => {
      const profile: Profile = {
        appendSystemPrompt: "Follow these rules.",
      };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--append-system-prompt");
      expect(args).toContain("Follow these rules.");
    });

    it("produces --thinking flag", () => {
      const profile: Profile = { thinkingLevel: "high" };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--thinking");
      expect(args).toContain("high");
    });

    it("produces --no-tools when noTools is true", () => {
      const profile: Profile = { noTools: true };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--no-tools");
    });

    it("produces --tools with CSV when tools is set", () => {
      const profile: Profile = { tools: ["bash", "read", "write"] };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--tools");
      expect(args).toContain("bash,read,write");
      // Should not contain --no-tools
      expect(args).not.toContain("--no-tools");
    });

    it("produces --no-extensions when noExtensions is true", () => {
      const profile: Profile = { noExtensions: true };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--no-extensions");
    });

    it("produces repeatable --extension flags", () => {
      const profile: Profile = { extensions: ["ext-a", "ext-b"] };
      const { args } = profileToArgs(profile);
      const extFlags = args.filter((a) => a === "--extension");
      expect(extFlags).toHaveLength(2);
      expect(args).toContain("ext-a");
      expect(args).toContain("ext-b");
    });

    it("produces --no-skills when noSkills is true", () => {
      const profile: Profile = { noSkills: true };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--no-skills");
    });

    it("produces repeatable --skill flags for suggestedSkills", () => {
      const profile: Profile = { suggestedSkills: ["git", "review"] };
      const { args } = profileToArgs(profile);
      const skillFlags = args.filter((a) => a === "--skill");
      expect(skillFlags).toHaveLength(2);
      expect(args).toContain("git");
      expect(args).toContain("review");
    });

    it("produces repeatable --skill flags for loadSkills", () => {
      const profile: Profile = { loadSkills: ["loader"] };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--skill");
      expect(args).toContain("loader");
    });

    it("merges suggestedSkills and loadSkills under --skill flags", () => {
      const profile: Profile = {
        suggestedSkills: ["a", "b"],
        loadSkills: ["c"],
      };
      const { args } = profileToArgs(profile);
      const skillFlags = args.filter((a) => a === "--skill");
      expect(skillFlags).toHaveLength(3);
    });

    it("produces --no-context-files when noContextFiles is true", () => {
      const profile: Profile = { noContextFiles: true };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--no-context-files");
    });

    it("returns empty args and env for an empty profile", () => {
      const { args, env } = profileToArgs({});
      expect(args).toEqual([]);
      expect(env).toEqual({});
    });
  });

  // ── profileToArgs: apiKey → env ────────────────────────────────────────────

  describe("profileToArgs apiKey", () => {
    it("sets PI_API_KEY env var when origin is global", () => {
      const profile: Profile = { apiKey: "sk-abc123", origin: "global" };
      const { env } = profileToArgs(profile);
      expect(env.PI_API_KEY).toBe("sk-abc123");
    });

    it("refuses apiKey and warns when origin is project", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const profile: Profile = { apiKey: "sk-abc123", origin: "project" };
      const { env } = profileToArgs(profile);
      expect(env.PI_API_KEY).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing to export apiKey"));
      warnSpy.mockRestore();
    });

    it("does not set PI_API_KEY when origin is undefined", () => {
      const profile: Profile = { apiKey: "sk-abc123" };
      const { env } = profileToArgs(profile);
      expect(env.PI_API_KEY).toBeUndefined();
    });
  });

  // ── profileToArgs: extraArgs security ──────────────────────────────────────

  describe("profileToArgs extraArgs security", () => {
    it("passes through valid extra args", () => {
      const profile: Profile = { extraArgs: ["--verbose", "--temperature=0.5"] };
      const { args } = profileToArgs(profile);
      expect(args).toContain("--verbose");
      expect(args).toContain("--temperature=0.5");
    });

    it("rejects extra args with shell metacharacters", () => {
      const injections = [
        "$(rm -rf /)",
        "`cat /etc/passwd`",
        "| cat /etc/passwd",
        "arg; rm -rf",
        "arg&",
        "arg$HOME",
        "arg`ls`",
        "arg!",
        "arg%",
        "arg^",
        "arg<file",
        "arg>file",
        "arg\rfoo",
      ];

      for (const bad of injections) {
        const profile: Profile = { extraArgs: [bad] };
        expect(() => profileToArgs(profile)).toThrow(/contains shell metacharacters/);
      }
    });

    it("rejects extra args with null bytes", () => {
      const profile: Profile = { extraArgs: ["good\0bad"] };
      expect(() => profileToArgs(profile)).toThrow(/contains shell metacharacters/);
    });

    it("rejects --tools extra arg when tools restriction is active", () => {
      const profile: Profile = {
        tools: ["bash"],
        extraArgs: ["--tools", "read"],
      };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });

    it("rejects --no-tools extra arg when noTools is true", () => {
      const profile: Profile = {
        noTools: true,
        extraArgs: ["--tools=read"],
      };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });

    it("rejects --no-extensions extra arg when noExtensions is true", () => {
      const profile: Profile = {
        noExtensions: true,
        extraArgs: ["--extension=x"],
      };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });

    it("rejects --skill extra arg when noSkills is true", () => {
      const profile: Profile = {
        noSkills: true,
        extraArgs: ["--skill=bad"],
      };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });

    it("rejects --no-context-files extra arg when noContextFiles is true", () => {
      const profile: Profile = {
        noContextFiles: true,
        extraArgs: ["--context-file=foo"],
      };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });

    it("rejects --tools extra arg when excludeTools is set", () => {
      const profile: Profile = {
        excludeTools: ["rm"],
        extraArgs: ["--tools=bash"],
      };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });

    it("rejects always-restricted flag --provider in extraArgs", () => {
      const profile: Profile = { origin: "global", extraArgs: ["--provider", "x"] };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });

    it("rejects always-restricted flag --model in extraArgs", () => {
      const profile: Profile = { origin: "global", extraArgs: ["--model", "x"] };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });

    it("rejects always-restricted flag --system-prompt in extraArgs", () => {
      const profile: Profile = { origin: "global", extraArgs: ["--system-prompt", "x"] };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });

    it("rejects always-restricted flag --append-system-prompt in extraArgs", () => {
      const profile: Profile = {
        origin: "global",
        extraArgs: ["--append-system-prompt", "x"],
      };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });

    it("rejects always-restricted flag --thinking in extraArgs", () => {
      const profile: Profile = { origin: "global", extraArgs: ["--thinking", "x"] };
      expect(() => profileToArgs(profile)).toThrow(/restricted by profile/);
    });
  });

  // ── resolveProfile ─────────────────────────────────────────────────────────

  describe("resolveProfile", () => {
    it("returns the profile when found", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });
      writeProfile(globalDir, "coder", { name: "coder", model: "m1" }, "Code.");

      const profile = resolveProfile("coder", tempDir);
      expect(profile.model).toBe("m1");
      expect(profile.systemPrompt).toBe("Code.");
    });

    it("throws a descriptive error when profile is not found", () => {
      // No profiles at all
      expect(() => resolveProfile("missing", tempDir)).toThrow(/Profile "missing" not found/);
    });

    it("includes available profile names in the error message", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });
      writeProfile(globalDir, "alpha", { name: "alpha", model: "m1" }, "A");
      writeProfile(globalDir, "beta", { name: "beta", model: "m2" }, "B");

      expect(() => resolveProfile("gamma", tempDir)).toThrow(/available names: alpha, beta/);
    });

    it("includes the directories searched in the error message", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });

      try {
        resolveProfile("nope", tempDir);
        // Force failure if no error thrown
        expect(true).toBe(false);
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain(globalDir);
        expect(msg).toContain(getProjectProfilesDir(tempDir));
      }
    });

    it('says "no profiles found" when no profiles exist', () => {
      expect(() => resolveProfile("x", tempDir)).toThrow(/no profiles found/);
    });
  });

  // ── Error-handling branches in readProfilesDir ──────────────────────────────

  describe("readProfilesDir error branches", () => {
    it("handles readdirSync error gracefully (file instead of dir)", () => {
      // When the path exists but is a file (not a dir), existsSync returns true
      // but readdirSync throws ENOTDIR.
      const globalDir = getGlobalProfilesDir();
      // Ensure parent dir exists
      mkdirSync(join(globalDir, ".."), { recursive: true });
      // Create a file at the profiles dir path
      writeFileSync(globalDir, "this is a file, not a directory", "utf-8");

      const profiles = loadProfiles(tempDir);
      expect(profiles.size).toBe(0);
    });

    it("handles readdirSync error gracefully (nonexistent dir, early exit)", () => {
      // A non-existent directory — existsSync returns false, early exit before readdirSync
      const profiles = loadProfiles("/nonexistent-path-xyz");
      expect(profiles.size).toBe(0);
    });

    it("skips files that fail statSync (broken symlink)", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });

      // Create a broken symlink; statSync on it will throw ENOENT
      const brokenLink = join(globalDir, "bad.md");
      try {
        symlinkSync("/nonexistent-target", brokenLink);

        // Also create a valid profile
        writeProfile(globalDir, "good", { name: "good", model: "m1" }, "Valid.");

        const profiles = loadProfiles(tempDir);
        expect(profiles.size).toBe(1);
        expect(profiles.has("good")).toBe(true);
        // Broken symlink should have been skipped
      } catch {
        // Platform doesn't support symlinks — skip this scenario
        // Just verify the valid profile still loads
        writeProfile(globalDir, "good", { name: "good", model: "m1" }, "Valid.");
        const profiles = loadProfiles(tempDir);
        expect(profiles.size).toBe(1);
        expect(profiles.has("good")).toBe(true);
      }
    });

    it("skips files that fail readFileSync (unreadable file)", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });

      writeFileSync(join(globalDir, "test.md"), "---\nname: test\n---\nbody", "utf-8");
      // Also write a valid readable profile
      writeProfile(globalDir, "good", { name: "good", model: "m1" }, "Valid.");

      // Make test.md unreadable (platform-dependent; skip if not supported)
      try {
        chmodSync(join(globalDir, "test.md"), 0o000);

        const profiles = loadProfiles(tempDir);
        expect(profiles.size).toBe(1);
        expect(profiles.has("good")).toBe(true);
        // Unreadable test.md should have been skipped

        chmodSync(join(globalDir, "test.md"), 0o644); // Restore for cleanup
      } catch {
        // Platform doesn't support chmod (Windows) — skip
      }
    });

    it("skips files with malformed YAML frontmatter without crashing", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });

      // Write a valid profile
      writeProfile(globalDir, "good", { name: "good", model: "m1" }, "Valid.");

      // Write a file with malformed YAML frontmatter that will cause
      // parseFrontmatter to throw
      const malformedPath = join(globalDir, "bad.md");
      writeFileSync(malformedPath, "---\n: [unclosed\n---\nThis is broken YAML.\n", "utf-8");

      const profiles = loadProfiles(tempDir);
      // Only the valid profile should be returned; the malformed one is skipped
      expect(profiles.size).toBe(1);
      expect(profiles.has("good")).toBe(true);
      expect(profiles.has("bad")).toBe(false);
    });
  });

  // ── seedMergeHelperProfile ─────────────────────────────────────────────────

  describe("seedMergeHelperProfile", () => {
    it("creates merge-helper.md in the global profiles dir when absent", () => {
      const globalDir = getGlobalProfilesDir();
      expect(existsSync(globalDir)).toBe(false);

      seedMergeHelperProfile();

      expect(existsSync(globalDir)).toBe(true);
      const targetPath = join(globalDir, "merge-helper.md");
      expect(existsSync(targetPath)).toBe(true);

      const content = readFileSync(targetPath, "utf-8");
      expect(content).toContain("name: merge-helper");
      expect(content).toContain("resolve git merge conflicts");
    });

    it("is idempotent — does not overwrite an existing file", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });
      const targetPath = join(globalDir, "merge-helper.md");
      writeFileSync(targetPath, "custom content", "utf-8");

      // Should NOT overwrite
      seedMergeHelperProfile();

      const content = readFileSync(targetPath, "utf-8");
      expect(content).toBe("custom content");
    });

    it("works when the profiles dir already exists", () => {
      const globalDir = getGlobalProfilesDir();
      mkdirSync(globalDir, { recursive: true });

      seedMergeHelperProfile();

      const targetPath = join(globalDir, "merge-helper.md");
      expect(existsSync(targetPath)).toBe(true);
    });
  });
});
