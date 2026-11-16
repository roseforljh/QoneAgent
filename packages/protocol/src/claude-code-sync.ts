export type ClaudeCodeSyncTarget = "prompt" | "mcp" | "skills";
export type ClaudeCodeSyncIssue = { name: string; code: "invalid" | "unreadable" | "missing-variable" | "needs-auth" | "conflict" | "builtin" | "duplicate" | "storage"; detail?: string };
export interface ClaudeCodeSyncResult {
  target: ClaudeCodeSyncTarget;
  status: "not-installed" | "empty" | "confirm" | "ready" | "complete";
  revision: string;
  found: number;
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  removed?: number;
  conflicts: string[];
  issues: ClaudeCodeSyncIssue[];
}
