import { existsSync } from "node:fs";
import type { PreferenceStore } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent, ServerCommand, ServerInfo } from "@qone/protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { agentPath, SshPool } from "./ssh.js";
import { ServerRegistry } from "./server-registry.js";
import { ServerSessions, createServerTools, replaceRemoteText } from "./server-tools.js";
import { discoverServers } from "./server-discovery.js";
import { runtimeError } from "../runtime-localization.js";
import type { ServerExecutionTarget } from "../execution-context.js";

const availableAgent = () => { const value = agentPath(); return value && existsSync(value) ? value : undefined; };

export class ServerService {
  readonly pool: SshPool;
  readonly registry: ServerRegistry;
  readonly sessions: ServerSessions;
  private lastActivity = new Map<string, number>();

  /** `onToolsChanged` rebuilds agent sessions so their tool list names the current servers. */
  constructor(repo: PreferenceStore, private send: (event: RuntimeEvent) => void, private onToolsChanged: () => Promise<void>) {
    this.pool = new SshPool((serverId, presented) => {
      this.registry.update(serverId, { status: "host-key-changed", statusDetail: presented });
      this.broadcast();
    });
    this.registry = new ServerRegistry(repo, this.pool);
    this.sessions = new ServerSessions(this.pool, () => this.broadcast());
  }

  state(requestId?: string, createdGroupId?: string): RuntimeEvent {
    return { type: "servers.state", ...(requestId ? { requestId } : {}), servers: this.registry.list(), groups: this.registry.groups(), tunnels: this.sessions.tunnelList(), ...(createdGroupId ? { createdGroupId } : {}) };
  }

  broadcast(requestId?: string, createdGroupId?: string) { this.send(this.state(requestId, createdGroupId)); }

  executionTargets(serverIds: readonly string[] = []): ServerExecutionTarget[] {
    return this.registry.list().filter(server => serverIds.includes(server.id)).map(({ id, name, host, port, username, system, status }) => ({
      id, name, host, port, username, system, lastKnownStatus: status,
    }));
  }

  summary(serverIds: readonly string[] = []): string {
    const list = this.executionTargets(serverIds);
    return list.length ? `The user's SSH servers: ${list.map((server) => `${server.name} (${server.username}@${server.host}${server.system ? `, ${server.system}` : ""})`).join("; ")}` : "SSH servers";
  }

  /** One server of a conversation's scope, by ID or unique name. */
  find(serverIds: readonly string[], name: string): ServerInfo {
    const scoped = this.registry.list().filter(server => serverIds.includes(server.id));
    const byName = scoped.filter(server => server.name.toLowerCase() === name.toLowerCase());
    const server = scoped.find(server => server.id === name) ?? (byName.length === 1 ? byName[0] : undefined);
    if (!server) throw runtimeError("servers.choose", { p0: scoped.map(item => `${item.name} [${item.id}]`).join(", ") });
    return server;
  }

  async replaceText(server: ServerInfo, file: string, placeholder: string, value?: string, signal?: AbortSignal) {
    return replaceRemoteText(await this.pool.get(server), file, placeholder, value, signal);
  }

  tools(workspacePath: string, serverIds: readonly string[] = [], env?: (serverId: string) => Record<string, string>): ToolDefinition[] {
    return createServerTools({
      servers: () => this.registry.list().filter(server => serverIds.includes(server.id)), pool: this.pool, sessions: this.sessions, workspacePath, env,
      onActivity: (serverId) => {
        // Reflect a recovered connection once, not on every tool call.
        const server = this.registry.get(serverId);
        const now = Date.now();
        if (server && (server.status !== "ready" || now - (this.lastActivity.get(serverId) ?? 0) > 60_000)) {
          this.lastActivity.set(serverId, now);
          this.registry.update(serverId, { status: "ready", statusDetail: undefined, lastConnectedAt: now });
          this.broadcast();
        }
      },
    });
  }

  async handle(cmd: Extract<RuntimeCommand, ServerCommand>): Promise<void> {
    switch (cmd.type) {
      case "servers.list": return this.broadcast(cmd.requestId);
      case "servers.add": {
        const { requestId, type: _type, locale: _locale, ...input } = cmd;
        await this.registry.add({ ...input, useAgent: input.useAgent && Boolean(availableAgent()) }, (stage) => this.send({ type: "servers.setup", requestId, stage }));
        await this.onToolsChanged();
        return this.broadcast(requestId);
      }
      case "servers.update": {
        const { requestId, type: _type, locale: _locale, id, trustHostKey, ...input } = cmd;
        const before = this.registry.get(id);
        const after = await this.registry.edit(id, { ...input, useAgent: input.useAgent && Boolean(availableAgent()) }, (stage) => this.send({ type: "servers.setup", requestId, stage }), trustHostKey)
          .catch((error) => { this.broadcast(); throw error; });
        // Open terminals and tunnels still point at the old address.
        if (before && (before.host !== after.host || before.port !== after.port || before.username !== after.username)) this.sessions.closeServer(id);
        await this.onToolsChanged();
        return this.broadcast(requestId);
      }
      case "servers.delete":
        await this.registry.delete(cmd.id, cmd.force);
        this.sessions.closeServer(cmd.id);
        this.lastActivity.delete(cmd.id);
        await this.onToolsChanged();
        return this.broadcast(cmd.requestId);
      case "servers.move":
        this.registry.move(cmd.id, cmd.groupId);
        return this.broadcast(cmd.requestId);
      case "servers.group.create":
        return this.broadcast(cmd.requestId, this.registry.createGroup(cmd.name).id);
      case "servers.group.rename":
        this.registry.renameGroup(cmd.id, cmd.name);
        return this.broadcast(cmd.requestId);
      case "servers.group.delete":
        this.registry.deleteGroup(cmd.id);
        return this.broadcast(cmd.requestId);
      case "servers.test":
        await this.registry.test(cmd.id);
        return this.broadcast(cmd.requestId);
      case "servers.discover":
        return this.send({ type: "servers.discovered", requestId: cmd.requestId, candidates: await discoverServers(this.registry.list(), availableAgent()) });
      case "servers.tunnel.close":
        this.sessions.closeTunnel(cmd.serverId, cmd.localPort);
        return this.broadcast(cmd.requestId);
      case "server.terminal.open": {
        const server = this.registry.get(cmd.serverId);
        if (!server) throw runtimeError("servers.not_found");
        await this.sessions.openTerminal(server, cmd.cols, cmd.rows, cmd.terminalId, {
          onData: (data) => this.send({ type: "server.terminal.data", terminalId: cmd.terminalId, data }),
          onExit: () => this.send({ type: "server.terminal.exit", terminalId: cmd.terminalId }),
        });
        return this.send({ type: "server.terminal.opened", requestId: cmd.requestId, terminalId: cmd.terminalId });
      }
      // The terminal already reported its exit; late keystrokes are dropped.
      case "server.terminal.write": this.sessions.find(cmd.terminalId)?.channel.write(cmd.data); return;
      case "server.terminal.resize": this.sessions.find(cmd.terminalId)?.channel.setWindow(cmd.rows, cmd.cols, 0, 0); return;
      case "server.terminal.close": this.sessions.closeTerminal(cmd.terminalId); return;
    }
  }

  dispose() { this.pool.dropAll(); }
}

