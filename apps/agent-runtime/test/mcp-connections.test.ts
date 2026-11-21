import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigFile, McpServerRepo, PermissionRepo } from "@qone/database";
import { McpAccountLoginRequiredError, McpManager } from "@qone/mcp";
import { decodeCommand, type McpServerInfo, type RuntimeEvent } from "@qone/protocol";
import { acknowledgeMcpCredentials, connectMcp, mcpServerList, restoreMcpCredentials } from "../src/mcp-connections";
import { handleRuntimeCommand } from "../src/runtime-commands";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0)) await action(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function harness(authMode?: "oauth" | "github-device") {
  const root = mkdtempSync(path.join(tmpdir(), "qone-mcp-restore-"));
  let handshakes = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (request.headers.get("x-one") !== "one" || request.headers.get("x-two") !== "two") return new Response(null, { status: 403 });
    if (authMode && request.headers.get("authorization") !== "Bearer restored") return new Response(null, { status: 401 });
    const message = await request.json() as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize") handshakes++;
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : { tools: [] } });
  } });
  const config: McpServerInfo = { id: "fixture", name: "Fixture", url: `http://127.0.0.1:${server.port}/mcp`, authMode,
    headers: { "X-One": "$mcp.env:fixture/one", "X-Two": "$mcp.env:fixture/two" } };
  const settings = new ConfigFile(path.join(root, "settings.json"));
  const repo = new McpServerRepo(settings); repo.upsert(config);
  const events: RuntimeEvent[] = [], secrets = new Map<string, string>();
  const services = {
    mcpServerRepo: repo, permissionRepo: new PermissionRepo(settings), runtimeSecrets: secrets,
    pendingMcpAuthRequests: new Map<string, string>(), mcpConnectionApprovals: new Map<string, McpServerInfo>(), send: (event: RuntimeEvent) => { events.push(event); },
    authorizeCommand: async () => {}, refreshCustomTools: async () => {}, adapter: { deleteSecret: async () => {} },
    mcp: undefined as unknown as McpManager,
  };
  const manager = new McpManager(undefined, undefined, undefined, undefined, key => secrets.get(key), undefined, undefined, undefined, undefined,
    (config, signal) => restoreMcpCredentials(config, services, signal), () => services.send({ type: "mcp.list", servers: mcpServerList(services) }), {
      canConnect: id => {
        const decision = services.permissionRepo.get(`mcp:${id}`, "mcp.connect"), approved = services.mcpConnectionApprovals.get(id);
        return decision === "allow" || (decision === "ask" && !!approved && manager.isRegistered(approved));
      },
    });
  services.permissionRepo.set(`mcp:${config.id}`, "mcp.connect", "allow");
  services.mcp = manager;
  cleanup.push(async () => { await manager.disconnectAll(); server.stop(true); rmSync(root, { recursive: true, force: true }); });
  const requests = () => events.filter((event): event is Extract<RuntimeEvent, { type: "mcp.credentials.request" }> => event.type === "mcp.credentials.request");
  const restore = (ok = true) => acknowledgeMcpCredentials({ type: "mcp.credentials.restored", requestId: requests().at(-1)!.requestId, ok, values: {
    "mcp.env:fixture/one": "one", "mcp.env:fixture/two": "two", "not-requested": "must-not-restore",
    "mcp.oauth:fixture.client": '{"client_id":"local"}', "mcp.oauth:fixture.tokens": '{"access_token":"restored","token_type":"Bearer"}',
  } });
  return { services, config, events, requests, restore, handshakes: () => handshakes, secrets, manager, repo };
}

test("startup and repeated user connects share one delayed native batch and handshake, with OAuth and multiple headers restored first", async () => {
  const h = harness("oauth");
  const startup = connectMcp(h.config, h.services as never);
  const user = handleRuntimeCommand({ type: "mcp.connect", requestId: "user", config: { ...h.config, disabled: true } }, h.services as never);
  const duplicate = connectMcp(h.config, h.services as never, "duplicate");
  await tick();
  expect(h.requests()).toHaveLength(1);
  expect(h.requests()[0]!.keys).toEqual(["mcp.oauth:fixture.client", "mcp.oauth:fixture.tokens", "mcp.env:fixture/one", "mcp.env:fixture/two"]);
  expect(h.handshakes()).toBe(0);
  expect(mcpServerList(h.services)[0]?.connecting).toBe(true);
  expect(h.events.some(event => event.type === "mcp.oauth.authorization")).toBe(false);
  h.restore();
  await Promise.all([startup, user, duplicate]);
  expect(h.handshakes()).toBe(1);
  expect(h.secrets.size).toBe(4);
  expect(h.secrets.has("not-requested")).toBe(false);
  expect(h.repo.list()[0]?.disabled).toBeUndefined();
  expect(mcpServerList(h.services)[0]).toMatchObject({ connected: true, connecting: false });
  await h.manager.connect({ ...h.config, connected: true } as never);
  expect(h.handshakes()).toBe(1);
  const reconnect = decodeCommand(JSON.stringify({ type: "mcp.connect", requestId: "reconnect", config: h.config, reconnect: true }));
  expect(reconnect).toMatchObject({ type: "mcp.connect", reconnect: true });
  await handleRuntimeCommand(reconnect!, h.services as never);
  expect(h.handshakes()).toBe(2);
  expect(h.requests()).toHaveLength(1);
});

test("disable cancels a native restore; a late reply cannot restore secrets or revive the service, and explicit enable clears disabled", async () => {
  const h = harness();
  const connection = connectMcp(h.config, h.services as never).catch(error => error as Error);
  await tick();
  expect(h.requests()).toHaveLength(1);
  await handleRuntimeCommand({ type: "mcp.disconnect", requestId: "off", serverId: h.config.id }, h.services as never);
  h.restore();
  expect(await connection).toBeInstanceOf(Error);
  expect(h.secrets.size).toBe(0);
  expect(h.repo.list()[0]?.disabled).toBe(true);
  expect(h.handshakes()).toBe(0);
  const enabled = handleRuntimeCommand({ type: "mcp.connect", requestId: "on", config: h.repo.list()[0]! }, h.services as never);
  await tick(); h.restore(); await enabled;
  expect(h.repo.list()[0]?.disabled).toBeUndefined();
  expect(h.handshakes()).toBe(1);
});

test("unreadable native storage is retryable and never starts account login", async () => {
  const h = harness("oauth");
  const failed = connectMcp(h.config, h.services as never, "first").catch(error => error as Error);
  await tick(); h.restore(false);
  expect((await failed).message).toContain("could not be read");
  expect(h.events.some(event => event.type === "mcp.oauth.authorization")).toBe(false);
  expect(h.secrets.size).toBe(0);
  const retry = connectMcp(h.config, h.services as never, "retry");
  await tick(); expect(h.requests()).toHaveLength(2); h.restore(); await retry;
  expect(h.handshakes()).toBe(1);
});

test("one-time connect approval stays in memory and an explicit permission change revokes it", async () => {
  const h = harness();
  h.services.permissionRepo.set(`mcp:${h.config.id}`, "mcp.connect", "ask");
  const config = { ...h.config, headers: { "X-One": "one", "X-Two": "two" } };
  await handleRuntimeCommand({ type: "mcp.connect", requestId: "once", config }, h.services as never);
  expect(h.manager.isAvailable(config.id)).toBe(true);
  expect(h.services.permissionRepo.get(`mcp:${config.id}`, "mcp.connect")).toBe("ask");
  expect(h.services.mcpConnectionApprovals.has(config.id)).toBe(true);
  await handleRuntimeCommand({ type: "permission.set", requestId: "revoke", subjectId: `mcp:${config.id}`, permission: "mcp.connect", decision: "ask" }, h.services as never);
  expect(h.manager.isAvailable(config.id)).toBe(false);
  expect(h.services.mcpConnectionApprovals.has(config.id)).toBe(false);
});

test("credential deletion updates a sleeping server without starting it", async () => {
  const h = harness();
  h.manager.register(h.config);
  expect(h.handshakes()).toBe(0);
  expect(h.requests()).toHaveLength(0);
  await handleRuntimeCommand({ type: "secret.delete", requestId: "delete-key", key: "mcp.env:fixture/one" }, h.services as never);
  expect(h.manager.isAvailable(h.config.id)).toBe(false);
  expect(h.handshakes()).toBe(0);
});

test("services without credential references connect immediately without a native request", async () => {
  const h = harness();
  await h.manager.connect({ ...h.config, headers: { "X-One": "one", "X-Two": "two" } });
  expect(h.requests()).toHaveLength(0);
  expect(h.handshakes()).toBe(1);
});

test("secret.set only updates memory; a later explicit reconnect applies all edits together", async () => {
  const h = harness();
  const connection = connectMcp(h.config, h.services as never);
  await tick(); h.restore(); await connection;
  await handleRuntimeCommand({ type: "secret.set", requestId: "edit-one", key: "mcp.env:fixture/one", value: "new-one" }, h.services as never);
  await handleRuntimeCommand({ type: "secret.set", requestId: "edit-two", key: "mcp.env:fixture/two", value: "new-two" }, h.services as never);
  expect(h.manager.isConnected(h.config.id)).toBe(true);
  expect(h.handshakes()).toBe(1);
  expect(h.requests()).toHaveLength(1);
  // Put valid values back and explicitly reconnect: one handshake, not one per key.
  await handleRuntimeCommand({ type: "secret.set", requestId: "edit-back-one", key: "mcp.env:fixture/one", value: "one" }, h.services as never);
  await handleRuntimeCommand({ type: "secret.set", requestId: "edit-back-two", key: "mcp.env:fixture/two", value: "two" }, h.services as never);
  await connectMcp(h.config, h.services as never, "reconnect");
  expect(h.handshakes()).toBe(2);
  expect(h.requests()).toHaveLength(1);
});

test("a configuration edit replaces a pending restore and an immediate disable cancels the replacement too", async () => {
  const h = harness();
  const first = h.manager.connect(h.config).catch(error => error);
  await tick();
  const oldRequest = h.requests()[0]!;
  const replacement = h.manager.connect({ ...h.config, args: ["changed"] }).catch(error => error);
  await h.manager.disconnect(h.config.id);
  acknowledgeMcpCredentials({ type: "mcp.credentials.restored", requestId: oldRequest.requestId, ok: true, values: { "mcp.env:fixture/one": "old" } });
  expect(await first).toBeInstanceOf(Error);
  expect(await replacement).toBeInstanceOf(Error);
  expect(h.manager.isConnected(h.config.id)).toBe(false);
  expect(h.handshakes()).toBe(0);
  expect(h.secrets.size).toBe(0);
});

test("a late native reply cannot overwrite a credential just updated in memory", async () => {
  const h = harness("oauth");
  const connection = connectMcp(h.config, h.services as never);
  await tick();
  await handleRuntimeCommand({ type: "secret.set", requestId: "new", key: "mcp.oauth:fixture.tokens", value: '{"access_token":"restored","token_type":"Bearer","version":"new"}' }, h.services as never);
  h.restore(); await connection;
  expect(h.secrets.get("mcp.oauth:fixture.tokens")).toContain('"version":"new"');
  expect(h.handshakes()).toBe(1);
});

test("a real connection edit reconnects once while the same configuration reuses its client", async () => {
  const h = harness();
  const connection = connectMcp(h.config, h.services as never);
  await tick(); h.restore(); await connection;
  const edited = { ...h.config, url: `${h.config.url}?edited=1` };
  await h.manager.connect(edited);
  await h.manager.connect(edited);
  expect(h.handshakes()).toBe(2);
  expect(h.requests()).toHaveLength(1);
});

test("a rejected saved access token reports login-required instead of cancelling its own handshake", async () => {
  const h = harness("github-device");
  h.secrets.set("mcp.env:fixture/one", "one"); h.secrets.set("mcp.env:fixture/two", "two");
  await handleRuntimeCommand({ type: "secret.set", requestId: "saved", key: "mcp.oauth:fixture", value: "rejected" }, h.services as never);
  const error = await h.manager.connect(h.config).catch(error => error);
  expect(error).toBeInstanceOf(McpAccountLoginRequiredError);
  expect(h.manager.hasAccessToken(h.config.id)).toBe(false);
  expect(h.manager.isConnecting(h.config.id)).toBe(false);
  expect(h.manager.isConnected(h.config.id)).toBe(false);
});
