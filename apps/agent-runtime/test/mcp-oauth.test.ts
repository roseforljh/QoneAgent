import { describe, expect, test } from "bun:test";
import { McpManager, resolveMcpEnvironment, resolveStdioLaunch, safeToolName } from "@qone/mcp";
import { resolveMcpStdioLaunch } from "../../../packages/mcp/src/stdio-launch";
import { HostedMcpOAuth } from "../../../packages/mcp/src/hosted-oauth";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  test.skipIf(process.platform !== "win32")("starts an npx package bin with Node instead of keeping npx resident", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "qone-mcp-direct-"));
    const savedPath = process.env.Path;
    try {
      const root = path.join(directory, "_npx", "abc");
      const binDirectory = path.join(root, "node_modules", ".bin");
      const packageDirectory = path.join(root, "node_modules", "@scope", "fake-mcp");
      mkdirSync(binDirectory, { recursive: true });
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@scope/fake-mcp": "^1.0.0" } }));
      writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ bin: { "fake-mcp": "dist/cli.js", other: "x.js" } }));
      const cli = path.join(directory, "node_modules", "npm", "bin", "npx-cli.js");
      mkdirSync(path.dirname(cli), { recursive: true });
      writeFileSync(path.join(directory, "npx.cmd"), "");
      mkdirSync(path.join(packageDirectory, "dist"));
      writeFileSync(path.join(packageDirectory, "dist", "cli.js"), "");
      writeFileSync(cli, `process.stdout.write(${JSON.stringify([binDirectory, path.join(directory, "node_modules", ".bin")].join(";"))});`);
      process.env.Path = `${directory};${savedPath}`;
      const signal = new AbortController().signal;
      const launch = await resolveMcpStdioLaunch("npx", ["-y", "@scope/fake-mcp@latest", "--port", "1"], { cwd: directory, signal });
      expect(launch.args).toEqual([path.join(packageDirectory, "dist", "cli.js"), "--port", "1"]);
      expect(path.basename(launch.command).toLowerCase()).toBe("node.exe");
      // Unrecognised npx flags keep the plain npx launch.
      expect((await resolveMcpStdioLaunch("npx", ["--registry=x", "pkg"], { cwd: directory, signal })).args).toEqual([cli, "--registry=x", "pkg"]);
    } finally {
      process.env.Path = savedPath;
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
  test("rejects invalidated credentials and deletes the persisted copy", async () => {
    const invalidated: string[] = [];
    const provider = new HostedMcpOAuth("https://mcp.example.test/mcp", () => {}, () => {}, (kind) => { invalidated.push(kind); });
    provider.restore("client", JSON.stringify({ client_id: "qone-test" }));
    provider.restore("tokens", JSON.stringify({ access_token: "private-test-token", token_type: "Bearer" }));
    await provider.invalidateCredentials("tokens");
    expect(provider.hasToken()).toBe(false);
    expect(provider.clientInformation()?.client_id).toBe("qone-test");
    expect(invalidated).toEqual(["tokens"]);
    await provider.invalidateCredentials("all");
    expect(provider.clientInformation()).toBeUndefined();
    expect(invalidated).toEqual(["tokens", "client", "tokens"]);
    // In-memory-only scopes must not touch the persisted credential.
    invalidated.length = 0;
    await provider.invalidateCredentials("verifier");
    expect(invalidated).toEqual([]);
  });

  test("bounds the OAuth discovery fetch with a deadline", async () => {
    const originalFetch = globalThis.fetch;
    let sawSignal = false;
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      seenInit = init;
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 });
    }) as typeof fetch;
    try {
      const provider = new HostedMcpOAuth("https://mcp.example.test/mcp", () => {}, () => {});
      await provider.begin().catch(() => undefined);
      expect(sawSignal).toBe(true);
      // A pre-existing caller signal must win over the deadline.
      expect(seenInit?.signal?.aborted).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    // A free loopback port keeps the test independent of a running Qone instance.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const result = await manager.beginOAuth({
      id: "demo",
      name: "Demo",
      url: "https://mcp.example.test/mcp",
      oauth: {
        authorizationUrl: "https://auth.example.test/authorize",
        tokenUrl: "https://auth.example.test/token",
        clientId: "qone-agent",
        scopes: ["mcp:tools"],
        redirectUri: `http://127.0.0.1:${port}/mcp/oauth/callback`,
      },
    });
    const url = new URL(result!.url);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("qone-agent");
    expect(url.searchParams.get("state")).toBe(result!.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeString();
    // The loopback callback server is live and rejects unknown state.
    expect((await fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?state=unknown&code=x`)).status).toBe(400);
    await manager.disconnectAll();
  });

  test("starts GitHub re-login before probing the MCP endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 0,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const manager = new McpManager();
      const config = {
        id: "mcp-github",
        name: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        authMode: "github-device" as const,
        oauthClientId: "github-client",
      };
      manager.setAccessToken(config.id, "expired-token");
      const result = await manager.connectGitHub(config);
      expect(result.device?.verificationUri).toBe("https://github.com/login/device");
      expect(urls).toEqual(["https://github.com/login/device/code"]);
      await expect(result.device!.completion).rejects.toThrow("GitHub login timed out");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rotates an expiring GitHub token once and persists the new pair", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(String(init?.body));
      const spent = bodies.length > 1;
      return new Response(JSON.stringify(spent ? { error: "bad_refresh_token" } : { access_token: "gho_new", refresh_token: "ghr_new" }), { status: 200 });
    }) as typeof fetch;
    try {
      const saved: string[] = [];
      const manager = new McpManager(undefined, undefined, undefined, undefined, undefined, undefined, (_config, credential) => { saved.push(credential); });
      const config = { id: "mcp-github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authMode: "github-device" as const, oauthClientId: "github-client" };
      manager.setAccessToken(config.id, JSON.stringify({ accessToken: "gho_old", refreshToken: "ghr_old" }));
      const refresh = () => (manager as unknown as { refreshGitHubToken(value: typeof config): Promise<void> }).refreshGitHubToken(config);
      await Promise.all([refresh(), refresh()]);
      expect(bodies).toHaveLength(1);
      expect(new URLSearchParams(bodies[0]).get("refresh_token")).toBe("ghr_old");
      expect(saved).toEqual([JSON.stringify({ accessToken: "gho_new", refreshToken: "ghr_new" })]);
      await expect(refresh()).rejects.toThrow("bad_refresh_token");
      manager.setAccessToken(config.id, "gho_plain");
      bodies.length = 0;
      await expect(refresh()).rejects.toThrow("GitHub access token expired");
      expect(bodies).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
