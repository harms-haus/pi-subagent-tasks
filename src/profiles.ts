/**
 * Profile loading, CLI-arg construction, and profile resolution for
 * pi-task-pools.
 *
 * @module profiles
 *
 * §11   (agent profiles), D4 (profiles directory layout), D15 (security).
 *
 * Profiles are stored as Markdown files with YAML frontmatter in:
 *   - Global: `<agentDir>/profiles/*.md`
 *   - Project: `<cwd>/.pi/profiles/*.md`  (overrides global same-name)
 *
 * The module exposes a 5-second TTL cache keyed by `cwd` for the merged
 * profile map.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getGlobalProfilesDir, getProjectProfilesDir } from "./utils";

// ── Types ────────────────────────────────────────────────────────────────────

/** A resolved profile definition from a `.md` frontmatter file. */
export interface Profile {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  thinkingLevel?: string;
  noTools?: boolean;
  tools?: string[];
  excludeTools?: string[];
  noExtensions?: boolean;
  extensions?: string[];
  noSkills?: boolean;
  suggestedSkills?: string[];
  loadSkills?: string[];
  noContextFiles?: boolean;
  apiKey?: string;
  extraArgs?: string[];
  /** Whether this profile was loaded from the global or project directory.
   *  Used to enforce that apiKey is only exported for global profiles. */
  origin?: "global" | "project";
}

/** Security validation result for an extra arg. */
interface ArgValidation {
  valid: boolean;
  reason?: string;
}

// ── TTL cache ────────────────────────────────────────────────────────────────

interface CacheEntry {
  profiles: Map<string, Profile>;
  timestamp: number;
}

const TTL_MS = 5000;
const profileCache = new Map<string, CacheEntry>();

// ── Shell-metacharacter detection ────────────────────────────────────────────

/** Regex matching any shell metacharacter that could be used for injection. */
const SHELL_META_RE = /[|&;$`!%^<>\r\n\0]/;

// ── Tool / extension / skill / context flag patterns ─────────────────────────

/** Flags that relate to tool configuration. */
const TOOL_FLAGS = ["--tool", "--tools", "--no-tools", "--exclude-tools"];
/** Flags that relate to extension configuration. */
const EXTENSION_FLAGS = ["--extension", "--extensions", "--no-extensions"];
/** Flags that relate to skill configuration. */
const SKILL_FLAGS = ["--skill", "--skills", "--no-skills", "--suggested-skills", "--load-skills"];
/** Flags that relate to context-file configuration. */
const CONTEXT_FLAGS = ["--context-file", "--context-files", "--no-context-files"];

/** Flags that are always restricted (they conflict with declared fields in profileToArgs). */
const ALWAYS_RESTRICTED_FLAGS = [
  "--system-prompt",
  "--append-system-prompt",
  "--provider",
  "--model",
  "--thinking",
];

/** All restricted flag prefixes (for checking extra args). */
function restrictedFlagsFor(profile: Profile): string[] {
  const restricted: string[] = [...ALWAYS_RESTRICTED_FLAGS];
  if (profile.noTools || profile.tools || profile.excludeTools) restricted.push(...TOOL_FLAGS);
  if (profile.noExtensions || profile.extensions) restricted.push(...EXTENSION_FLAGS);
  if (profile.noSkills || profile.suggestedSkills || profile.loadSkills)
    restricted.push(...SKILL_FLAGS);
  if (profile.noContextFiles) restricted.push(...CONTEXT_FLAGS);
  return restricted;
}

/**
 * Check whether `arg` matches any of the restricted flags (by prefix).
 * Matches both `--flag` and `--flag=value` forms.
 */
function isRestricted(arg: string, restricted: string[]): boolean {
  for (const flag of restricted) {
    if (arg === flag || arg.startsWith(flag + "=") || arg.startsWith(flag + " ")) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a single extra arg for security.
 *
 * Rejects:
 *   - Null bytes (`\0`)
 *   - Shell metacharacters (`| & ; $ ` ! % ^ < > \r`)
 *   - Tool/ext/skill/context flags when the corresponding restriction is active
 */
function validateExtraArg(arg: string, profile: Profile): ArgValidation {
  if (SHELL_META_RE.test(arg)) {
    return { valid: false, reason: `contains shell metacharacters` };
  }
  const restricted = restrictedFlagsFor(profile);
  if (isRestricted(arg, restricted)) {
    return { valid: false, reason: `flag ${arg} is restricted by profile configuration` };
  }
  return { valid: true };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Read all `.md` files from a single profiles directory.
 * Returns a map of basename (without `.md`) → Profile.
 *
 * Files that cannot be parsed (missing frontmatter, invalid YAML, missing
 * `name` field, or any other parse error) are silently skipped — a single
 * malformed file never crashes sibling loading.
 *
 * @param dir    - Path to the profiles directory.
 * @param origin - `"global"` or `"project"` — recorded in each profile's
 *                 {@link Profile.origin} field for apiKey-scoping decisions.
 */
function readProfilesDir(dir: string, origin: "global" | "project"): Map<string, Profile> {
  const result = new Map<string, Profile>();

  if (!existsSync(dir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(content);
    } catch {
      // Malformed YAML frontmatter — skip this file, keep loading siblings
      continue;
    }

    const frontmatter = parsed.frontmatter;
    const name = frontmatter.name;
    if (typeof name !== "string" || !name) continue;

    const profile: Profile = { origin };

    try {
      if (typeof frontmatter.provider === "string" && frontmatter.provider) {
        profile.provider = frontmatter.provider;
      }
      if (typeof frontmatter.model === "string" && frontmatter.model) {
        profile.model = frontmatter.model;
      }
      if (typeof frontmatter.thinkingLevel === "string" && frontmatter.thinkingLevel) {
        profile.thinkingLevel = frontmatter.thinkingLevel;
      }
      if (typeof frontmatter.noTools === "boolean") {
        profile.noTools = frontmatter.noTools;
      }
      if (typeof frontmatter.tools === "string" && frontmatter.tools) {
        profile.tools = frontmatter.tools
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (typeof frontmatter.excludeTools === "string" && frontmatter.excludeTools) {
        profile.excludeTools = frontmatter.excludeTools
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (typeof frontmatter.noExtensions === "boolean") {
        profile.noExtensions = frontmatter.noExtensions;
      }
      if (typeof frontmatter.extensions === "string" && frontmatter.extensions) {
        profile.extensions = frontmatter.extensions
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (typeof frontmatter.noSkills === "boolean") {
        profile.noSkills = frontmatter.noSkills;
      }
      if (typeof frontmatter.suggestedSkills === "string" && frontmatter.suggestedSkills) {
        profile.suggestedSkills = frontmatter.suggestedSkills
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (typeof frontmatter.loadSkills === "string" && frontmatter.loadSkills) {
        profile.loadSkills = frontmatter.loadSkills
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (typeof frontmatter.noContextFiles === "boolean") {
        profile.noContextFiles = frontmatter.noContextFiles;
      }
      if (typeof frontmatter.apiKey === "string" && frontmatter.apiKey) {
        profile.apiKey = frontmatter.apiKey;
      }
      if (typeof frontmatter.appendSystemPrompt === "string" && frontmatter.appendSystemPrompt) {
        profile.appendSystemPrompt = frontmatter.appendSystemPrompt;
      }

      // extraArgs (if present as a YAML array)
      if (Array.isArray(frontmatter.extraArgs)) {
        profile.extraArgs = frontmatter.extraArgs.map(String);
      }

      // The body (after frontmatter) becomes the system prompt
      let body: string;
      try {
        body = parsed.body.trim();
      } catch {
        body = "";
      }
      if (body) {
        profile.systemPrompt = body;
      }
    } catch {
      // Field extraction failed — skip this file
      continue;
    }

    result.set(name, profile);
  }

  return result;
}

/**
 * Merge `source` profiles into `target`, overwriting same-named entries.
 * Returns the merged map.
 */
function mergeProfiles(
  target: Map<string, Profile>,
  source: Map<string, Profile>,
): Map<string, Profile> {
  const merged = new Map(target);
  for (const [key, value] of source) {
    merged.set(key, value);
  }
  return merged;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load all profiles from global and project directories.
 *
 * Global profiles come from `<agentDir>/profiles/*.md`.
 * Project profiles come from `<cwd>/.pi/profiles/*.md` and override global
 * profiles with the same name.
 *
 * Results are cached for 5 seconds keyed by `cwd`. Callers that know the
 * on-disk files have changed should force a re-read by waiting for TTL expiry
 * (or, in future, calling an explicit `invalidateProfileCache`).
 *
 * @param cwd - The working directory for resolving project profiles.
 * @returns A map of profile name → Profile.
 */
export function loadProfiles(cwd: string): Map<string, Profile> {
  const now = Date.now();
  const cached = profileCache.get(cwd);
  if (cached && now - cached.timestamp < TTL_MS) {
    return cached.profiles;
  }

  const globalDir = getGlobalProfilesDir();
  const projectDir = getProjectProfilesDir(cwd);

  const global = readProfilesDir(globalDir, "global");
  const project = readProfilesDir(projectDir, "project");

  const merged = mergeProfiles(global, project);

  profileCache.set(cwd, { profiles: merged, timestamp: now });
  return merged;
}

/**
 * Convert a resolved {@link Profile} into CLI args and environment variables
 * suitable for spawning a pi-agent child process.
 *
 * @param profile - The resolved profile to convert.
 * @returns An object containing `args` (string array of CLI flags) and `env`
 *          (environment variable overrides).
 */
export function profileToArgs(profile: Profile): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};

  // ── provider ──────────────────────────────────────────────────────────
  if (profile.provider) {
    args.push("--provider", profile.provider);
  }

  // ── model ─────────────────────────────────────────────────────────────
  if (profile.model) {
    args.push("--model", profile.model);
  }

  // ── system prompt ─────────────────────────────────────────────────────
  if (profile.systemPrompt) {
    args.push("--system-prompt", profile.systemPrompt);
  }

  // ── append system prompt (repeatable) ─────────────────────────────────
  // The YAML frontmatter field is a single string; to support multiple
  // appends, a profile author may use YAML block scalars or we could
  // support a YAML array. For now, one value → one `--append-system-prompt`.
  if (profile.appendSystemPrompt) {
    args.push("--append-system-prompt", profile.appendSystemPrompt);
  }

  // ── thinking level ────────────────────────────────────────────────────
  if (profile.thinkingLevel) {
    args.push("--thinking", profile.thinkingLevel);
  }

  // ── tools ─────────────────────────────────────────────────────────────
  if (profile.noTools) {
    args.push("--no-tools");
  } else {
    if (profile.tools && profile.tools.length > 0) {
      args.push("--tools", profile.tools.join(","));
    }
    if (profile.excludeTools && profile.excludeTools.length > 0) {
      args.push("--exclude-tools", profile.excludeTools.join(","));
    }
  }

  // ── extensions ────────────────────────────────────────────────────────
  if (profile.noExtensions) {
    args.push("--no-extensions");
  } else if (profile.extensions && profile.extensions.length > 0) {
    for (const ext of profile.extensions) {
      args.push("--extension", ext);
    }
  }

  // ── skills ────────────────────────────────────────────────────────────
  if (profile.noSkills) {
    args.push("--no-skills");
  } else {
    if (profile.suggestedSkills && profile.suggestedSkills.length > 0) {
      for (const skill of profile.suggestedSkills) {
        args.push("--skill", skill);
      }
    }
    if (profile.loadSkills && profile.loadSkills.length > 0) {
      for (const skill of profile.loadSkills) {
        args.push("--skill", skill);
      }
    }
  }

  // ── context files ─────────────────────────────────────────────────────
  if (profile.noContextFiles) {
    args.push("--no-context-files");
  }

  // ── apiKey → env ──────────────────────────────────────────────────────
  if (profile.apiKey) {
    if (profile.origin === "global") {
      env.PI_API_KEY = profile.apiKey;
    } else {
      // Refuse: log a warning but don't set the env var
      console.warn(
        `[profiles] refusing to export apiKey for profile of origin "${profile.origin ?? "unknown"}"; ` +
          `set API key via PI_API_KEY env var or use a global profile`,
      );
    }
  }

  // ── extraArgs (security-validated) ────────────────────────────────────
  if (profile.extraArgs && profile.extraArgs.length > 0) {
    for (const arg of profile.extraArgs) {
      const validation = validateExtraArg(arg, profile);
      if (!validation.valid) {
        throw new Error(
          `[profiles] rejected extra arg "${arg}": ${validation.reason ?? "security validation failed"}`,
        );
      }
      args.push(arg);
    }
  }

  return { args, env };
}

/**
 * Resolve a profile by name, loading profiles from disk if necessary.
 *
 * @param name - The profile name (basename without `.md`).
 * @param cwd  - The working directory for resolving project profiles.
 * @returns The resolved {@link Profile}.
 * @throws Error if the named profile is not found, listing available names
 *         and the directories that were searched.
 */
export function resolveProfile(name: string, cwd: string): Profile {
  const profiles = loadProfiles(cwd);
  const profile = profiles.get(name);
  if (profile === undefined) {
    const globalDir = getGlobalProfilesDir();
    const projectDir = getProjectProfilesDir(cwd);
    const available = Array.from(profiles.keys());
    const availableStr =
      available.length > 0 ? `available names: ${available.join(", ")}` : "no profiles found";
    throw new Error(
      `Profile "${name}" not found.\n` +
        `Searched:\n` +
        `  - ${globalDir}\n` +
        `  - ${projectDir}\n` +
        availableStr,
    );
  }
  return profile;
}

/**
 * Seed the global profiles directory with the bundled `merge-helper.md`
 * default profile, if it does not already exist.
 *
 * This is idempotent — if `merge-helper.md` already exists on disk it is
 * never overwritten. Uses `writeFileSync` with `{ flag: "wx" }` and swallows
 * `EEXIST` for race-safe idempotency.
 */
export function seedMergeHelperProfile(): void {
  const targetDir = getGlobalProfilesDir();
  const targetPath = join(targetDir, "merge-helper.md");

  mkdirSync(targetDir, { recursive: true });

  const sourcePath = fileURLToPath(new URL("./defaults/merge-helper.md", import.meta.url));
  const content = readFileSync(sourcePath, "utf-8");

  try {
    writeFileSync(targetPath, content, { flag: "wx" });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return; // File already exists, idempotent
    }
    throw err;
  }
}
