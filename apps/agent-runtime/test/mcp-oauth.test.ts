import { describe, expect, test } from "bun:test";
import { McpManager } from "@qone/mcp";

describe("MCP OAuth", () => {
  test("rejects remote cleartext OAuth endpoints", async () => {
    const manager = new McpManager();
    await expect(manager.beginOAuth({
      id: "demo",
      name: "Demo",
      url: "https://mcp.example.test/mcp",
      oauth: {
        authorizationUrl: "http://auth.example.test/authorize",
        tokenUrl: "https://auth.example.test/token",
        clientId: "qone-agent",
      },
    })).rejects.toThrow("HTTPS");
  });

  test("creates a PKCE authorization request without exposing a token", async () => {
    const manager = new McpManager();
    const result = await manager.beginOAuth({
      id: "demo",
      name: "Demo",
      url: "https://mcp.example.test/mcp",
      oauth: {
        authorizationUrl: "https://auth.example.test/authorize",
        tokenUrl: "https://auth.example.test/token",
        clientId: "qone-agent",
        scopes: ["mcp:tools"],
      },
    });
    const url = new URL(result.url);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("qone-agent");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeString();
    await manager.disconnectAll();
  });
});
