import { mcpCredentialKeys, type McpServerInfo, type RuntimeCommand } from "@qone/protocol";
import { McpAccountLoginRequiredError, type McpServerConfig } from "@qone/mcp";
import { runtimeErrorInfo } from "./runtime-localization";
import type { runtimeCommandServices } from "./index";

type Services = ReturnType<typeof runtimeCommandServices>;
type Restored = Extract<RuntimeCommand, { type: "mcp.credentials.restored" }>;
const pending = new Map<string, (reply: Restored) => void>();
export function acknowledgeMcpCredentials(reply: Restored) { pending.get(reply.requestId)?.(reply); }

/** Runs inside the manager's connection flight, before resolving any secret references. */
export async function restoreMcpCredentials(config: McpServerConfig, services: Pick<Services, "send" | "runtimeSecrets" | "mcp">, signal: AbortSignal) {
  const keys = mcpCredentialKeys(config).filter(key => !services.runtimeSecrets.has(key));
  if (!keys.length) return;
  const requestId = crypto.randomUUID();
  const values = await new Promise<Record<string, string>>((resolve, reject) => {
    const finish = (error?: Error, values: Record<string, string> = {}) => {
      clearTimeout(timer); pending.delete(requestId); signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve(values);
    };
    const abort = () => finish(signal.reason ?? new Error("MCP credential restore cancelled"));
    const timer = setTimeout(() => finish(new Error("MCP credential storage did not respond")), 15_000);
    pending.set(requestId, reply => reply.ok ? finish(undefined, reply.values) : finish(new Error("Stored MCP credentials could not be read")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { services.send({ type: "mcp.credentials.request", requestId, serverId: config.id, keys }); }
    catch { finish(new Error("MCP credential storage is unavailable")); }
  });
  signal.throwIfAborted();
  // Requested order restores the OAuth client before tokens. A newer in-memory value wins.
  for (const key of keys) {
    const value = values[key];
    if (value === undefined || services.runtimeSecrets.has(key)) continue;
    applyMcpCredential(config, key, value, services);
  }
}

export function applyMcpCredential(config: McpServerConfig, key: string, value: string, services: Pick<Services, "mcp" | "runtimeSecrets">) {
  if (key === `mcp.oauth:${config.id}.client`) services.mcp.restoreHostedCredential(config, "client", value);
  else if (key === `mcp.oauth:${config.id}.tokens`) services.mcp.restoreHostedCredential(config, "tokens", value);
  else if (key === (config.oauth?.tokenSecretKey ?? `mcp.oauth:${config.id}`)) services.mcp.setAccessToken(config.id, value);
  services.runtimeSecrets.set(key, value);
}

export function mcpServerList(services: Pick<Services, "mcp" | "mcpServerRepo" | "pendingMcpAuthRequests">): McpServerInfo[] {
  return services.mcpServerRepo.list().map(server => ({ ...server, connected: services.mcp.isConnected(server.id),
    connecting: services.mcp.isConnecting(server.id) || services.pendingMcpAuthRequests.has(server.id), toolCount: services.mcp.toolCount(server.id) }));
}

/** Automatic connections never launch a login; user connections try restored credentials first. */
export async function connectMcp(config: McpServerInfo, services: Services, requestId?: string) {
  const current = () => services.mcpServerRepo.list().find(server => server.id === config.id);
  try {
    try {
      const tools = await services.mcp.connect(config);
      services.pendingMcpAuthRequests.delete(config.id);
      await services.refreshCustomTools();
      services.send({ type: "mcp.connected", serverId: config.id, toolCount: tools.length });
      return;
    } catch (error) {
      if (!(error instanceof McpAccountLoginRequiredError) || !requestId || current()?.disabled || !current()) throw error;
      if (services.pendingMcpAuthRequests.has(config.id)) return;
      services.pendingMcpAuthRequests.set(config.id, requestId);
      if (config.authMode === "github-device") {
        const { device } = await services.mcp.connectGitHub(config);
        if (services.pendingMcpAuthRequests.get(config.id) !== requestId) return;
        services.send({ type: "mcp.github.device", serverId: config.id, userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt });
        void device.completion.catch(error => {
          if (services.pendingMcpAuthRequests.get(config.id) !== requestId) return;
          services.pendingMcpAuthRequests.delete(config.id);
          services.send({ type: "error", requestId, ...runtimeErrorInfo(error) });
          services.send({ type: "mcp.list", servers: mcpServerList(services) });
        });
        return;
      }
      if (config.authMode !== "oauth" && !config.oauth) throw error;
      const authorization = await services.mcp.beginOAuth(config);
      if (services.pendingMcpAuthRequests.get(config.id) !== requestId) return;
      if (!authorization) {
        const tools = await services.mcp.connect(config);
        services.pendingMcpAuthRequests.delete(config.id);
        await services.refreshCustomTools();
        services.send({ type: "mcp.connected", serverId: config.id, toolCount: tools.length });
        return;
      }
      services.send({ type: "mcp.oauth.authorization", requestId, serverId: config.id, ...authorization });
      setTimeout(() => {
        if (services.pendingMcpAuthRequests.get(config.id) !== requestId) return;
        services.pendingMcpAuthRequests.delete(config.id);
        services.send({ type: "error", requestId, message: "MCP account login timed out" });
        services.send({ type: "mcp.list", servers: mcpServerList(services) });
      }, 10 * 60_000).unref();
    }
  } catch (error) {
    if (services.pendingMcpAuthRequests.get(config.id) === requestId) services.pendingMcpAuthRequests.delete(config.id);
    throw error;
  } finally { services.send({ type: "mcp.list", servers: mcpServerList(services) }); }
}
