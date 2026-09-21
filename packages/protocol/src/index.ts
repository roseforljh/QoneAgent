import { z } from "zod";

// Typed protocol between GUI and Agent Runtime.
// Commands: GUI -> Runtime. Events: Runtime -> GUI.
// Transport is NDJSON over stdio (Phase 2).

// ---------- Commands (GUI -> Runtime) ----------

export interface CommandBase {
  type: string;
  requestId: string;
}

export type RuntimeCommand =
  | { type: "ping"; requestId: string }
  | { type: "session.create"; requestId: string; title?: string; workspaceId?: string }
  | { type: "session.list"; requestId: string }
  | { type: "session.delete"; requestId: string; sessionId: string }
  | { type: "session.messages"; requestId: string; sessionId: string }
  | { type: "session.runs"; requestId: string; sessionId: string }
  | { type: "session.toolCalls"; requestId: string; sessionId: string }
  | { type: "artifact.list"; requestId: string; sessionId: string }
  | { type: "workspace.list"; requestId: string }
  | { type: "workspace.upsert"; requestId: string; name: string; path: string }
  | { type: "workspace.rename"; requestId: string; workspaceId: string; name: string }
  | { type: "workspace.delete"; requestId: string; workspaceId: string }
  | { type: "workspace.files"; requestId: string; workspaceId: string }
  | { type: "workspace.git"; requestId: string; workspaceId: string }
  | { type: "skills.list"; requestId: string; cwd?: string }
  | { type: "plugins.list"; requestId: string }
  | { type: "mcp.list"; requestId: string }
  | { type: "mcp.connect"; requestId: string; config: McpServerInfo }
  | { type: "mcp.oauth.begin"; requestId: string; serverId: string }
  | { type: "mcp.oauth.complete"; requestId: string; serverId: string; code: string; state: string }
  | { type: "permission.list"; requestId: string }
  | { type: "permission.set"; requestId: string; subjectId: string; permission: string; decision: PermissionDecision }
  | { type: "model.list"; requestId: string }
  | { type: "model.upsert"; requestId: string; config: ModelConfigInfo }
  | { type: "model.delete"; requestId: string; id: string }
  | { type: "events.replay"; requestId: string; sessionId?: string; afterSequence?: number }
  | {
      type: "agent.run";
      requestId: string;
      sessionId: string;
      message: string;
      model?: string;
    }
  | { type: "agent.stop"; requestId: string; runId: string }
  | { type: "tool.approve"; requestId: string; approvalId: string }
  | { type: "tool.reject"; requestId: string; approvalId: string; reason?: string }
  | { type: "secret.set"; requestId: string; key: string; value: string }
  | { type: "secret.delete"; requestId: string; key: string };

// ---------- Events (Runtime -> GUI) ----------

export interface AgentEvent<T = unknown> {
  eventId: string;
  sessionId?: string;
  runId?: string;
  sequence: number;
  type: string;
  timestamp: number;
  payload: T;
}

export interface EventBase {
  type: string;
}

export type RuntimeEvent =
  | { type: "pong"; requestId: string }
  | { type: "session.created"; session: SessionInfo }
  | { type: "session.list"; sessions: SessionInfo[] }
  | { type: "session.messages"; sessionId: string; messages: MessageInfo[] }
  | { type: "session.runs"; sessionId: string; runs: RunInfo[] }
  | { type: "session.toolCalls"; sessionId: string; toolCalls: ToolCallInfo[] }
  | { type: "artifact.list"; sessionId: string; artifacts: ArtifactInfo[] }
  | { type: "workspace.list"; workspaces: WorkspaceInfo[] }
  | { type: "workspace.updated"; workspace: WorkspaceInfo }
  | { type: "workspace.renamed"; workspace: WorkspaceInfo }
  | { type: "workspace.deleted"; workspaceId: string }
  | { type: "workspace.files"; workspaceId: string; files: WorkspaceFileInfo[] }
  | { type: "workspace.git"; workspaceId: string; status: string }
  | { type: "skills.list"; skills: SkillInfo[] }
  | { type: "plugins.list"; plugins: PluginInfo[] }
  | { type: "mcp.list"; servers: McpServerInfo[] }
  | { type: "mcp.connected"; serverId: string; toolCount: number }
  | { type: "mcp.oauth.authorization"; requestId: string; serverId: string; url: string; state: string }
  | { type: "mcp.oauth.token"; requestId: string; serverId: string; key: string; accessToken: string }
  | { type: "mcp.oauth.saved"; serverId: string; key: string }
  | { type: "permission.list"; rules: PermissionRuleInfo[] }
  | { type: "permission.updated"; rule: PermissionRuleInfo }
  | { type: "model.list"; configs: ModelConfigInfo[] }
  | { type: "model.updated"; config: ModelConfigInfo }
  | { type: "events.replay"; events: AgentEvent[] }
  | { type: "secret.saved"; requestId: string }
  | { type: "agent.event"; event: AgentEvent }
  | { type: "terminal.data"; terminalId: string; data: string }
  | { type: "terminal.exit"; terminalId: string }
  | { type: "error"; requestId?: string; message: string };

// ---------- Shared shapes ----------

export interface SessionInfo {
  id: string;
  title: string;
  workspaceId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageInfo {
  id: string;
  sessionId: string;
  runId?: string;
  role: string;
  content: string;
  model?: string;
  createdAt: number;
}

export interface RunInfo {
  id: string;
  sessionId: string;
  status: RunStatus | "interrupted";
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface ToolCallInfo {
  id: string;
  runId: string;
  toolName: string;
  arguments?: string;
  resultSummary?: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
}

export interface ArtifactInfo {
  id: string;
  sessionId: string;
  type: string;
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
  createdAt: number;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceFileInfo {
  path: string;
  kind: "file" | "directory";
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  toolCount: number;
  skillCount: number;
  loaded: boolean;
}

export interface McpServerInfo {
  id: string;
  name: string;
  command?: string;
  url?: string;
  tokenEnv?: string;
  args?: string[];
  env?: Record<string, string>;
  oauth?: McpOAuthInfo;
}

export interface McpOAuthInfo {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  redirectUri?: string;
  tokenSecretKey?: string;
}

export type PermissionDecision = "allow" | "ask" | "deny";
export interface PermissionRuleInfo {
  subjectId: string;
  permission: string;
  decision: PermissionDecision;
  updatedAt: number;
}

export interface ModelConfigInfo {
  id: string;
  provider: string;
  model: string;
  config: Record<string, unknown>;
  enabled: boolean;
  updatedAt: number;
}

export type RunStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

// ---------- Wire helpers (NDJSON) ----------

export function encode<T>(msg: T): string {
  return JSON.stringify(msg) + "\n";
}

export function decode<T = unknown>(line: string): T | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

export function isSecureServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const request = { requestId: z.string().min(1) };
const id = z.string().min(1);
const secureUrl = z.string().url().refine(isSecureServiceUrl, "URL must use HTTPS or loopback HTTP");
const secretKey = z.string().regex(/^[A-Za-z][A-Za-z0-9.-]{0,63}:[A-Za-z0-9._/-]{1,128}$/);
const decision = z.enum(["allow", "ask", "deny"]);
const mcpConfig = z.object({
  id, name: id, command: z.string().min(1).optional(), url: secureUrl.optional(),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(), args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  oauth: z.object({
    authorizationUrl: secureUrl, tokenUrl: secureUrl, clientId: id,
    scopes: z.array(z.string()).optional(), redirectUri: secureUrl.optional(), tokenSecretKey: z.string().optional(),
  }).optional(),
}).refine((config) => Boolean(config.command) !== Boolean(config.url));
const commandSchemas: Record<string, z.ZodTypeAny> = {
  ping: z.object({ type: z.literal("ping"), ...request }),
  "session.create": z.object({ type: z.literal("session.create"), ...request, title: z.string().optional(), workspaceId: id.optional() }),
  "session.list": z.object({ type: z.literal("session.list"), ...request }),
  "session.delete": z.object({ type: z.literal("session.delete"), ...request, sessionId: id }),
  "session.messages": z.object({ type: z.literal("session.messages"), ...request, sessionId: id }),
  "session.runs": z.object({ type: z.literal("session.runs"), ...request, sessionId: id }),
  "session.toolCalls": z.object({ type: z.literal("session.toolCalls"), ...request, sessionId: id }),
  "artifact.list": z.object({ type: z.literal("artifact.list"), ...request, sessionId: id }),
  "workspace.list": z.object({ type: z.literal("workspace.list"), ...request }),
  "workspace.upsert": z.object({ type: z.literal("workspace.upsert"), ...request, name: id, path: id }),
  "workspace.rename": z.object({ type: z.literal("workspace.rename"), ...request, workspaceId: id, name: id }),
  "workspace.delete": z.object({ type: z.literal("workspace.delete"), ...request, workspaceId: id }),
  "workspace.files": z.object({ type: z.literal("workspace.files"), ...request, workspaceId: id }),
  "workspace.git": z.object({ type: z.literal("workspace.git"), ...request, workspaceId: id }),
  "skills.list": z.object({ type: z.literal("skills.list"), ...request, cwd: z.string().optional() }),
  "plugins.list": z.object({ type: z.literal("plugins.list"), ...request }),
  "mcp.list": z.object({ type: z.literal("mcp.list"), ...request }),
  "mcp.connect": z.object({ type: z.literal("mcp.connect"), ...request, config: mcpConfig }),
  "mcp.oauth.begin": z.object({ type: z.literal("mcp.oauth.begin"), ...request, serverId: id }),
  "mcp.oauth.complete": z.object({ type: z.literal("mcp.oauth.complete"), ...request, serverId: id, code: id, state: id }),
  "model.list": z.object({ type: z.literal("model.list"), ...request }),
  "model.upsert": z.object({ type: z.literal("model.upsert"), ...request, config: z.object({ id: id.optional(), provider: id, model: id, config: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional(), updatedAt: z.number().optional() }) }),
  "model.delete": z.object({ type: z.literal("model.delete"), ...request, id }),
  "events.replay": z.object({ type: z.literal("events.replay"), ...request, sessionId: id.optional(), afterSequence: z.number().optional() }),
  "agent.run": z.object({ type: z.literal("agent.run"), ...request, sessionId: id, message: z.string().min(1), model: z.string().optional() }),
  "agent.stop": z.object({ type: z.literal("agent.stop"), ...request, runId: id }),
  "tool.approve": z.object({ type: z.literal("tool.approve"), ...request, approvalId: id }),
  "tool.reject": z.object({ type: z.literal("tool.reject"), ...request, approvalId: id, reason: z.string().optional() }),
  "permission.list": z.object({ type: z.literal("permission.list"), ...request }),
  "permission.set": z.object({ type: z.literal("permission.set"), ...request, subjectId: id, permission: id, decision }),
  "secret.set": z.object({ type: z.literal("secret.set"), ...request, key: secretKey, value: z.string().max(65_536) }),
  "secret.delete": z.object({ type: z.literal("secret.delete"), ...request, key: secretKey }),
};

/** Validate untrusted IPC input at the process boundary before dispatch. */
export function decodeCommand(line: string): RuntimeCommand | null {
  const value = decode<unknown>(line);
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const schema = commandSchemas[String((value as { type: unknown }).type)];
  if (!schema) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data as RuntimeCommand : null;
}
