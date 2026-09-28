/** A rejected bearer token requires an explicit account login. */
export class McpAccountLoginRequiredError extends Error {
  constructor(serverName: string) {
    super(`${serverName} 登录凭据已失效，请重新登录授权。`);
    this.name = "McpAccountLoginRequiredError";
  }
}
