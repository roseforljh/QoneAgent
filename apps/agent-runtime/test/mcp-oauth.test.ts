import { describe, expect, test } from "bun:test";
import { McpManager, resolveMcpEnvironment, resolveStdioLaunch, safeToolName } from "@qone/mcp";
import { HostedMcpOAuth } from "../../../packages/mcp/src/hosted-oauth";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("MCP OAuth", () => {
  test("resolves stored API key references only after a credential is restored", () => {
    const env = { FIRECRAWL_API_KEY: "$mcp.env:mcp-firecrawl/FIRECRAWL_API_KEY", MODE: "stdio" };
    expect(() => resolveMcpEnvironment(env, () => undefined)).toThrow("MCP API key is unavailable");
    expect(resolveMcpEnvironment(env, (key) => key === "mcp.env:mcp-firecrawl/FIRECRAWL_API_KEY" ? "fc-test" : undefined))
      .toEqual({ FIRECRAWL_API_KEY: "fc-test", MODE: "stdio" });
  });
  test("launches Windows npx through Node without a command shell", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "qone-mcp-npx-"));
    try {
      const cli = path.join(directory, "node_modules", "npm", "bin", "npx-cli.js");
      mkdirSync(path.dirname(cli), { recursive: true });
      writeFileSync(path.join(directory, "npx.cmd"), "");
      writeFileSync(cli, "");
      expect(() => resolveStdioLaunch("npx", ["-y", "firecrawl-mcp"], "win32", directory))
        .toThrow("MCP_NPX_UNAVAILABLE");
      const node = path.join(directory, "node.exe");
      writeFileSync(node, "");
      expect(resolveStdioLaunch("npx", ["-y", "firecrawl-mcp"], "win32", directory))
        .toEqual({ command: node, args: [cli, "-y", "firecrawl-mcp"] });
      expect(resolveStdioLaunch("npx", ["-y", "firecrawl-mcp"], "linux", directory))
        .toEqual({ command: "npx", args: ["-y", "firecrawl-mcp"] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("restores hosted client and token separately without persisting them in config", () => {
    const persisted: string[] = [];
    const provider = new HostedMcpOAuth("https://mcp.example.test/mcp", (kind) => { persisted.push(kind); }, () => {});
    provider.restore("client", JSON.stringify({ client_id: "qone-test" }));
    provider.restore("tokens", JSON.stringify({ access_token: "private-test-token", token_type: "Bearer" }));
    expect(provider.clientInformation()?.client_id).toBe("qone-test");
    expect(provider.hasToken()).toBe(true);
    expect(persisted).toEqual([]);
    provider.clear();
    expect(provider.hasToken()).toBe(false);
  });
  test("normalizes model-facing tool names and avoids collisions", () => {
    const used = new Set<string>();
    const first = safeToolName("mcp:server:search", used);
    used.add(first);
    const second = safeToolName("mcp_server_search", used);
    expect(first).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(second).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(second).not.toBe(first);
  });

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
    const runtimeBun = (globalThis as { Bun: { serve: unknown } }).Bun;
    const runtimeServe = runtimeBun.serve;
    runtimeBun.serve = () => ({ stop() {} });
    let result: Awaited<ReturnType<McpManager["beginOAuth"]>>;
    try {
      result = await manager.beginOAuth({
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
    } finally {
      runtimeBun.serve = runtimeServe;
    }
    const url = new URL(result.url);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("qone-agent");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeString();
    await manager.disconnectAll();
  });
});
