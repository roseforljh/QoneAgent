import { toolFileChanges } from "@qone/protocol";

export type ToolActivityCategory = "file-change" | "exploration" | "command" | "integration" | "tool";

const FILE_CHANGE_TOOLS = new Set(["edit", "write", "apply_patch"]);
const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "glob", "ls"]);
const COMMAND_TOOLS = new Set(["bash", "powershell", "shell", "sh", "exec", "run", "run_command"]);
const BUILTIN_INTEGRATION_TOOLS = new Set(["qone_web_read", "qone_github_public"]);

export function isCommandTool(part: { toolName: string }): boolean {
  return COMMAND_TOOLS.has(part.toolName.toLowerCase());
}

export function toolActivityCategory(toolName: string, result?: unknown): ToolActivityCategory {
  if (FILE_CHANGE_TOOLS.has(toolName)) return "file-change";
  if (EXPLORATION_TOOLS.has(toolName)) return "exploration";
  if (isCommandTool({ toolName })) return "command";
  return result !== undefined && toolFileChanges(result).length > 0 ? "file-change" : "tool";
}

export function isIntegrationTool(toolName: string): boolean {
  return toolName.startsWith("mcp:") || BUILTIN_INTEGRATION_TOOLS.has(toolName);
}
