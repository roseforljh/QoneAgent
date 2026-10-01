/** A rejected bearer token requires an explicit account login. */
export class McpAccountLoginRequiredError extends Error {
  readonly code = "mcp.loginRequired";
  readonly values: { p0: string };
  constructor(serverName: string) {
    super(`${serverName} login credentials have expired. Sign in again to authorize access.`);
    this.name = "McpAccountLoginRequiredError";
    this.values = { p0: serverName };
  }
}
