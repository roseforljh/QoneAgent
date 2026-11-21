import { Client, StreamableHTTPClientTransport, SSEClientTransport, UnauthorizedError, DEFAULT_REQUEST_TIMEOUT_MSEC, SdkError, SdkErrorCode, SdkHttpError, type CallToolResult } from "@modelcontextprotocol/client";
import { isDeepStrictEqual } from "node:util";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { TreeKillingStdioTransport } from "./stdio-transport";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSecureServiceUrl } from "@qone/protocol";
import { toolProxyEnvironment } from "@qone/protocol/proxy-environment";
import { HostedMcpOAuth, type HostedOAuthAuthorization, type HostedOAuthCredential } from "./hosted-oauth";
import { resolveMcpStdioLaunch } from "./stdio-launch";
import { McpAccountLoginRequiredError } from "./auth-error";
import { catalogKey, configFingerprint, connectionConfig, readCatalog, type McpCatalogStore, type McpToolMetadata } from "./tool-catalog";
export { resolveStdioLaunch } from "./stdio-launch";
export { McpAccountLoginRequiredError } from "./auth-error";

export interface McpServerConfig {
  id: string;
  name: string;
  command?: string;
  url?: string;
  transport?: "http" | "sse";
  headers?: Record<string, string>;
  tokenEnv?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  oauth?: {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
    redirectUri?: string;
    tokenSecretKey?: string;
  };
  authMode?: "oauth" | "github-device";
  oauthClientId?: string;
}

export interface McpLifecycleOptions {
  catalog?: McpCatalogStore;
  canConnect?: (id: string) => boolean;
  onToolsChanged?: () => void;
  onAuthTargetChanged?: (config: McpServerConfig) => void;
}
interface Registration {
  config: McpServerConfig;
  fingerprint: string;
  metadata?: McpToolMetadata[];
  tools: ToolDefinition[];
  used: boolean;
  calls: number;
  authRequired?: boolean;
}

/** Resolve persisted MCP environment references without storing API keys in the database. */
export function resolveMcpEnvironment(
  env: Record<string, string> | undefined,
  secret: (key: string) => string | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    if (value.startsWith("$mcp.env:")) {
      const restored = secret(value.slice(1));
      if (restored === undefined) throw new Error(`MCP API key is unavailable for ${key}`);
      return [key, restored];
    }
    return [key, value.startsWith("$") ? process.env[value.slice(1)] ?? "" : value];
  }));
}

interface Conn {
  config: McpServerConfig;
  client: Client;
}

interface PendingOAuth {
  serverId: string;
  verifier: string;
  redirectUri: string;
  config: McpServerConfig;
  createdAt: number;
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
  private refreshTokens = new Map<string, string>();
  private tokenRefreshes = new Map<string, Promise<void>>();
  private hostedOAuth = new Map<string, HostedMcpOAuth>();
  private hostedTargets = new Map<string, string>();
  private pendingOAuth = new Map<string, PendingOAuth>();
  private pendingHostedOAuth = new Map<string, { config: McpServerConfig; createdAt: number }>();
  private deviceAuthGenerations = new Map<string, string>();
  private deviceAuthSessions = new Map<string, { userCode: string; verificationUri: string; expiresAt: number; completion: Promise<void> }>();
  private connecting = new Map<string, Promise<ToolDefinition[]>>();
  private staleConnections = new Set<string>();
  private connectControllers = new Map<string, AbortController>();
  // Bumped by disconnect/delete so an in-flight connect cannot register itself
  // after the server was removed.
  private connectionGenerations = new Map<string, number>();
  private oauthCallbackServers = new Map<string, Server>();
  private registrations = new Map<string, Registration>();
  private closing = new Map<string, Promise<void>>();
  private stopped = false;


  constructor(
    private readonly onOAuthComplete?: (serverId: string, token?: string) => void | Promise<void>,
    private readonly onOAuthCredential?: (serverId: string, kind: HostedOAuthCredential, value: string) => void | Promise<void>,
    private readonly onOAuthAuthorization?: (serverId: string, authorization: HostedOAuthAuthorization) => void,
    private readonly onOAuthFailure?: (serverId: string, error: Error) => void,
    private readonly resolveSecret: (key: string) => string | undefined = () => undefined,
    private readonly onAccessTokenInvalidated?: (config: McpServerConfig) => void | Promise<void>,
    private readonly onAccessTokenRefreshed?: (config: McpServerConfig, credential: string) => void | Promise<void>,
    /** Fires when the OAuth SDK rejects a stored client/token, so the disk copy can go too. */
    private readonly onOAuthInvalidate?: (serverId: string, kind: "client" | "tokens") => void | Promise<void>,
    private readonly refreshImportedToken?: (config: McpServerConfig) => Promise<string | undefined>,
    private readonly beforeConnect?: (config: McpServerConfig, signal: AbortSignal) => Promise<void>,
    private readonly onConnectionChange?: () => void,
    private readonly lifecycle: McpLifecycleOptions = {},
  ) {}

  private validateConfig(config: McpServerConfig) {
    if (Boolean(config.command) === Boolean(config.url)) throw new Error(`MCP server ${config.id} requires exactly one transport`);
    if (config.url && !isSecureServiceUrl(config.url)) throw new Error("MCP URL must use HTTPS or loopback HTTP");
    if (config.authMode && !config.url) throw new Error("Account login requires an HTTP MCP server");
    if (config.oauth) {
      if (!isSecureServiceUrl(config.oauth.authorizationUrl)) throw new Error("OAuth authorization URL must use HTTPS or loopback HTTP");
      if (!isSecureServiceUrl(config.oauth.tokenUrl)) throw new Error("OAuth token URL must use HTTPS or loopback HTTP");
      if (config.oauth.redirectUri && !isSecureServiceUrl(config.oauth.redirectUri)) throw new Error("OAuth redirect URL must use HTTPS or loopback HTTP");
    }
  }

  /** Accepts a plain access token or a persisted `{ accessToken, refreshToken }` credential. */
  setAccessToken(serverId: string, credential: string) {
    const { accessToken, refreshToken } = parseCredential(credential);
    this.accessTokens.set(serverId, accessToken);
    if (refreshToken) this.refreshTokens.set(serverId, refreshToken);
    else this.refreshTokens.delete(serverId);
  }

  private hosted(config: McpServerConfig) {
    if (!config.url) throw new Error("Hosted MCP OAuth requires a server URL");
    const target = JSON.stringify([config.url, config.authMode, config.oauth, config.oauthClientId]);
    if (this.hostedTargets.has(config.id) && this.hostedTargets.get(config.id) !== target) this.clearCredentials(config.id);
    this.hostedTargets.set(config.id, target);
    let provider = this.hostedOAuth.get(config.id);
    if (!provider) {
      provider = new HostedMcpOAuth(config.url,
        (kind, value) => {
          if (this.hostedOAuth.get(config.id) === provider) return this.onOAuthCredential?.(config.id, kind, value);
        },
        (authorization) => {
          if (this.hostedOAuth.get(config.id) !== provider || this.stopped) return;
          this.pendingHostedOAuth.set(authorization.state, { config, createdAt: Date.now() });
          void this.ensureOAuthCallbackServer("http://127.0.0.1:17891/mcp/oauth/callback")
            .catch((error) => this.onOAuthFailure?.(config.id, error instanceof Error ? error : new Error(String(error))));
          this.onOAuthAuthorization?.(config.id, authorization);
        },
        (scope) => {
          if (this.hostedOAuth.get(config.id) !== provider) return;
          if (scope === "tokens") this.invalidateConnection(config.id);
          return this.onOAuthInvalidate?.(config.id, scope);
        },
        () => this.refreshImportedToken?.(config) ?? Promise.resolve(undefined));
      this.hostedOAuth.set(config.id, provider);
    }
    return provider;
  }

  restoreHostedCredential(config: McpServerConfig, kind: HostedOAuthCredential, value: string) {
    this.hosted(config).restore(kind, value);
  }

  hasHostedToken(config: McpServerConfig) { return this.hosted(config).hasToken(); }
  hasAccessToken(serverId: string) { return this.accessTokens.has(serverId); }
  clearCredentials(serverId: string) {
    this.deviceAuthGenerations.delete(serverId);
    this.deviceAuthSessions.delete(serverId);
    this.accessTokens.delete(serverId);
    this.refreshTokens.delete(serverId);
    this.tokenRefreshes.delete(serverId);
    this.hostedOAuth.get(serverId)?.clear();
    this.hostedOAuth.delete(serverId);
    this.hostedTargets.delete(serverId);
    for (const [state, pending] of this.pendingHostedOAuth) if (pending.config.id === serverId) this.pendingHostedOAuth.delete(state);
    for (const [state, pending] of this.pendingOAuth) if (pending.serverId === serverId) this.pendingOAuth.delete(state);
  }

  /** Only a user-requested connection may start interactive device authorization. */
  async connectGitHub(config: McpServerConfig) {
    this.validateConfig(config);
    if (config.authMode !== "github-device") throw new Error("GitHub device login is not configured");
    // This method is called only from an explicit user action. Always start
    // the interactive login first; connecting with an existing token belongs
    // to the normal connection path after authorization completes.
    return { device: await this.beginGitHubDeviceAuth(config) };
  }

  private async authenticated<T>(config: McpServerConfig, operation: () => Promise<T>): Promise<T> {
    const token = this.accessTokens.get(config.id);
    try {
      return await operation();
    } catch (error) {
      // Network errors and permission failures must not discard valid credentials.
      if (config.authMode === "oauth" || !(error instanceof UnauthorizedError)) throw error;
      if (token && this.accessTokens.get(config.id) === token) {
        this.accessTokens.delete(config.id);
        this.refreshTokens.delete(config.id);
        const registration = this.registrations.get(config.id);
        if (registration) registration.authRequired = true;
        this.invalidateConnection(config.id);
        if (!registration?.calls) await this.releaseConnection(config.id).catch(() => {});
        await this.onAccessTokenInvalidated?.(config);
      }
      throw new McpAccountLoginRequiredError(config.name);
    }
  }

  /** GitHub's remote MCP does not support DCR; a user-provided OAuth App ID uses device login. */
  async beginGitHubDeviceAuth(config: McpServerConfig): Promise<{ userCode: string; verificationUri: string; expiresAt: number; completion: Promise<void> }> {
    if (config.authMode !== "github-device" || !config.oauthClientId) throw new Error("GitHub OAuth App Client ID is required");
    const active = this.deviceAuthSessions.get(config.id);
    if (active) return active;
    const response = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.oauthClientId, scope: "repo read:org workflow gist project" }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`GitHub device authorization failed: HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
    }
    const device = await response.json() as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string };
    if (!device.device_code || !device.user_code || !device.verification_uri) throw new Error(`GitHub device authorization failed: ${device.error ?? "invalid response"}`);
    const expiresAt = Date.now() + (device.expires_in ?? 900) * 1000;
    const generation = crypto.randomUUID();
    this.deviceAuthGenerations.set(config.id, generation);
    const completion = this.pollGitHubDevice(config, device.device_code, Math.max(5, device.interval ?? 5), expiresAt, generation)
      .finally(() => {
        if (this.deviceAuthGenerations.get(config.id) === generation) this.deviceAuthGenerations.delete(config.id);
        if (this.deviceAuthSessions.get(config.id)?.completion === completion) this.deviceAuthSessions.delete(config.id);
      });
    const session = { userCode: device.user_code, verificationUri: device.verification_uri, expiresAt, completion };
    this.deviceAuthSessions.set(config.id, session);
    return session;
  }

  private async pollGitHubDevice(config: McpServerConfig, deviceCode: string, interval: number, expiresAt: number, generation: string) {
    while (Date.now() < expiresAt && this.deviceAuthGenerations.get(config.id) === generation) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      if (this.deviceAuthGenerations.get(config.id) !== generation) return;
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.oauthClientId!, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`GitHub login failed: HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
      }
      const result = await response.json() as { access_token?: string; refresh_token?: string; error?: string; interval?: number };
      if (result.access_token) {
        if (this.deviceAuthGenerations.get(config.id) !== generation) return;
        const credential = serializeCredential(result.access_token, result.refresh_token);
        this.setAccessToken(config.id, credential);
        await this.onOAuthComplete?.(config.id, credential);
        return;
      }
      if (result.error === "authorization_pending") continue;
      if (result.error === "slow_down") { interval = Math.max(interval + 5, result.interval ?? 0); continue; }
      throw new Error(`GitHub login failed: ${result.error ?? "invalid token response"}`);
    }
    if (this.deviceAuthGenerations.get(config.id) === generation) throw new Error("GitHub login timed out");
  }

  /** GitHub OAuth apps may issue 8-hour tokens; rotate them with the refresh token on 401. */
  private refreshGitHubToken(config: McpServerConfig): Promise<void> {
    // A refresh token is single-use, so concurrent 401s must share one rotation.
    let pending = this.tokenRefreshes.get(config.id);
    if (!pending) {
      pending = this.rotateGitHubToken(config).finally(() => {
        if (this.tokenRefreshes.get(config.id) === pending) this.tokenRefreshes.delete(config.id);
      });
      this.tokenRefreshes.set(config.id, pending);
    }
    return pending;
  }

  private async rotateGitHubToken(config: McpServerConfig) {
    const refreshToken = this.refreshTokens.get(config.id);
    if (!refreshToken || !config.oauthClientId) throw new UnauthorizedError("GitHub access token expired");
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.oauthClientId, grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    if (!response.ok) throw new Error(`GitHub token refresh failed: HTTP ${response.status}`);
    const result = await response.json() as { access_token?: string; refresh_token?: string; error?: string };
    // Only a rejected refresh token means the login is gone; network/HTTP errors keep credentials.
    if (!result.access_token) throw new UnauthorizedError(`GitHub token refresh failed: ${result.error ?? "invalid response"}`);
    if (this.refreshTokens.get(config.id) !== refreshToken) return;
    const credential = serializeCredential(result.access_token, result.refresh_token);
    this.setAccessToken(config.id, credential);
    await this.onAccessTokenRefreshed?.(config, credential);
  }

  /** Start an OAuth 2.1 authorization-code + PKCE flow for an HTTP MCP server. */
  async beginOAuth(config: McpServerConfig): Promise<{ url: string; state: string } | undefined> {
    this.validateConfig(config);
    if (config.authMode === "oauth") {
      const authorization = await this.hosted(config).begin();
      if (authorization) {
        this.pendingHostedOAuth.set(authorization.state, { config, createdAt: Date.now() });
        await this.ensureOAuthCallbackServer("http://127.0.0.1:17891/mcp/oauth/callback");
      }
      return authorization;
    }
    if (!config.oauth) throw new Error(`MCP server ${config.id} has no OAuth configuration`);
    const state = crypto.randomUUID();
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const redirectUri = config.oauth.redirectUri ?? "http://127.0.0.1:17891/mcp/oauth/callback";
    this.pendingOAuth.set(state, { serverId: config.id, verifier, redirectUri, config, createdAt: Date.now() });
    await this.ensureOAuthCallbackServer(redirectUri);
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

  async completeOAuth(config: McpServerConfig, code: string, state: string, iss?: string): Promise<string | undefined> {
    if (config.authMode === "oauth") {
      const pending = this.pendingHostedOAuth.get(state);
      if (!pending || pending.config.id !== config.id || Date.now() - pending.createdAt > 10 * 60_000) throw new Error("invalid or expired MCP OAuth state");
      this.pendingHostedOAuth.delete(state);
      const provider = this.hosted(config);
      const generation = this.connectionGenerations.get(config.id) ?? 0;
      await provider.complete(code, state, iss);
      if (this.hostedOAuth.get(config.id) !== provider || this.stopped || (this.connectionGenerations.get(config.id) ?? 0) !== generation) throw new Error("MCP authorization was cancelled");
      await this.onOAuthComplete?.(config.id);
      return undefined;
    }
    const pending = this.pendingOAuth.get(state);
    if (!pending || pending.serverId !== config.id || Date.now() - pending.createdAt > 10 * 60_000) {
      this.pendingOAuth.delete(state);
      throw new Error("invalid or expired MCP OAuth state");
    }
    const oauth = pending.config.oauth;
    if (!oauth) throw new Error(`MCP server ${config.id} has no OAuth configuration`);
    this.pendingOAuth.delete(state);
    const generation = this.connectionGenerations.get(config.id) ?? 0;
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
    if (this.stopped || (this.connectionGenerations.get(config.id) ?? 0) !== generation) throw new Error("MCP authorization was cancelled");
    this.setAccessToken(config.id, token.access_token);
    await this.onOAuthComplete?.(config.id, token.access_token);
    return token.access_token;
  }

  private async ensureOAuthCallbackServer(redirectUri: string) {
    const url = new URL(redirectUri);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase())) return;
    const hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname === "[::1]" ? "::1" : url.hostname;
    const key = `${hostname}:${url.port || "80"}`;
    if (this.oauthCallbackServers.has(key)) return;
    const server = createServer(async (request, response) => {
      const reply = (status: number, body: string) => {
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        response.end(body);
      };
      const requestUrl = new URL(request.url ?? "/", `http://${key}`);
      const state = requestUrl.searchParams.get("state") ?? "";
      const code = requestUrl.searchParams.get("code") ?? "";
      const manual = this.pendingOAuth.get(state);
      const hosted = this.pendingHostedOAuth.get(state);
      const config = manual?.config ?? hosted?.config;
      const redirectUri = manual?.redirectUri ?? "http://127.0.0.1:17891/mcp/oauth/callback";
      if (!config || !code || new URL(redirectUri).pathname !== requestUrl.pathname) {
        reply(400, "Invalid or expired OAuth state");
        return;
      }
      try {
        await this.completeOAuth(config, code, state, requestUrl.searchParams.get("iss") ?? undefined);
        reply(200, "QoneAgent authorization complete. You may close this tab.");
      } catch (error) {
        this.onOAuthFailure?.(config.id, error instanceof Error ? error : new Error(String(error)));
        reply(500, "QoneAgent authorization failed.");
      }
    });
    this.oauthCallbackServers.set(key, server);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(url.port || 80), hostname, resolve);
      });
    } catch (error) {
      this.oauthCallbackServers.delete(key);
      throw error;
    }
  }

  /** Register cached tools without restoring credentials or spawning a server. */
  register(config: McpServerConfig): boolean {
    if (this.stopped) throw new Error("MCP manager is shutting down");
    this.validateConfig(config);
    const normalized = connectionConfig(config);
    const fingerprint = configFingerprint(normalized);
    const previous = this.registrations.get(config.id);
    if (previous?.fingerprint === fingerprint && !this.staleConnections.has(config.id)) {
      return previous.metadata !== undefined;
    }
    if (previous) {
      const a = previous.config, b = normalized;
      const targetChanged = !isDeepStrictEqual([a.url, a.authMode, a.oauth, a.oauthClientId], [b.url, b.authMode, b.oauth, b.oauthClientId]);
      void this.disconnect(config.id).catch(() => {});
      if (targetChanged) { this.clearCredentials(config.id); this.lifecycle.onAuthTargetChanged?.(normalized); }
    }
    this.staleConnections.delete(config.id);
    const registration: Registration = { config: structuredClone(normalized), fingerprint, tools: [], used: false, calls: 0 };
    this.registrations.set(config.id, registration);
    let cached: McpToolMetadata[] | undefined;
    try { cached = readCatalog(this.lifecycle.catalog?.get(catalogKey(config.id)), fingerprint); } catch { /* Cache is not authoritative. */ }
    if (cached) this.updateCatalog(registration, cached, false);
    this.onConnectionChange?.();
    return registration.metadata !== undefined;
  }

  private permitted(registration: Registration): boolean {
    return !this.stopped && this.registrations.get(registration.config.id) === registration && (this.lifecycle.canConnect?.(registration.config.id) ?? true);
  }

  private updateCatalog(registration: Registration, metadata: McpToolMetadata[], persist = true) {
    if (this.stopped || this.registrations.get(registration.config.id) !== registration) return;
    const changed = !isDeepStrictEqual(registration.metadata, metadata);
    registration.metadata = metadata;
    if (changed) {
      registration.tools = metadata.map(tool => this.adaptTool(registration, tool));
      this.lifecycle.onToolsChanged?.();
    }
    if (persist) {
      try { this.lifecycle.catalog?.set(catalogKey(registration.config.id), { fingerprint: registration.fingerprint, tools: metadata }); } catch { /* A successful handshake must survive cache write errors. */ }
    }
  }

  /** Background discovery is the only connection that may be released immediately. */
  async discover(config: McpServerConfig): Promise<void> {
    this.register(config);
    const registration = this.registrations.get(config.id)!;
    if (registration.metadata !== undefined) return;
    try { await this.ensureConnection(registration); }
    finally {
      if (this.registrations.get(config.id) === registration && !registration.used && !registration.calls && config.command) await this.releaseConnection(config.id);
    }
  }

  async connect(config: McpServerConfig, { reconnect = false } = {}): Promise<ToolDefinition[]> {
    this.register(config);
    const registration = this.registrations.get(config.id)!;
    registration.used = true;
    if (reconnect && this.conns.has(config.id)) {
      if (registration.calls) throw new Error(`MCP server ${config.name} is in use; reconnect after its calls finish`);
      await this.releaseConnection(config.id);
    }
    await this.ensureConnection(registration);
    return registration.tools;
  }

  private async ensureConnection(registration: Registration): Promise<Conn> {
    const { config } = registration;
    if (this.staleConnections.has(config.id) && this.registrations.get(config.id) === registration) throw new Error(`MCP server ${config.id} credentials changed`);
    if (!this.permitted(registration)) throw new Error(`MCP server ${config.id} is disabled or not authorized`);
    const existing = this.conns.get(config.id);
    if (existing) return existing;
    let operation = this.connecting.get(config.id);
    if (!operation) {
      const generation = this.connectionGenerations.get(config.id) ?? 0;
      const controller = new AbortController();
      this.connectControllers.set(config.id, controller);
      operation = (this.closing.get(config.id) ?? Promise.resolve()).then(() => this.connectOnce(config, generation, controller));
      this.connecting.set(config.id, operation);
      this.onConnectionChange?.();
      const flight = operation;
      void operation.finally(() => {
        if (this.connecting.get(config.id) === flight) this.connecting.delete(config.id);
        if (this.connectControllers.get(config.id) === controller) this.connectControllers.delete(config.id);
        this.onConnectionChange?.();
      }).catch(() => {});
    }
    try { await operation; }
    catch (error) {
      if (error instanceof McpAccountLoginRequiredError && this.registrations.get(config.id) === registration) {
        registration.authRequired = true;
        this.invalidateConnection(config.id);
      }
      throw error;
    }
    if (!this.permitted(registration)) throw new Error(`MCP server ${config.id} registration changed during connect`);
    const connection = this.conns.get(config.id);
    if (!connection) throw new Error(`MCP server ${config.id} closed during connect`);
    return connection;
  }

  private async connectOnce(config: McpServerConfig, generation: number, controller: AbortController): Promise<ToolDefinition[]> {
    controller.signal.throwIfAborted();
    await this.beforeConnect?.(config, controller.signal);
    controller.signal.throwIfAborted();
    const resolvedEnv = resolveMcpEnvironment(config.env, this.resolveSecret);
    const headers = resolveMcpEnvironment(config.headers, this.resolveSecret);
    const token = this.accessTokens.get(config.id) ?? (config.tokenEnv ? process.env[config.tokenEnv] : undefined);
    const hostedToken = config.authMode === "oauth" ? await this.hosted(config).bearerProvider().token() : undefined;
    controller.signal.throwIfAborted();
    if (config.authMode === "oauth" && !hostedToken) throw new McpAccountLoginRequiredError(config.name);
    if ((config.authMode === "github-device" || (config.oauth && config.authMode !== "oauth")) && !token) throw new McpAccountLoginRequiredError(config.name);
    const authProvider = config.authMode === "oauth"
      ? this.hosted(config).bearerProvider()
      : token ? {
        token: async () => this.accessTokens.get(config.id) ?? (config.tokenEnv ? process.env[config.tokenEnv] : undefined),
        ...(config.authMode === "github-device" ? { onUnauthorized: () => this.refreshGitHubToken(config) } : {}),
      } : undefined;
    controller.signal.throwIfAborted();
    const stdioEnv = config.command ? { ...getDefaultEnvironment(), ...toolProxyEnvironment(process.env, resolvedEnv) } : undefined;
    // Do not let npm prepend the app workspace's node_modules/.bin (and its bundled Node).
    const stdioCwd = config.cwd ?? homedir();
    const launch = config.command
      ? await resolveMcpStdioLaunch(config.command, config.args ?? [], { env: resolvedEnv ? stdioEnv : undefined, cwd: stdioCwd, signal: controller.signal })
      : undefined;
    const httpOptions = { ...(authProvider ? { authProvider } : {}), requestInit: { ...(headers ? { headers } : {}), signal: controller.signal } };
    const transport = config.url
      ? config.transport === "sse" ? new SSEClientTransport(new URL(config.url), httpOptions) : new StreamableHTTPClientTransport(new URL(config.url), httpOptions)
      : new TreeKillingStdioTransport({ command: launch!.command, args: launch!.args, env: stdioEnv, cwd: stdioCwd });
    const registration = this.registrations.get(config.id)!;
    const client = new Client({ name: "qone-agent", version: "0.0.1" }, {
      capabilities: {},
      listChanged: { tools: { onChanged: (error, tools) => {
        if (!error && tools && this.conns.get(config.id)?.client === client && !this.staleConnections.has(config.id)) this.updateCatalog(registration, tools);
      } } },
    });
    client.onclose = () => {
      if (this.conns.get(config.id)?.client !== client) return;
      this.conns.delete(config.id);
      this.onConnectionChange?.();
    };
    const timer = setTimeout(() => controller.abort(new Error(`MCP connection timed out: ${config.name}`)), DEFAULT_REQUEST_TIMEOUT_MSEC);
    const close = () => { void client.close().catch(() => {}); };
    controller.signal.addEventListener("abort", close, { once: true });
    try {
      controller.signal.throwIfAborted();
      const { tools } = await this.authenticated(config, async () => {
        await client.connect(transport, { signal: controller.signal });
        return client.listTools(undefined, { signal: controller.signal });
      });
      // A disconnect/delete during the handshake owns the teardown; never let
      // this late connection re-register itself as live.
      if ((this.connectionGenerations.get(config.id) ?? 0) !== generation || !this.permitted(registration)) {
        await client.close().catch(() => {});
        throw new Error(`MCP server ${config.id} was disconnected during connect`);
      }
      registration.authRequired = false;
      this.conns.set(config.id, { config, client });
      if (this.registrations.get(config.id) === registration && !this.staleConnections.has(config.id)) this.updateCatalog(registration, tools);
      return registration.tools;
    } catch (error) {
      await client.close().catch(() => {});
      if (controller.signal.aborted) throw controller.signal.reason;
      const stderr = transport instanceof TreeKillingStdioTransport ? transport.stderrTail.trim() : "";
      if (stderr && error instanceof Error) error.message += `\n${stderr}`;
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", close);
    }
  }

  private adaptTool(registration: Registration, t: McpToolMetadata): ToolDefinition {
    const config = registration.config;
    const serverId = config.id;
    const fullName = `mcp:${serverId}:${t.name}`;
    const usedNames = new Set(this.exposedToolNames.values());
    const exposedName = this.exposedToolNames.get(fullName) ?? safeToolName(fullName, usedNames);
    this.exposedToolNames.set(fullName, exposedName);
    const routing = serverId === "mcp-github"
      ? "Use this GitHub MCP tool only for authenticated GitHub data, account operations, private repositories, or writes. Use qone_github_public for structured unauthenticated GitHub API data."
      : undefined;
    return {
      name: exposedName,
      qoneToolName: fullName,
      label: `${serverId} · ${t.name}`,
      description: [routing, t.description ?? `MCP tool ${t.name} from ${serverId}`].filter(Boolean).join(" "),
      // MCP servers validate their own input; preserve the advertised schema so
      // the model receives the real parameter names and constraints.
      parameters: Type.Unsafe(t.inputSchema && typeof t.inputSchema === "object"
        ? t.inputSchema as Record<string, unknown>
        : { type: "object", additionalProperties: true }),
      outputSchema: t.outputSchema && typeof t.outputSchema === "object"
        ? Type.Unsafe(t.outputSchema as Record<string, unknown>) : undefined,
      execute: async (_id, params, signal) => {
        const res = await this.invoke(registration, t.name, params as Record<string, unknown>, signal, t);
        const text = Array.isArray(res.content)
          ? res.content
              .map((c: { type: string; text?: string }) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
              .join("\n")
          : JSON.stringify(res.content);
        return {
          content: [{ type: "text", text }],
          details: res.structuredContent ?? undefined,
          structuredContent: res.structuredContent,
          isError: Boolean(res.isError),
        } as never;
      },
    } as QoneMcpToolDefinition;
  }

  tools(): ToolDefinition[] {
    return [...this.registrations.values()].filter(registration => this.isAvailable(registration.config.id)).flatMap(registration => registration.tools);
  }

  /** Secret edits invalidate the directory without starting a process once per field. */
  invalidateConnection(id: string) {
    this.staleConnections.add(id);
    try { this.lifecycle.catalog?.delete(catalogKey(id)); } catch { /* Cache is optional. */ }
    this.lifecycle.onToolsChanged?.();
    this.onConnectionChange?.();
  }

  isRegistered(config: McpServerConfig): boolean {
    return !this.stopped && this.registrations.get(config.id)?.fingerprint === configFingerprint(config);
  }

  isAvailable(id: string): boolean {
    const registration = this.registrations.get(id);
    return Boolean(registration && this.permitted(registration) && !registration.authRequired && !this.staleConnections.has(id) && registration.metadata !== undefined);
  }
  isConnecting(id: string): boolean { return this.connecting.has(id); }
  isConnected(id: string): boolean { return this.conns.has(id); }
  toolCount(id: string): number { return this.registrations.get(id)?.metadata?.length ?? 0; }

  private async invoke(registration: Registration, name: string, args: Record<string, unknown>, signal?: AbortSignal, advertised?: McpToolMetadata) {
    const { config } = registration;
    const check = () => {
      signal?.throwIfAborted();
      if (!this.permitted(registration) || registration.authRequired || this.staleConnections.has(config.id)) throw new Error(`MCP server ${config.id} is disabled, changed or not authorized`);
    };
    check();
    registration.calls++;
    registration.used = true;
    const currentTool = () => registration.metadata?.find(tool => tool.name === name);
    const call = (connection: Conn) => this.authenticated(config, () => connection.client.callTool({ name, arguments: args }, { signal }));
    try {
      const connection = await waitForConnection(this.ensureConnection(registration), signal);
      check();
      const current = currentTool();
      if (!current || (advertised && !isDeepStrictEqual(current.inputSchema, advertised.inputSchema))) throw new Error(`MCP tool ${name} changed; use the refreshed tool definition`);
      if (current.annotations?.readOnlyHint !== true) return await call(connection);
      const first = await call(connection).then(result => ({ result }), error => ({ error: error as unknown }));
      const original = () => { if ("error" in first) throw first.error; return first.result; };
      const live = this.conns.get(config.id);
      const retryable = "error" in first ? isTransientMcpError(first.error) : isToolFetchFailure(first.result, name);
      // Replacing a connection must not interrupt another caller (which may be writing).
      if (!retryable || signal?.aborted || (live === connection && registration.calls > 1) || !this.permitted(registration) || this.staleConnections.has(config.id)) return original();
      if (live === connection) await this.releaseConnection(config.id);
      check();
      const replacement = await waitForConnection(this.ensureConnection(registration), signal);
      check();
      const refreshed = currentTool();
      if (refreshed?.annotations?.readOnlyHint !== true || !isDeepStrictEqual(refreshed.inputSchema, current.inputSchema)) return original();
      return await call(replacement);
    } catch (error) {
      if (error instanceof McpAccountLoginRequiredError) {
        registration.authRequired = true;
        this.invalidateConnection(config.id);
      }
      throw error;
    } finally { registration.calls--; }
  }

  /** Internal workflows use the same lazy connection and permission checks as model tools. */
  async callTool(id: string, name: string, args: Record<string, unknown>): Promise<void> {
    const registration = this.registrations.get(id);
    if (!registration) throw new Error(`MCP server ${id} is not registered`);
    const result = await this.invoke(registration, name, args);
    if (result.isError) {
      const detail = Array.isArray(result.content)
        ? result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map(part => part.text).join("\n") : "";
      throw new Error(detail || `${name} failed`);
    }
  }

  private releaseConnection(id: string): Promise<void> {
    const previous = this.closing.get(id);
    const connection = this.conns.get(id);
    if (!connection) return previous ?? Promise.resolve();
    this.conns.delete(id);
    const operation = (previous ?? Promise.resolve()).then(() => connection.client.close());
    this.closing.set(id, operation);
    this.onConnectionChange?.();
    void operation.finally(() => { if (this.closing.get(id) === operation) this.closing.delete(id); }).catch(() => {});
    return operation;
  }

  async disconnect(id: string) {
    this.connectionGenerations.set(id, (this.connectionGenerations.get(id) ?? 0) + 1);
    this.connectControllers.get(id)?.abort(new Error(`MCP server ${id} was disconnected during connect`));
    const pending = this.connecting.get(id);
    this.connecting.delete(id);
    this.staleConnections.delete(id);
    this.registrations.delete(id);
    this.deviceAuthGenerations.delete(id);
    this.deviceAuthSessions.delete(id);
    this.hostedOAuth.get(id)?.cancelAuthorization();
    for (const [state, auth] of this.pendingOAuth) if (auth.serverId === id) this.pendingOAuth.delete(state);
    for (const [state, auth] of this.pendingHostedOAuth) if (auth.config.id === id) this.pendingHostedOAuth.delete(state);
    try { this.lifecycle.catalog?.delete(catalogKey(id)); } catch { /* Cache is optional. */ }
    const closing = this.releaseConnection(id);
    const operation = Promise.all([closing, pending?.catch(() => {})]).then(() => {});
    this.closing.set(id, operation);
    void operation.finally(() => { if (this.closing.get(id) === operation) this.closing.delete(id); }).catch(() => {});
    this.lifecycle.onToolsChanged?.();
    this.onConnectionChange?.();
    await operation;
  }

  async disconnectAll() {
    this.stopped = true;
    // Preserve disk catalogs at application shutdown, unlike explicit removal.
    for (const controller of this.connectControllers.values()) controller.abort(new Error("MCP manager is shutting down"));
    await Promise.all([...this.connecting.values()].map(operation => operation.catch(() => {})));
    await Promise.all([...this.conns.keys()].map(id => this.releaseConnection(id).catch(() => {})));
    await Promise.all([...this.closing.values()].map(operation => operation.catch(() => {})));
    this.registrations.clear();
    for (const server of this.oauthCallbackServers.values()) server.close();
    this.oauthCallbackServers.clear();
    this.pendingOAuth.clear();
    this.pendingHostedOAuth.clear();
  }
}

function isTransientMcpError(error: unknown): boolean {
  if (error instanceof SdkHttpError) return [502, 503, 504].includes(error.data.status);
  if (error instanceof SdkError) return error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.RequestTimeout;
  return error instanceof TypeError && error.message === "fetch failed";
}

function isToolFetchFailure(result: CallToolResult, name: string): boolean {
  if (!result.isError || result.content?.length !== 1) return false;
  const part = result.content[0];
  if (part?.type !== "text") return false;
  // Some stdio servers flatten a rejected fetch into one text error instead of an HTTP status.
  const text = part.text.trim();
  return text === "fetch failed" || text === `${name} error: fetch failed`;
}

function waitForConnection<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function serializeCredential(accessToken: string, refreshToken?: string): string {
  return refreshToken ? JSON.stringify({ accessToken, refreshToken }) : accessToken;
}

function parseCredential(credential: string): { accessToken: string; refreshToken?: string } {
  // Plain tokens (legacy or non-expiring) never start with "{".
  if (!credential.startsWith("{")) return { accessToken: credential };
  const parsed = JSON.parse(credential) as { accessToken?: unknown; refreshToken?: unknown };
  if (typeof parsed.accessToken !== "string" || !parsed.accessToken) throw new Error("Invalid MCP credential");
  return { accessToken: parsed.accessToken, refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
