// Tool approval policy. This is a gate for model-initiated tools, not an OS
// sandbox: a shell command or third-party tool can perform arbitrary I/O once
// approved. Keep that distinction visible when changing the mode descriptions.

import { createLogger } from "@qone/shared";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { RunPermissionMode } from "@qone/protocol";

const log = createLogger("permission");

export type PermissionDecision = "allow" | "ask" | "deny";

export type ApprovalPolicy = "on-request" | "unless-trusted" | "never";
export type FileSystemAccess = "read-only" | "workspace-write" | "full";
export type NetworkAccess = "restricted" | "enabled";

/**
 * The three UI modes deliberately map to the same two axes used by Codex:
 * approval routing and the effective filesystem/network profile. The wrapper
 * below still provides the product's finer tool-level trust decisions.
 */
export interface PermissionProfile {
  approval: ApprovalPolicy;
  filesystem: FileSystemAccess;
  network: NetworkAccess;
}

export const PERMISSION_PROFILES: Record<RunPermissionMode, PermissionProfile> = {
  ask: { approval: "on-request", filesystem: "read-only", network: "restricted" },
  auto: { approval: "unless-trusted", filesystem: "workspace-write", network: "restricted" },
  full: { approval: "never", filesystem: "full", network: "enabled" },
};

export function permissionProfile(mode: RunPermissionMode = "ask"): PermissionProfile {
  return PERMISSION_PROFILES[mode];
}

export interface PermissionRuleStore {
  get(subjectId: string, permission: string): PermissionDecision | undefined;
}

export interface ToolContext {
  toolName: string;
  args?: unknown;
  workspacePath?: string;
}

export type QoneToolDefinition = ToolDefinition & { qoneToolName?: string };

function logicalToolName(tool: ToolDefinition): string {
  return (tool as QoneToolDefinition).qoneToolName ?? tool.name;
}

const TOOL_PERMISSIONS: Record<string, PermissionDecision> = {
  read: "allow",
  grep: "allow",
  find: "allow",
  ls: "allow",
  present: "allow",

  write: "ask",
  edit: "ask",

  bash: "ask",
  powershell: "ask",

  "browser.open": "ask",
  "browser.navigate": "ask",
  "browser.click": "ask",
  "browser.type": "ask",
  // A caller may provide an arbitrary output path; keep screenshot writes
  // behind approval just like downloads unless the product later adds a
  // dedicated artifact-path policy.
  "browser.screenshot": "ask",
  "browser.snapshot": "allow",
  "browser.extract": "allow",
  "browser.close": "allow",
  "browser.download": "ask",
};

const DENY_PREFIXES = [
  /^[a-z]:[\\/]windows(?:[\\/]|$)/i,
  /^[a-z]:[\\/]program files(?:[\\/]|$)/i,
  /(?:^|[/\\])\.ssh(?:[/\\]|$)/i,
  /(?:^|[/\\])\.aws(?:[/\\]|$)/i,
  /(?:^|[/\\])\.gnupg(?:[/\\]|$)/i,
];

const DENY_PATH_TEXT = [
  /(?:^|[\s"'`])(?:[a-z]:[\\/]windows)(?:[\\/\s"'`]|$)/i,
  /(?:^|[\s"'`])(?:[a-z]:[\\/]program files)(?:[\\/\s"'`]|$)/i,
  /(?:^|[\s"'`])[^\s"'`]*[/\\]\.ssh[/\\][^\s"'`]*/i,
  /(?:^|[\s"'`])[^\s"'`]*[/\\]\.aws[/\\][^\s"'`]*/i,
  /(?:^|[\s"'`])[^\s"'`]*[/\\]\.gnupg[/\\][^\s"'`]*/i,
];

function canonicalPath(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    try {
      return path.join(realpathSync.native(path.dirname(target)), path.basename(target));
    } catch {
      return target;
    }
  }
}

function insideWorkspace(target: string, workspacePath: string): boolean {
  const ws = canonicalPath(path.resolve(workspacePath)).toLowerCase();
  const resolved = canonicalPath(path.resolve(workspacePath, target)).toLowerCase();
  return resolved === ws || resolved.startsWith(`${ws}${path.sep}`);
}

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const MUTATING_FILE_TOOLS = new Set(["write", "edit"]);
const AUTO_BROWSER_TOOLS = new Set(["browser.open", "browser.navigate", "browser.snapshot", "browser.extract", "browser.close"]);

function pathArgument(ctx: ToolContext): string | undefined {
  const args = ctx.args as Record<string, unknown> | undefined;
  const candidate = args?.path ?? args?.file ?? (ctx.toolName === "powershell" || ctx.toolName === "bash" ? args?.cwd : undefined);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function outsideWorkspace(ctx: ToolContext): boolean {
  const target = pathArgument(ctx);
  return !!(target && ctx.workspacePath && FILE_TOOLS.has(ctx.toolName) && !insideWorkspace(target, ctx.workspacePath));
}

function autoApprovesCapability(ctx: ToolContext, capability: string): boolean {
  if (MUTATING_FILE_TOOLS.has(ctx.toolName)) {
    const target = pathArgument(ctx);
    return capability === "filesystem.write" && !!target && !!ctx.workspacePath && insideWorkspace(target, ctx.workspacePath);
  }
  if (AUTO_BROWSER_TOOLS.has(ctx.toolName)) {
    return capability === "browser.control" || capability === "network";
  }
  return false;
}

export function decide(ctx: ToolContext): PermissionDecision {
  const pathArg = pathArgument(ctx);
  const args = ctx.args as Record<string, unknown> | undefined;
  const command = typeof args?.command === "string" ? args.command : undefined;

  if (command && DENY_PATH_TEXT.some((re) => re.test(command))) return "deny";

  const resolvedPath = pathArg
    ? canonicalPath(path.resolve(ctx.workspacePath ?? process.cwd(), pathArg))
    : undefined;
  if (resolvedPath && DENY_PREFIXES.some((re) => re.test(resolvedPath.replaceAll("\\", "/")))) {
    return "deny";
  }

  const base = TOOL_PERMISSIONS[ctx.toolName] ?? "ask";

  // Workspace boundary: file-mutating tools pointing outside the workspace ask.
  if (outsideWorkspace(ctx)) return "ask";

  return base;
}

export interface PermissionEvaluation {
  decision: PermissionDecision;
  permissions: string[];
  reason: "protected-path" | "rule" | "workspace" | "approval" | "allowed";
}

/** Explicit denials and protected paths are checked before mode-based approval. */
export function evaluatePermission(
  ctx: ToolContext,
  mode: RunPermissionMode = "ask",
  rules?: PermissionRuleStore,
  declaredPermissions: readonly string[] = [],
): PermissionEvaluation {
  const profile = permissionProfile(mode);
  const declared = [...new Set(declaredPermissions)];
  const basePermissions = permissionNames(ctx.toolName);
  // A plugin's manifest is its capability declaration. Do not add the
  // generic fallback capability when the plugin has declared concrete ones.
  const permissions = [...new Set(
    ctx.toolName.startsWith("plugin:") && declared.length > 0
      ? declared
      : [...basePermissions, ...declared],
  )];
  const base = decide(ctx);
  if (base === "deny") return { decision: "deny", permissions, reason: "protected-path" };
  const subject = permissionSubject(ctx.toolName);
  if (permissions.some((permission) => rules?.get(subject, permission) === "deny")) {
    return { decision: "deny", permissions, reason: "rule" };
  }
  // An explicit allow cannot silently widen a workspace-scoped file request.
  if (outsideWorkspace(ctx) && profile.filesystem !== "full") return { decision: "ask", permissions, reason: "workspace" };

  const needsApproval = permissions.some((permission) => {
    const rule = rules?.get(subject, permission);
    if (rule === "allow") return false;
    if (profile.approval === "never") return false;
    if (profile.approval === "unless-trusted" && autoApprovesCapability(ctx, permission)) return false;
    if (rule === "ask") return true;
    return base === "ask";
  });
  return needsApproval
    ? { decision: "ask", permissions, reason: "approval" }
    : { decision: "allow", permissions, reason: "allowed" };
}

export function toolSource(name: string): "builtin" | "plugin" | "mcp" {
  if (name.startsWith("mcp:")) return "mcp";
  if (name.startsWith("plugin:")) return "plugin";
  return "builtin";
}

export function permissionNames(toolName: string): string[] {
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return ["filesystem.read"];
  if (toolName === "write" || toolName === "edit") return ["filesystem.write"];
  if (toolName === "bash" || toolName === "powershell") return ["shell.execute"];
  if (toolName.startsWith("browser.")) {
    const permissions = ["browser.control"];
    if (toolName !== "browser.close" && toolName !== "browser.screenshot") permissions.push("network");
    if (toolName === "browser.screenshot" || toolName === "browser.download") permissions.push("filesystem.write");
    return permissions;
  }
  if (toolName.startsWith("mcp:")) return ["mcp.connect"];
  return ["tool.execute"];
}

export function permissionName(toolName: string): string {
  return permissionNames(toolName)[0];
}

export function permissionSubject(toolName: string): string {
  if (toolName.startsWith("plugin:")) return `plugin:${toolName.split(":", 3)[1]}`;
  if (toolName.startsWith("mcp:")) return `mcp:${toolName.split(":", 3)[1]}`;
  return "builtin";
}

// --- Pending approvals ---

interface Pending {
  resolve: (approved: boolean) => void;
  toolName: string;
  args: unknown;
}

export class ApprovalQueue {
  private pending = new Map<string, Pending>();

  request(approvalId: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const abort = () => {
        if (this.pending.delete(approvalId)) resolve(false);
      };
      this.pending.set(approvalId, {
        resolve: (approved) => {
          signal?.removeEventListener("abort", abort);
          resolve(approved);
        },
        toolName,
        args,
      });
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  approve(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(true);
    return true;
  }

  reject(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(false);
    return true;
  }

  list() {
    return [...this.pending.entries()].map(([id, p]) => ({
      id,
      toolName: p.toolName,
      args: p.args,
    }));
  }
}

// Wrap a ToolDefinition so "ask" decisions block until the user answers.
// "deny" blocks immediately. "allow" passes through untouched.
export function withPermission<T extends ToolDefinition>(
  tool: T,
  opts: {
    queue: ApprovalQueue;
    emitApproval: (approvalId: string, toolName: string, args: unknown, toolCallId: string) => void;
    workspacePath?: string;
    rules?: PermissionRuleStore;
    mode?: () => RunPermissionMode;
  }
): T {
  const inner = tool.execute;
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate, ctx) => {
      const context = {
        toolName: logicalToolName(tool),
        args: params,
        workspacePath: opts.workspacePath,
      };
      const evaluation = evaluatePermission(
        context,
        opts.mode?.() ?? "ask",
        opts.rules,
        (tool as ToolDefinition & { qonePermissions?: string[] }).qonePermissions ?? [],
      );
      if (evaluation.decision === "deny") {
        return {
          content: [{ type: "text" as const, text: `Tool ${logicalToolName(tool)} denied by permission policy (${evaluation.reason}).` }],
          details: { denied: true, reason: evaluation.reason },
          isError: true,
        } as never;
      }
      if (evaluation.decision === "ask") {
        if (signal?.aborted) {
          return {
            content: [{ type: "text" as const, text: `Tool ${logicalToolName(tool)} cancelled.` }],
            details: { cancelled: true },
            isError: true,
          } as never;
        }
        const approvalId = crypto.randomUUID();
        const name = logicalToolName(tool);
        const approval = opts.queue.request(approvalId, name, params, signal);
        opts.emitApproval(approvalId, name, params, id);
        log.info("tool waiting approval", { tool: name, approvalId });
        const approved = await approval;
        if (!approved) {
          return {
            content: [{ type: "text" as const, text: `Tool ${logicalToolName(tool)} rejected by user.` }],
            details: { rejected: true },
            isError: true,
          } as never;
        }
      }

      return inner(id, params, signal, onUpdate, ctx);
    },
  } as T;
}
