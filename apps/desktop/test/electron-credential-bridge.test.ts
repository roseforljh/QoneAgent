import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installElectronMock } from "./helpers/electron-mock";

// Bun keeps one module-mock registry per process, so every Electron test must
// install the same full boundary mock instead of replacing each other.
installElectronMock();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qone-secret-test-"));
const previousDataDir = process.env.QONE_DATA_DIR;
process.env.QONE_DATA_DIR = dataDir;

const { persistRuntimeSecret, getSecret } = await import("../electron/secret-store");
const { SidecarManager } = await import("../electron/sidecar");

const TOKEN = "tok-live-0123456789";
const CREDENTIAL = '{"client_id":"abc","client_secret":"shh"}';

beforeAll(() => { fs.rmSync(path.join(dataDir, "auth"), { recursive: true, force: true }); });
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.QONE_DATA_DIR;
  else process.env.QONE_DATA_DIR = previousDataDir;
});

test("token events persist under the protocol key and forward a redacted acknowledgement", () => {
  const forwarded = persistRuntimeSecret({ type: "mcp.oauth.token", requestId: "oauth-callback", serverId: "mcp-github", key: "mcp.oauth:mcp-github", accessToken: TOKEN });
  expect(forwarded).toEqual({ type: "mcp.oauth.saved", serverId: "mcp-github", key: "mcp.oauth:mcp-github" });
  expect(getSecret("mcp.oauth:mcp-github")).toBe(TOKEN);

  persistRuntimeSecret({ type: "mcp.oauth.credential", serverId: "mcp-github", key: "mcp.oauth:mcp-github.client", value: CREDENTIAL });
  expect(getSecret("mcp.oauth:mcp-github.client")).toBe(CREDENTIAL);
});

test("invalidated events delete the named key only", () => {
  persistRuntimeSecret({ type: "mcp.oauth.invalidated", serverId: "mcp-github", key: "mcp.oauth:mcp-github" });
  expect(getSecret("mcp.oauth:mcp-github")).toBeNull();
  expect(getSecret("mcp.oauth:mcp-github.client")).toBe(CREDENTIAL);
});

test("events without a credential are forwarded untouched", () => {
  const event = { type: "pong", requestId: "p" };
  expect(persistRuntimeSecret(event)).toBe(event);
  expect(persistRuntimeSecret({ type: "mcp.oauth.token", serverId: "s", key: "mcp.oauth:s" })).toBeNull();
});

test("batched NDJSON arrays are intercepted per event and leak no credential to the renderer", () => {
  const emitted: unknown[] = [];
  const window = { isDestroyed: () => false, webContents: { send: (_channel: string, payload: unknown) => emitted.push(payload) } };
  const sidecar = new SidecarManager(() => window as never);
  const line = JSON.stringify([
    { type: "agent.event", event: { type: "agent.completed" } },
    { type: "mcp.oauth.token", requestId: "oauth-refresh", serverId: "проверка", key: "mcp.oauth:проверка", accessToken: TOKEN },
    { type: "pong", requestId: "after" },
  ]);
  (sidecar as unknown as { handleRuntimeLine: (line: string) => void }).handleRuntimeLine(line);
  (sidecar as unknown as { flushBatch: () => void }).flushBatch();
  sidecar.stop();

  const serialized = JSON.stringify(emitted);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).toContain('"mcp.oauth.saved"');
  expect(serialized).toContain('"after"');
  expect(getSecret("mcp.oauth:проверка")).toBe(TOKEN);
});