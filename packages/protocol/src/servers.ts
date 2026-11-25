import { z } from "zod";

/** How Qone signs in. Passwords are used once to install a dedicated key and are never stored. */
export type ServerAuthInfo =
  | { kind: "key"; keyPath: string; dedicated: boolean }
  | { kind: "agent" };

export type ServerStatus = "ready" | "offline" | "host-key-changed" | "auth-failed" | "error";

export interface ServerInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: ServerAuthInfo;
  /** OpenSSH-style `SHA256:...` fingerprint pinned on first connection. */
  hostKey?: string;
  /** Short OS/hardware line from the last probe, e.g. "Debian 13 · x86_64 · 4 CPU". */
  system?: string;
  /** Folder in the settings list; absent means ungrouped. */
  groupId?: string;
  status: ServerStatus;
  statusDetail?: string;
  lastConnectedAt?: number;
  createdAt: number;
}

/** A host found in ~/.ssh/config or ~/.ssh/known_hosts, with the local identity that works, if any. */
export interface ServerCandidate {
  host: string;
  port: number;
  username?: string;
  alias?: string;
  identityFile?: string;
  configured: boolean;
}

export interface ServerGroupInfo { id: string; name: string }

export interface ServerOperationInfo { serverId: string; serverName: string }

/** Only runtime-produced details identify the resolved target, never model arguments. */
export function serverOperationInfo(result: unknown): ServerOperationInfo | undefined {
  const value = (result as { details?: { serverOperation?: ServerOperationInfo } } | undefined)?.details?.serverOperation;
  return value && typeof value.serverId === "string" && typeof value.serverName === "string" ? value : undefined;
}

export function serverOperationCancelled(result: unknown): boolean {
  return (result as { details?: { cancelled?: unknown } } | undefined)?.details?.cancelled === true;
}

/** Framework cancellation errors carry no target or output; keep the last resolved snapshot. */
export function preserveServerOperationResult(previous: unknown, next: unknown): unknown {
  if (!serverOperationInfo(previous) || serverOperationInfo(next)) return next;
  const before = previous as { content?: unknown; details?: object };
  const after = next && typeof next === "object" ? next as { details?: object } : undefined;
  return { ...before, ...after, content: before.content, details: { ...before.details, ...after?.details } };
}

export type ServerSetupStage = "host-key" | "authenticating" | "inspecting" | "securing";

export type ServerTunnelInfo = { serverId: string; remotePort: number; localPort: number; url: string };

export type ServerCommand =
  | { type: "servers.list"; requestId: string }
  | { type: "servers.add"; requestId: string; name?: string; host: string; port: number; username: string; password?: string; keyPath?: string; useAgent?: boolean; groupId?: string }
  | { type: "servers.update"; requestId: string; id: string; name?: string; host: string; port: number; username: string; password?: string; keyPath?: string; useAgent?: boolean; groupId?: string; trustHostKey?: boolean }
  | { type: "servers.delete"; requestId: string; id: string; force?: boolean }
  | { type: "servers.move"; requestId: string; id: string; groupId?: string }
  | { type: "servers.group.create"; requestId: string; name: string }
  | { type: "servers.group.rename"; requestId: string; id: string; name: string }
  | { type: "servers.group.delete"; requestId: string; id: string }
  | { type: "servers.test"; requestId: string; id: string }
  | { type: "servers.discover"; requestId: string }
  | { type: "servers.tunnel.close"; requestId: string; serverId: string; localPort: number }
  | { type: "server.terminal.open"; requestId: string; terminalId: string; serverId: string; cols: number; rows: number }
  | { type: "server.terminal.write"; requestId: string; terminalId: string; data: string }
  | { type: "server.terminal.resize"; requestId: string; terminalId: string; cols: number; rows: number }
  | { type: "server.terminal.close"; requestId: string; terminalId: string };

export type ServerEvent =
  | { type: "servers.state"; requestId?: string; servers: ServerInfo[]; groups: ServerGroupInfo[]; tunnels: ServerTunnelInfo[]; createdGroupId?: string }
  | { type: "servers.setup"; requestId: string; stage: ServerSetupStage }
  | { type: "servers.discovered"; requestId: string; candidates: ServerCandidate[] }
  | { type: "server.terminal.opened"; requestId: string; terminalId: string }
  | { type: "server.terminal.data"; terminalId: string; data: string }
  | { type: "server.terminal.exit"; terminalId: string };

const request = { requestId: z.string().min(1), locale: z.enum(["en", "zh-CN"]).optional() };
const id = z.string().min(1).max(200);
const host = z.string().trim().min(1).max(255).regex(/^[^\s@/\\]+$/);
const port = z.number().int().min(1).max(65_535);
const size = z.number().int().min(1).max(1000);

const serverFields = {
  ...request, name: z.string().trim().max(80).optional(), host, port,
  username: z.string().trim().min(1).max(64).regex(/^[^\s@:]+$/),
  password: z.string().max(1024).optional(), keyPath: z.string().max(4096).optional(), useAgent: z.boolean().optional(), groupId: id.optional(),
};

export const serverCommandSchemas = {
  "servers.list": z.object({ type: z.literal("servers.list"), ...request }),
  "servers.add": z.object({ type: z.literal("servers.add"), ...serverFields })
    .refine((value) => Boolean(value.password || value.keyPath || value.useAgent), "Password, key or agent required"),
  // Without new credentials the saved sign-in is kept.
  "servers.update": z.object({ type: z.literal("servers.update"), ...serverFields, id, trustHostKey: z.boolean().optional() }),
  "servers.delete": z.object({ type: z.literal("servers.delete"), ...request, id, force: z.boolean().optional() }),
  "servers.move": z.object({ type: z.literal("servers.move"), ...request, id, groupId: id.optional() }),
  "servers.group.create": z.object({ type: z.literal("servers.group.create"), ...request, name: z.string().trim().min(1).max(60) }),
  "servers.group.rename": z.object({ type: z.literal("servers.group.rename"), ...request, id, name: z.string().trim().min(1).max(60) }),
  "servers.group.delete": z.object({ type: z.literal("servers.group.delete"), ...request, id }),
  "servers.test": z.object({ type: z.literal("servers.test"), ...request, id }),
  "servers.discover": z.object({ type: z.literal("servers.discover"), ...request }),
  "servers.tunnel.close": z.object({ type: z.literal("servers.tunnel.close"), ...request, serverId: id, localPort: port }),
  "server.terminal.open": z.object({ type: z.literal("server.terminal.open"), ...request, terminalId: id, serverId: id, cols: size, rows: size }),
  "server.terminal.write": z.object({ type: z.literal("server.terminal.write"), ...request, terminalId: id, data: z.string().max(1_048_576) }),
  "server.terminal.resize": z.object({ type: z.literal("server.terminal.resize"), ...request, terminalId: id, cols: size, rows: size }),
  "server.terminal.close": z.object({ type: z.literal("server.terminal.close"), ...request, terminalId: id }),
};
