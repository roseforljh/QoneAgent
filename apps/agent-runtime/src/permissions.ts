// Permission service. Maps tool names to allow/ask/deny. Tools that land on
// "ask" are held until the GUI answers via tool.approve / tool.reject, or
// blocked outright on "deny".

import { createLogger } from "@qone/shared";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { RunPermissionMode } from "@qone/protocol";

const log = createLogger("permission");

export type PermissionDecision = "allow" | "ask" | "deny";

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

function autoApproves(ctx: ToolContext): boolean {
  if (["browser.open", "browser.navigate", "browser.snapshot", "browser.extract", "browser.close"].includes(ctx.toolName)) return true;
  if (ctx.toolName !== "write" && ctx.toolName !== "edit") return false;
  const args = ctx.args as Record<string, unknown> | undefined;
  const target = args?.path ?? args?.file;
  return typeof target === "string" && !!ctx.workspacePath && insideWorkspace(target, ctx.workspacePath);
}

export function decide(ctx: ToolContext): PermissionDecision {
  const args = ctx.args as Record<string, unknown> | undefined;
  const pathArg =
    (args?.path as string | undefined) ??
    (args?.file as string | undefined) ??
    (args?.cwd as string | undefined);

  const resolvedPath = pathArg
    ? canonicalPath(path.resolve(ctx.workspacePath ?? process.cwd(), pathArg))
    : undefined;
  if (resolvedPath && DENY_PREFIXES.some((re) => re.test(resolvedPath.replaceAll("\\", "/")))) {
    return "deny";
  }

  const base = TOOL_PERMISSIONS[ctx.toolName] ?? "ask";

  // Workspace boundary: file-mutating tools pointing outside the workspace ask.
  if (base !== "deny" && pathArg && ctx.workspacePath) {
    if (!insideWorkspace(pathArg, ctx.workspacePath) && ["read", "write", "edit", "grep", "find", "ls"].includes(ctx.toolName)) {
      return "ask";
    }
  }

  return base;
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
      const policyDecision = decide(context);
      // Hard-deny locations are safety boundaries, not user preferences.
      if (policyDecision === "deny") {
        return {
          content: [{ type: "text" as const, text: `Tool ${logicalToolName(tool)} denied by policy.` }],
          details: { denied: true },
          isError: true,
        } as never;
      }
      const requiredPermissions = [
        ...permissionNames(logicalToolName(tool)),
        ...((tool as ToolDefinition & { qonePermissions?: string[] }).qonePermissions ?? []),
      ].filter((permission, index, all) => all.indexOf(permission) === index);
      const decisions = requiredPermissions
        .map((permission) => opts.rules?.get(permissionSubject(logicalToolName(tool)), permission) ?? policyDecision);
      let decision = decisions.includes("deny")
        ? "deny"
        : decisions.includes("ask")
          ? "ask"
          : "allow";
      if (decision === "ask") {
        const mode = opts.mode?.() ?? "ask";
        if (mode === "full" || (mode === "auto" && autoApproves(context))) decision = "allow";
      }
      if (decision === "deny") {
        return {
          content: [{ type: "text" as const, text: `Tool ${logicalToolName(tool)} denied by permission rule.` }],
          details: { denied: true },
          isError: true,
        } as never;
      }

      if (decision === "ask") {
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
