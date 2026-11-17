import { auth, type AuthProvider, type FetchLike, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";

import { McpAccountLoginRequiredError } from "./auth-error";

export type HostedOAuthCredential = "client" | "tokens";
export type HostedOAuthAuthorization = { url: string; state: string };

/** Hard ceiling for any OAuth HTTP call; discovery/registration must not hang a connect forever. */
const OAUTH_FETCH_TIMEOUT_MS = 30_000;

/**
 * `fetch` with a deadline. The SDK threads one `fetchFn` through discovery, DCR
 * and the token exchange, so bounding it here covers the whole handshake.
 */
export function boundedFetch(timeoutMs = OAUTH_FETCH_TIMEOUT_MS): FetchLike {
  return (url, init) => fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

/** One OAuth session per hosted MCP server. The SDK handles discovery, DCR, PKCE and refresh. */
export class HostedMcpOAuth implements OAuthClientProvider {
  private client?: StoredOAuthClientInformation;
  private tokenSet?: StoredOAuthTokens;
  private importedExpiresAt?: number;
  private discovery?: OAuthDiscoveryState;
  private verifier?: string;
  private pendingState?: string;
  private authorizationStartedAt = 0;
  private authorizationUrl?: URL;
  private refreshFailure?: unknown;
  private authorizationGeneration = 0;
  private readonly timedFetch = boundedFetch();
  private fetchFn: FetchLike = async (url, init) => {
    const generation = this.authorizationGeneration;
    const refreshing = init?.body instanceof URLSearchParams && init.body.get("grant_type") === "refresh_token";
    try {
      const response = await this.timedFetch(url, init);
      if (generation !== this.authorizationGeneration) throw new Error("MCP authorization was cancelled");
      // The SDK otherwise converts a refresh outage into a new interactive login.
      if (refreshing && !response.ok && (response.status === 429 || response.status >= 500)) {
        throw new Error(`MCP OAuth token refresh failed: HTTP ${response.status}`);
      }
      return response;
    } catch (error) { if (refreshing) this.refreshFailure = error; throw error; }
  };

  constructor(
    private readonly serverUrl: string,
    private readonly persist: (kind: HostedOAuthCredential, value: string) => void | Promise<void>,
    private readonly onAuthorizationRequired: (authorization: HostedOAuthAuthorization) => void,
    /** Told when the SDK rejects a persisted credential, so the disk copy is deleted too. */
    private readonly onInvalidate?: (kind: "client" | "tokens") => void | Promise<void>,
    private readonly refreshImportedToken?: () => Promise<string | undefined>,
  ) {}

  get redirectUrl() { return "http://127.0.0.1:17891/mcp/oauth/callback"; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "QoneAgent",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() { this.authorizationStartedAt = Date.now(); return this.pendingState = crypto.randomUUID(); }
  clientInformation() { return this.client; }
  async saveClientInformation(info: StoredOAuthClientInformation) {
    this.client = info;
    await this.persist("client", JSON.stringify(info));
  }
  tokens() { return this.importedExpiresAt !== undefined && this.importedExpiresAt <= Date.now() ? undefined : this.tokenSet; }
  async saveTokens(tokens: StoredOAuthTokens) {
    this.importedExpiresAt = undefined;
    this.tokenSet = tokens;
    this.authorizationUrl = undefined;
    await this.persist("tokens", JSON.stringify(tokens));
  }
  redirectToAuthorization(url: URL) {
    if (this.refreshFailure) throw this.refreshFailure;
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() {
    if (!this.verifier) throw new Error("MCP OAuth verifier is unavailable");
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) { this.discovery = state; }
  discoveryState() { return this.discovery; }

  restore(kind: HostedOAuthCredential, value: string) {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid stored MCP OAuth credential");
    if (kind === "client") {
      if (typeof (parsed as { client_id?: unknown }).client_id !== "string") throw new Error("Invalid stored MCP OAuth client");
      this.client = parsed as StoredOAuthClientInformation;
    } else {
      if (typeof (parsed as { access_token?: unknown }).access_token !== "string") throw new Error("Invalid stored MCP OAuth token");
      this.tokenSet = parsed as StoredOAuthTokens;
      const expiresAt = (parsed as { qone_import_expires_at?: unknown }).qone_import_expires_at;
      this.importedExpiresAt = typeof expiresAt === "number" ? expiresAt : undefined;
    }
  }

  hasToken() { return Boolean(this.tokens()?.access_token); }
  cancelAuthorization() {
    this.authorizationGeneration++;
    this.pendingState = undefined;
    this.verifier = undefined;
    this.authorizationUrl = undefined;
  }
  clear() {
    this.cancelAuthorization();
    this.client = undefined;
    this.tokenSet = undefined;
    this.importedExpiresAt = undefined;
    this.discovery = undefined;
    this.verifier = undefined;
    this.pendingState = undefined;
    this.authorizationUrl = undefined;
  }

  /**
   * The SDK calls this when a credential is rejected (invalid_client /
   * invalid_grant). Without it the dead copy stays on disk and every restart
   * retries the same rejected registration.
   */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") { this.tokenSet = undefined; this.importedExpiresAt = undefined; }
    if (scope === "all" || scope === "client") this.client = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    // verifier/discovery are in-memory only — nothing on disk to delete.
    const kinds = scope === "all" ? (["client", "tokens"] as const)
      : scope === "client" || scope === "tokens" ? ([scope] as const)
      : [];
    for (const kind of kinds) await this.onInvalidate?.(kind);
  }

  async begin(): Promise<HostedOAuthAuthorization | undefined> {
    if (await this.refreshImported()) return undefined;
    if (this.authorizationUrl && this.pendingState && Date.now() - this.authorizationStartedAt < 10 * 60_000) {
      return { url: this.authorizationUrl.toString(), state: this.pendingState };
    }
    this.refreshFailure = undefined;
    const result = await auth(this, { serverUrl: this.serverUrl, fetchFn: this.fetchFn });
    if (result === "AUTHORIZED") return undefined;
    if (!this.authorizationUrl || !this.pendingState) throw new Error("MCP OAuth did not provide an authorization URL");
    return { url: this.authorizationUrl.toString(), state: this.pendingState };
  }

  async complete(code: string, state: string, iss?: string) {
    if (!this.pendingState || state !== this.pendingState) throw new Error("invalid MCP OAuth state");
    await auth(this, { serverUrl: this.serverUrl, authorizationCode: code, iss, fetchFn: this.fetchFn });
    this.pendingState = undefined;
    this.verifier = undefined;
    this.authorizationUrl = undefined;
  }

  private async refreshImported() {
    if (!(this.tokenSet as { qone_claude_source?: boolean } | undefined)?.qone_claude_source) return false;
    const value = await this.refreshImportedToken?.();
    if (!value) return false;
    this.restore("tokens", value);
    if (!this.hasToken()) return false;
    await this.persist("tokens", value);
    return true;
  }

  /** Current bearer token plus one refresh attempt when the MCP server rejects it. */
  bearerProvider(): AuthProvider {
    return {
      token: async () => {
        if (!this.hasToken()) await this.refreshImported();
        return this.tokens()?.access_token;
      },
      onUnauthorized: async () => {
        const authorization = await this.begin();
        if (authorization) {
          // The runtime only forwards this authorization for a user-requested login.
          this.onAuthorizationRequired(authorization);
          throw new McpAccountLoginRequiredError(new URL(this.serverUrl).hostname);
        }
      },
    };
  }
}
