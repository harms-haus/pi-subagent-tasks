/** Compact tool-call previews for the live task output window. */

const EMOJI: Record<string, string> = {
  grep: "🔍",
  find: "🔍",
  web_search: "🔍",
  read: "📖",
  edit: "✏️",
  write: "📝",
  ls: "📂",
  bash: "💻",
  write_todos: "✅",
  edit_todos: "✅",
  list_todos: "✅",
  fetch_content: "🌐",
  workflow_step: "▶️",
};

function shortPath(value: unknown, cwd: string): string {
  if (typeof value !== "string" || value.length === 0) return "...";
  if (value === cwd) return ".";
  if (value.startsWith(`${cwd}/`)) return `./${value.slice(cwd.length + 1)}`;
  return value;
}

function text(value: unknown, fallback = "..."): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

/** Match pi-subagents' concise, tool-specific one-line rewriting. */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string {
  const path = shortPath(args.path ?? args.filePath, cwd);
  switch (toolName) {
    case "read":
      return `read -> ${path}${args.offset ? `:${text(args.offset)}` : ""}${args.limit ? ` +${text(args.limit)}` : ""}`;
    case "write": {
      const content = text(args.content, "");
      const lines = content ? content.split(/\r?\n/).filter((line) => line.trim()).length : 0;
      return `write -> ${path} +${lines}`;
    }
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      let added = 0;
      let removed = 0;
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const item = edit as Record<string, unknown>;
        added += text(item.newText, "")
          .split(/\r?\n/)
          .filter((line) => line.trim()).length;
        removed += text(item.oldText, "")
          .split(/\r?\n/)
          .filter((line) => line.trim()).length;
      }
      return `edit -> ${path} +${added}/-${removed}`;
    }
    case "bash":
      return `bash -> ${text(args.command).split(/\r?\n/, 1)[0]}`;
    case "grep":
      return `grep -> /${text(args.pattern)}/${args.path ? ` -> ${shortPath(args.path, cwd)}` : ""}`;
    case "find":
      return `find -> ${text(args.pattern)}${args.path ? ` in ${shortPath(args.path, cwd)}` : ""}`;
    case "ls":
      return `ls -> ${shortPath(args.path, cwd) === "..." ? "." : shortPath(args.path, cwd)}`;
    case "web_search":
      return `web_search -> "${text(args.q ?? args.query)}"`;
    case "write_todos":
      return `write_todos -> ${Array.isArray(args.todos) ? args.todos.length : 0} todos written`;
    case "edit_todos":
      return `edit_todos -> ${text(args.action, "?")}`;
    case "workflow_step":
      return `workflow_step -> ${text(args.action, "?")}`;
    default: {
      const serialized = JSON.stringify(args);
      return serialized === "{}" ? toolName : `${toolName} ${serialized}`;
    }
  }
}

export function toolPreview(toolName: string, args: Record<string, unknown>, cwd: string): string {
  return `${EMOJI[toolName] ?? "🔧"} ${formatToolCall(toolName, args, cwd)}`;
}
