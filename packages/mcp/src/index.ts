import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSecureServiceUrl } from "@qone/protocol";

export interface McpServerConfig {
  id: string;
  name: string;
  command?: string;
  url?: string;
  tokenEnv?: string;
  args?: string[];
  env?: Record<string, string>;
  oauth?: {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
    redirectUri?: string;
    tokenSecretKey?: string;
  };
}

interface Conn {
  config: McpServerConfig;
  client: Client;
  tools: ToolDefinition[];
}

interface PendingOAuth {
  serverId: string;
  verifier: string;
  redirectUri: string;
  config: McpServerConfig;
  createdAt: number;
}

interface BunHttpServer {
  stop(): void;
}

export interface QoneMcpToolDefinition extends ToolDefinition {
  /** Internal name used for permissions, logs and the MCP call itself. */
  qoneToolName?: string;
}

/** Convert an arbitrary MCP name to the identifier format accepted by model APIs. */
export function safeToolName(name: string, usedNames: ReadonlySet<string> = new Set()): string {
  const base = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "mcp_tool";
  if (!usedNames.has(base)) return base;
  const suffix = shortHash(name);
  let candidate = `${base}_${suffix}`;
  let index = 2;
  while (usedNames.has(candidate)) candidate = `${base}_${suffix}_${index++}`;
  return candidate;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

// McpManager: connects to MCP servers over stdio, discovers their tools,
// and adapts each to a pi ToolDefinition so they can be passed via
// createAgentSession({ customTools }). Permission layer sits in front —
// tools surface here but only get registered on the session when allowed.
export class McpManager {
  private conns = new Map<string, Conn>();
  private exposedToolNames = new Map<string, string>();
  private accessTokens = new Map<string, string>();
  private pendingOAuth = new Map<string, PendingOAuth>();
  private oauthCallbackServers = new Map<string, BunHttpServer>();

  constructor(private readonly onOAuthComplete?: (serverId: string, token: string) => void | Promise<void>) {}

  private validateConfig(config: McpServerConfig) {
    if (Boolean(config.command) === Boolean(config.url)) throw new Error(`MCP server ${config.id} requires exactly one transport`);
    if (config.url && !isSecureServiceUrl(config.url)) throw new Error("MCP URL must use HTTPS or loopback HTTP");
    if (config.oauth) {
      if (!isSecureServiceUrl(config.oauth.authorizationUrl)) throw new Error("OAuth authorization URL must use HTTPS or loopback HTTP");
      if (!isSecureServiceUrl(config.oauth.tokenUrl)) throw new Error("OAuth token URL must use HTTPS or loopback HTTP");
      if (config.oauth.redirectUri && !isSecureServiceUrl(config.oauth.redirectUri)) throw new Error("OAuth redirect URL must use HTTPS or loopback HTTP");
    }
  }

  setAccessToken(serverId: string, token: string) {
    this.accessTokens.set(serverId, token);
  }

  /** Start an OAuth 2.1 authorization-code + PKCE flow for an HTTP MCP server. */
  async beginOAuth(config: McpServerConfig): Promise<{ url: string; state: string }> {
    this.validateConfig(config);
    if (!config.oauth) throw new Error(`MCP server ${config.id} has no OAuth configuration`);
    const state = crypto.randomUUID();
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const redirectUri = config.oauth.redirectUri ?? "http://127.0.0.1:17891/mcp/oauth/callback";
    this.pendingOAuth.set(state, { serverId: config.id, verifier, redirectUri, config, createdAt: Date.now() });
    this.ensureOAuthCallbackServer(redirectUri);
    const challenge = base64Url(await sha256(verifier));
    const url = new URL(config.oauth.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.oauth.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (config.oauth.scopes?.length) url.searchParams.set("scope", config.oauth.scopes.join(" "));
    return { url: url.toString(), state };
  }

  async completeOAuth(config: McpServerConfig, code: string, state: string): Promise<string> {
    const pending = this.pendingOAuth.get(state);
    if (!pending || pending.serverId !== config.id || Date.now() - pending.createdAt > 10 * 60_000) {
      this.pendingOAuth.delete(state);
      throw new Error("invalid or expired MCP OAuth state");
    }
    const oauth = pending.config.oauth;
    if (!oauth) throw new Error(`MCP server ${config.id} has no OAuth configuration`);
    this.pendingOAuth.delete(state);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: oauth.clientId,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    });
    const response = await fetch(oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    if (!response.ok) throw new Error(`MCP OAuth token exchange failed: HTTP ${response.status}`);
    const token = (await response.json()) as { access_token?: string };
    if (!token.access_token) throw new Error("MCP OAuth response did not contain access_token");
    this.setAccessToken(config.id, token.access_token);
    await this.onOAuthComplete?.(config.id, token.access_token);
    return token.access_token;
  }

  private ensureOAuthCallbackServer(redirectUri: string) {
    const url = new URL(redirectUri);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase())) return;
    const hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname === "[::1]" ? "::1" : url.hostname;
    const key = `${hostname}:${url.port || "80"}`;
    if (this.oauthCallbackServers.has(key)) return;
    const bun = (globalThis as unknown as {
      Bun?: { serve(options: { hostname: string; port: number; fetch(request: Request): Response | Promise<Response> }): BunHttpServer };
    }).Bun;
    if (!bun) return;
    const server = bun.serve({
      hostname,
      port: Number(url.port || 80),
      fetch: async (request) => {
        const requestUrl = new URL(request.url);
        const state = requestUrl.searchParams.get("state") ?? "";
        const code = requestUrl.searchParams.get("code") ?? "";
        const pending = this.pendingOAuth.get(state);
        if (!pending || !code || new URL(pending.redirectUri).pathname !== requestUrl.pathname) {
          return new Response("Invalid or expired OAuth state", { status: 400 });
        }
        try {
          await this.completeOAuth(pending.config, code, state);
          return new Response("QoneAgent authorization complete. You may close this tab.", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        } catch {
          return new Response("QoneAgent authorization failed.", { status: 500 });
        }
      },
    });
    this.oauthCallbackServers.set(key, server);
  }

  async connect(config: McpServerConfig): Promise<ToolDefinition[]> {
    this.validateConfig(config);
    const existing = this.conns.get(config.id);
    if (existing) return existing.tools;

    const resolvedEnv = config.env
      ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, value.startsWith("$") ? process.env[value.slice(1)] ?? "" : value]))
      : undefined;
    const token = this.accessTokens.get(config.id) ?? (config.tokenEnv ? process.env[config.tokenEnv] : undefined);
    const transport = config.url
      ? new StreamableHTTPClientTransport(new URL(config.url), token
        ? { authProvider: { token: async () => token } }
        : undefined)
      : new StdioClientTransport({ command: config.command!, args: config.args ?? [], env: resolvedEnv });
    const client = new Client({ name: "qone-agent", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const defs = tools.map((t) => this.adaptTool(config.id, client, t));
    this.conns.set(config.id, { config, client, tools: defs });
    return defs;
  }

  private adaptTool(
    serverId: string,
    client: Client,
    t: { name: string; description?: string; inputSchema?: unknown }
  ): ToolDefinition {
    const fullName = `mcp:${serverId}:${t.name}`;
    const usedNames = new Set(this.exposedToolNames.values());
    const exposedName = this.exposedToolNames.get(fullName) ?? safeToolName(fullName, usedNames);
    this.exposedToolNames.set(fullName, exposedName);
    return {
      name: exposedName,
      qoneToolName: fullName,
      label: `${serverId} · ${t.name}`,
      description: t.description ?? `MCP tool ${t.name} from ${serverId}`,
      // MCP servers validate their own input; preserve the advertised schema so
      // the model receives the real parameter names and constraints.
      parameters: Type.Unsafe(t.inputSchema && typeof t.inputSchema === "object"
        ? t.inputSchema as Record<string, unknown>
        : { type: "object", additionalProperties: true }),
      execute: async (_id, params) => {
        const res = await client.callTool({
          name: t.name,
          arguments: params as Record<string, unknown>,
        });
        const text = Array.isArray(res.content)
          ? res.content
              .map((c: { type: string; text?: string }) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
              .join("\n")
          : JSON.stringify(res.content);
        return {
          content: [{ type: "text", text }],
          details: res.structuredContent ?? undefined,
          isError: Boolean(res.isError),
        } as never;
      },
    } as QoneMcpToolDefinition;
  }

  tools(): ToolDefinition[] {
    return [...this.conns.values()].flatMap((c) => c.tools);
  }

  isConnected(id: string): boolean {
    return this.conns.has(id);
  }

  toolCount(id: string): number {
    return this.conns.get(id)?.tools.length ?? 0;
  }

  async disconnect(id: string) {
    const c = this.conns.get(id);
    if (!c) return;
    await c.client.close();
    this.conns.delete(id);
  }

  async disconnectAll() {
    for (const id of [...this.conns.keys()]) {
      await this.disconnect(id).catch(() => {});
    }
    for (const server of this.oauthCallbackServers.values()) server.stop();
    this.oauthCallbackServers.clear();
    this.pendingOAuth.clear();
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
