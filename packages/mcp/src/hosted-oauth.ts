import { auth, type AuthProvider, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";

export type HostedOAuthCredential = "client" | "tokens";
export type HostedOAuthAuthorization = { url: string; state: string };

/** One OAuth session per hosted MCP server. The SDK handles discovery, DCR, PKCE and refresh. */
export class HostedMcpOAuth implements OAuthClientProvider {
  private client?: StoredOAuthClientInformation;
  private tokenSet?: StoredOAuthTokens;
  private discovery?: OAuthDiscoveryState;
  private verifier?: string;
  private pendingState?: string;
  private authorizationUrl?: URL;

  constructor(
    private readonly serverUrl: string,
    private readonly persist: (kind: HostedOAuthCredential, value: string) => void | Promise<void>,
    private readonly onAuthorizationRequired: (authorization: HostedOAuthAuthorization) => void,
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

  state() { return this.pendingState = crypto.randomUUID(); }
  clientInformation() { return this.client; }
  async saveClientInformation(info: StoredOAuthClientInformation) {
    this.client = info;
    await this.persist("client", JSON.stringify(info));
  }
  tokens() { return this.tokenSet; }
  async saveTokens(tokens: StoredOAuthTokens) {
    this.tokenSet = tokens;
    await this.persist("tokens", JSON.stringify(tokens));
  }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
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
    }
  }

  hasToken() { return Boolean(this.tokenSet?.access_token); }
  clear() {
    this.client = undefined;
    this.tokenSet = undefined;
    this.discovery = undefined;
    this.verifier = undefined;
    this.pendingState = undefined;
    this.authorizationUrl = undefined;
  }

  async begin(): Promise<HostedOAuthAuthorization | undefined> {
    const result = await auth(this, { serverUrl: this.serverUrl });
    if (result === "AUTHORIZED") return undefined;
    if (!this.authorizationUrl || !this.pendingState) throw new Error("MCP OAuth did not provide an authorization URL");
    return { url: this.authorizationUrl.toString(), state: this.pendingState };
  }

  async complete(code: string, state: string, iss?: string) {
    if (!this.pendingState || state !== this.pendingState) throw new Error("invalid MCP OAuth state");
    await auth(this, { serverUrl: this.serverUrl, authorizationCode: code, iss });
    this.pendingState = undefined;
    this.verifier = undefined;
    this.authorizationUrl = undefined;
  }

  /** Current bearer token plus one refresh attempt when the MCP server rejects it. */
  bearerProvider(): AuthProvider {
    return {
      token: async () => this.tokenSet?.access_token,
      onUnauthorized: async () => {
        const authorization = await this.begin();
        if (authorization) {
          this.onAuthorizationRequired(authorization);
          throw new Error("MCP account login is required");
        }
      },
    };
  }
}
