import { expect, test } from "bun:test";
import { McpManager, resolveMcpEnvironment } from "../src/index";
import { HostedMcpOAuth } from "../src/hosted-oauth";

for (const transport of ["http", "sse"] as const) {
  test(`imported ${transport} headers reach handshake, listTools and tool calls`, async () => {
    const received: { method: string; key: string | null; authorization: string | null }[] = [];
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encode = new TextEncoder();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      received.push({ method: request.method, key: request.headers.get("x-api-key"), authorization: request.headers.get("authorization") });
      if (request.headers.get("x-api-key") !== "header-test" || request.headers.get("authorization") !== "Bearer token-test") return new Response(null, { status: 401 });
      if (request.method === "GET" && transport === "sse") {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(encode.encode("event: endpoint\ndata: /messages\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = await request.json() as { id?: string | number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : message.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "ok" }] };
      const response = { jsonrpc: "2.0", id: message.id, result };
      if (transport === "sse") { stream!.enqueue(encode.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`)); return new Response(null, { status: 202 }); }
      return Response.json(response);
    } });
    const secrets: Record<string, string> = { "mcp.env:fixture/header": "header-test", "mcp.env:fixture/auth": "Bearer token-test" };
    const manager = new McpManager(undefined, undefined, undefined, undefined, key => secrets[key]);
    try {
      const tools = await manager.connect({ id: "fixture", name: "Fixture", transport, url: `http://127.0.0.1:${server.port}/${transport}`, headers: { "X-Api-Key": "$mcp.env:fixture/header", Authorization: "$mcp.env:fixture/auth" } });
      expect(tools).toHaveLength(1);
      const result = await tools[0]!.execute("test", {}, undefined, undefined, {} as never);
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      expect(received.some(item => item.method === "POST")).toBe(true);
      if (transport === "sse") expect(received.some(item => item.method === "GET")).toBe(true);
      expect(received.every(item => item.key === "header-test" && item.authorization === "Bearer token-test")).toBe(true);
      expect(() => resolveMcpEnvironment({ TOKEN: "$mcp.env:missing/token" }, () => undefined)).toThrow("unavailable");
    } finally { await manager.disconnectAll(); server.stop(true); }
  });
}

test("empty imported environment values remain valid rather than being treated as missing", () => {
  expect(resolveMcpEnvironment({ OPTIONAL: "$mcp.env:fixture/optional" }, () => "")).toEqual({ OPTIONAL: "" });
});

test("an expired imported token reloads Claude's replacement without a new OAuth registration", async () => {
  const persisted: string[] = []; let refreshes = 0;
  const provider = new HostedMcpOAuth("https://example.com", (_kind, value) => { persisted.push(value); }, () => { throw new Error("unexpected login"); }, undefined, async () => {
    refreshes++;
    return JSON.stringify({ access_token: "source-renewed", token_type: "Bearer", qone_claude_source: true, qone_import_expires_at: Date.now() + 60000 });
  });
  provider.restore("tokens", JSON.stringify({ access_token: "expired", token_type: "Bearer", qone_claude_source: true, qone_import_expires_at: 1 }));
  expect(await provider.begin()).toBeUndefined();
  expect(await provider.bearerProvider().token()).toBe("source-renewed");
  expect(refreshes).toBe(1); expect(persisted).toHaveLength(1);
});

test("McpManager reconnects an expired imported account using the refreshed source token", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer renewed") return new Response(null, { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json() as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
      : { tools: [] } });
  } });
  const config = { id: "expired", name: "Source", authMode: "oauth" as const, url: `http://127.0.0.1:${server.port}/mcp` };
  let refreshed = 0;
  const manager = new McpManager(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => {
    refreshed++;
    return JSON.stringify({ access_token: "renewed", token_type: "Bearer", qone_claude_source: true, qone_import_expires_at: Date.now() + 60000 });
  });
  manager.restoreHostedCredential(config, "tokens", JSON.stringify({ access_token: "old", token_type: "Bearer", qone_claude_source: true, qone_import_expires_at: 1 }));
  try { await manager.connect(config); expect(refreshed).toBe(1); expect(manager.isConnected(config.id)).toBe(true); }
  finally { await manager.disconnectAll(); server.stop(true); }
});

test("imported OAuth expires without using Claude Code's refresh token; a Qone login replaces it", async () => {
  const provider = new HostedMcpOAuth("https://example.com", () => {}, () => {});
  provider.restore("tokens", JSON.stringify({ access_token: "imported", token_type: "Bearer", qone_import_expires_at: Date.now() - 1 }));
  expect(provider.hasToken()).toBe(false);
  expect(await provider.bearerProvider().token()).toBeUndefined();
  await provider.saveTokens({ access_token: "qone-login", token_type: "Bearer" });
  expect(provider.hasToken()).toBe(true);
  expect(await provider.bearerProvider().token()).toBe("qone-login");
  provider.clear(); expect(provider.hasToken()).toBe(false);
});

for (const outcome of ["refresh", "expired", "network", "unavailable"] as const) {
  test(`stored hosted OAuth ${outcome}: refresh or report login only after the saved credential is tried`, async () => {
    const invalidated: string[] = [], saved: string[] = [];
    let refreshes = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.includes("oauth-protected-resource")) return new Response(null, { status: 404 });
      if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration")) return Response.json({
        issuer: url.origin, authorization_endpoint: `${url.origin}/authorize`, token_endpoint: `${url.origin}/token`,
        response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
      });
      if (url.pathname === "/token") {
        refreshes++;
        expect((await request.formData()).get("refresh_token")).toBe("refresh-saved");
        if (outcome === "expired") return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (outcome === "unavailable") return Response.json({ error: "server_error" }, { status: 503 });
        return Response.json({ access_token: "renewed", refresh_token: "rotated", token_type: "Bearer" });
      }
      return new Response(null, { status: 404 });
    } });
    const provider = new HostedMcpOAuth(`http://127.0.0.1:${server.port}/mcp`, (_kind, value) => { saved.push(value); }, () => {}, kind => { invalidated.push(kind); });
    provider.restore("client", JSON.stringify({ client_id: "saved-client", token_endpoint_auth_method: "none" }));
    provider.restore("tokens", JSON.stringify({ access_token: "old", refresh_token: "refresh-saved", token_type: "Bearer" }));
    const originalFetch = globalThis.fetch;
    if (outcome === "network") globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith("/token")) { refreshes++; throw new Error("refresh connection refused"); }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const attempt = provider.bearerProvider().onUnauthorized!();
      if (outcome === "refresh") {
        await attempt;
        expect(await provider.bearerProvider().token()).toBe("renewed");
        expect(saved.some(value => value.includes("rotated"))).toBe(true);
      } else {
        const error = await attempt.then(() => undefined, error => error);
        expect(error).toBeInstanceOf(Error);
        if (outcome === "expired") {
          expect(error.code).toBe("mcp.loginRequired");
          expect(invalidated).toContain("tokens");
          expect(await provider.begin()).toMatchObject({ url: expect.stringContaining("/authorize"), state: expect.any(String) });
        } else {
          expect(error.code).not.toBe("mcp.loginRequired");
          expect(error.message).toContain(outcome === "network" ? "connection refused" : "HTTP 503");
          expect(invalidated).toEqual([]);
          expect(await provider.bearerProvider().token()).toBe("old");
        }
      }
      expect(refreshes).toBe(1);
    } finally { globalThis.fetch = originalFetch; server.stop(true); }
  });
}
