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

test("token events persist under the protocol key and forward a redacted acknowledgement", async () => {
  const forwarded = await persistRuntimeSecret({ type: "mcp.oauth.token", requestId: "oauth-callback", serverId: "mcp-github", key: "mcp.oauth:mcp-github", accessToken: TOKEN });
  expect(forwarded).toEqual({ type: "mcp.oauth.saved", serverId: "mcp-github", key: "mcp.oauth:mcp-github" });
  expect(await getSecret("mcp.oauth:mcp-github")).toBe(TOKEN);

  await persistRuntimeSecret({ type: "mcp.oauth.credential", serverId: "mcp-github", key: "mcp.oauth:mcp-github.client", value: CREDENTIAL });
  expect(await getSecret("mcp.oauth:mcp-github.client")).toBe(CREDENTIAL);
});

test("invalidated events delete the named key only", async () => {
  await persistRuntimeSecret({ type: "mcp.oauth.invalidated", serverId: "mcp-github", key: "mcp.oauth:mcp-github" });
  expect(await getSecret("mcp.oauth:mcp-github")).toBeNull();
  expect(await getSecret("mcp.oauth:mcp-github.client")).toBe(CREDENTIAL);
});

test("sync credentials are atomically encrypted, acknowledged, and never forwarded in NDJSON", async () => {
  const emitted: unknown[] = [];
  const commands: unknown[] = [];
  const sidecar = new SidecarManager(() => ({ isDestroyed: () => false, webContents: { send: (_: string, payload: unknown) => emitted.push(payload) } }) as never);
  sidecar.send = async command => { commands.push(JSON.parse(command)); };
  const internals = sidecar as unknown as { handleRuntimeLine(line: string): Promise<void>; flushBatch(): void };
  await internals.handleRuntimeLine(JSON.stringify([{ type: "claude-code.credentials", requestId: "sync-storage", serverId: "import", values: { "mcp.env:import/header": TOKEN }, removeKeys: [] }, { type: "pong", requestId: "after-sync" }]));
  internals.flushBatch();
  expect(commands).toEqual([{ type: "claude-code.credentials.saved", requestId: "sync-storage", saved: true }]);
  expect(await getSecret("mcp.env:import/header")).toBe(TOKEN);
  expect(JSON.stringify(emitted)).not.toContain(TOKEN);
  expect(JSON.stringify(emitted)).not.toContain('"claude-code.credentials"');
  expect(JSON.stringify(emitted)).toContain('"mcp.oauth.saved"');
  expect(fs.readFileSync(path.join(dataDir, "auth", "secrets.enc.json"), "utf8")).not.toContain(TOKEN);
  await internals.handleRuntimeLine(JSON.stringify({ type: "claude-code.credentials", requestId: "bad-storage", serverId: "import", values: { "invalid:key:bad": TOKEN }, removeKeys: ["mcp.env:import/header"] }));
  expect(commands.at(-1)).toEqual({ type: "claude-code.credentials.saved", requestId: "bad-storage", saved: false });
  expect(await getSecret("mcp.env:import/header")).toBe(TOKEN);
  sidecar.stop();
});

test("corrupt existing secret storage is reported instead of being overwritten", async () => {
  const file = path.join(dataDir, "auth", "secrets.enc.json");
  const original = fs.readFileSync(file, "utf8");
  const damaged = '{"broken":"keep-user-data"';
  const acknowledgements: boolean[] = [];
  try {
    fs.writeFileSync(file, damaged);
    const forwarded = await persistRuntimeSecret({ type: "claude-code.credentials", requestId: "corrupt", serverId: "import", values: { "mcp.env:import/key": TOKEN }, removeKeys: [] }, (_id, saved) => acknowledgements.push(saved));
    expect(forwarded).toBeNull(); expect(acknowledgements).toEqual([false]);
    expect(fs.readFileSync(file, "utf8")).toBe(damaged);
  } finally { fs.writeFileSync(file, original); }
});

test("events without a credential are forwarded untouched", async () => {
  const event = { type: "pong", requestId: "p" };
  expect(await persistRuntimeSecret(event)).toBe(event);
  expect(await persistRuntimeSecret({ type: "mcp.oauth.token", serverId: "s", key: "mcp.oauth:s" })).toBeNull();
});

test("batched NDJSON arrays are intercepted per event and leak no credential to the renderer", async () => {
  const emitted: unknown[] = [];
  const window = { isDestroyed: () => false, webContents: { send: (_channel: string, payload: unknown) => emitted.push(payload) } };
  const sidecar = new SidecarManager(() => window as never);
  const line = JSON.stringify([
    { type: "agent.event", event: { type: "agent.completed" } },
    { type: "mcp.oauth.token", requestId: "oauth-refresh", serverId: "проверка", key: "mcp.oauth:проверка", accessToken: TOKEN },
    { type: "pong", requestId: "after" },
  ]);
  await (sidecar as unknown as { handleRuntimeLine: (line: string) => Promise<void> }).handleRuntimeLine(line);
  (sidecar as unknown as { flushBatch: () => void }).flushBatch();
  sidecar.stop();

  const serialized = JSON.stringify(emitted);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).toContain('"mcp.oauth.saved"');
  expect(serialized).toContain('"after"');
  expect(await getSecret("mcp.oauth:проверка")).toBe(TOKEN);
});
test("native restore replies once per batch, omits missing keys and never reaches the renderer", async () => {
  const emitted: unknown[] = [], commands: unknown[] = [];
  const sidecar = new SidecarManager(() => ({ isDestroyed: () => false, webContents: { send: (_: string, payload: unknown) => emitted.push(payload) } }) as never);
  sidecar.send = async command => { commands.push(JSON.parse(command)); };
  const internals = sidecar as unknown as { handleRuntimeLine(line: string): Promise<void>; flushBatch(): void };
  await internals.handleRuntimeLine(JSON.stringify([
    { type: "mcp.credentials.request", requestId: "restore", serverId: "import", keys: ["mcp.env:import/header", "mcp.oauth:mcp-github.client", "mcp.env:missing/key"] },
    { type: "pong", requestId: "visible" },
  ]));
  internals.flushBatch();
  expect(commands).toEqual([{ type: "mcp.credentials.restored", requestId: "restore", ok: true, values: { "mcp.env:import/header": TOKEN, "mcp.oauth:mcp-github.client": CREDENTIAL } }]);
  expect(JSON.stringify(emitted)).toContain("visible");
  expect(JSON.stringify(emitted)).not.toContain(TOKEN);
  expect(JSON.stringify(emitted)).not.toContain(CREDENTIAL);
  expect(JSON.stringify(emitted)).not.toContain("mcp.credentials");
  sidecar.stop();
});

test("native restore distinguishes missing secrets from corrupt storage and safeStorage unavailability", async () => {
  const file = path.join(dataDir, "auth", "secrets.enc.json");
  const original = fs.readFileSync(file, "utf8");
  const emitted: unknown[] = [], commands: any[] = [];
  const sidecar = new SidecarManager(() => ({ isDestroyed: () => false, webContents: { send: (_: string, payload: unknown) => emitted.push(payload) } }) as never);
  sidecar.send = async command => { commands.push(JSON.parse(command)); };
  const internals = sidecar as unknown as { handleRuntimeLine(line: string): Promise<void>; flushBatch(): void };
  const restore = () => internals.handleRuntimeLine(JSON.stringify({ type: "mcp.credentials.request", requestId: "retry", serverId: "s", keys: ["mcp.oauth:s.tokens"] }));
  try {
    for (const damaged of ['{"bad":', JSON.stringify({ "mcp.oauth:s.tokens": { data: "encrypted", isSafeStorage: true } }), JSON.stringify({ "mcp.oauth:s.tokens": { data: "invalid", isSafeStorage: false } })]) {
      fs.writeFileSync(file, damaged); await restore();
      expect(commands.at(-1)).toEqual({ type: "mcp.credentials.restored", requestId: "retry", ok: false, values: {} });
      expect(fs.readFileSync(file, "utf8")).toBe(damaged);
    }
    fs.writeFileSync(file, original); await restore();
    expect(commands.at(-1)).toEqual({ type: "mcp.credentials.restored", requestId: "retry", ok: true, values: {} });
    internals.flushBatch(); expect(emitted).toEqual([]);
  } finally { fs.writeFileSync(file, original); sidecar.stop(); }
});

test("safeStorage path re-encrypts rotated keys and keeps set/delete in call order", async () => {
  const { safeStorage } = await import("electron") as unknown as { safeStorage: Record<string, unknown> };
  const { setSecret, deleteSecret } = await import("../electron/secret-store");
  const original = { ...safeStorage };
  let version = "v1";
  Object.assign(safeStorage, {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text: string) => Buffer.from(`${version}:${text}`),
    decryptStringAsync: async (data: Buffer) => { const [v, text] = data.toString().split(/:(.*)/s); return { result: text, shouldReEncrypt: v !== version }; },
  });
  const file = path.join(dataDir, "auth", "secrets.enc.json");
  const stored = () => Buffer.from(JSON.parse(fs.readFileSync(file, "utf8"))["mcp.env:rot/key"].data, "base64").toString();
  try {
    await setSecret("mcp.env:rot/key", TOKEN);
    version = "v2";
    expect(await getSecret("mcp.env:rot/key")).toBe(TOKEN);
    expect(stored()).toBe(`v2:${TOKEN}`);
    void setSecret("mcp.env:race/key", TOKEN);
    await deleteSecret("mcp.env:race/key");
    expect(await getSecret("mcp.env:race/key")).toBeNull();
  } finally { for (const key of Object.keys(safeStorage)) delete safeStorage[key]; Object.assign(safeStorage, original); }
});
