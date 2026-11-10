import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpManager, type McpServerConfig } from "../src/index";

const fixture = path.join(import.meta.dir, "fixtures", "stdio-server.ts");
const workDir = mkdtempSync(path.join(os.tmpdir(), "qone-mcp-transport-"));
const logPath = path.join(workDir, "calls.ndjson");
const events = (): { event: string; tool?: string; text?: string }[] => existsSync(logPath)
  ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

const manager = new McpManager();
const config: McpServerConfig = {
  id: "local-fixture",
  name: "Local fixture",
  command: process.execPath,
  args: ["run", fixture],
  env: { QONE_MCP_TEST_LOG: logPath },
};

afterAll(async () => {
  await manager.disconnectAll();
  rmSync(workDir, { recursive: true, force: true });
});

test("connect → listTools → callTool runs over a real stdio transport and keeps structured output", async () => {
  const tools = await manager.connect(config);
  expect(manager.isConnected(config.id)).toBe(true);
  expect(tools.map((tool) => (tool as { qoneToolName?: string }).qoneToolName)).toEqual([
    "mcp:local-fixture:echo",
    "mcp:local-fixture:fail",
    "mcp:local-fixture:slow",
  ]);

  const echo = tools.find((tool) => (tool as { qoneToolName?: string }).qoneToolName === "mcp:local-fixture:echo")!;
  expect(JSON.parse(JSON.stringify(echo.parameters))).toMatchObject({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  });
  expect(JSON.parse(JSON.stringify(echo.outputSchema))).toMatchObject({
    type: "object",
    required: ["text", "length"],
  });

  const result = await echo.execute("call-echo", { text: "hello" }, undefined, undefined, {} as never) as {
    content: { type: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  expect(result.content[0]).toEqual({ type: "text", text: "hello" });
  expect(result.structuredContent).toEqual({ text: "hello", length: 5 });
  expect(result.isError).toBe(false);
  expect(events()).toContainEqual({ event: "call", tool: "echo", text: "hello" });

  const fail = tools.find((tool) => (tool as { qoneToolName?: string }).qoneToolName === "mcp:local-fixture:fail")!;
  const failed = await fail.execute("call-fail", {}, undefined, undefined, {} as never) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  expect(failed.isError).toBe(true);
  expect(failed.content[0]?.text).toContain("deliberate failure");

  // A second connect must reuse the live connection rather than spawn another server.
  expect(await manager.connect(config)).toBe(tools);
}, 30_000);

test("an aborted callTool cancels the in-flight request and the connection stays reusable", async () => {
  const tools = await manager.connect(config);
  const slow = tools.find((tool) => (tool as { qoneToolName?: string }).qoneToolName === "mcp:local-fixture:slow")!;
  const controller = new AbortController();
  const call = slow.execute("call-slow", {}, controller.signal, undefined, {} as never);

  // Cancel only after the server has recorded the request, so the abort races
  // a genuinely in-flight handler rather than a pre-aborted signal.
  const deadline = Date.now() + 10_000;
  while (!events().some((entry) => entry.event === "slow-start") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(events().some((entry) => entry.event === "slow-start")).toBe(true);

  controller.abort();
  const error = await call.then(() => undefined, (reason: Error) => reason);
  expect(error).toBeInstanceOf(Error);

  const echo = tools.find((tool) => (tool as { qoneToolName?: string }).qoneToolName === "mcp:local-fixture:echo")!;
  const after = await echo.execute("call-after", { text: "again" }, undefined, undefined, {} as never) as {
    structuredContent?: unknown;
  };
  expect(after.structuredContent).toEqual({ text: "again", length: 5 });
  // The server observed the cancellation notification, not a broken pipe.
  const cancelledDeadline = Date.now() + 10_000;
  while (!events().some((entry) => entry.event === "slow-cancelled") && Date.now() < cancelledDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(events().some((entry) => entry.event === "slow-cancelled")).toBe(true);
}, 40_000);

test("disconnect closes the transport and a later connect starts a fresh session", async () => {
  await manager.disconnect(config.id);
  expect(manager.isConnected(config.id)).toBe(false);
  const tools = await manager.connect(config);
  expect(tools).toHaveLength(3);
  expect(manager.isConnected(config.id)).toBe(true);
}, 30_000);

test("a connect that finishes after disconnect does not revive the server", async () => {
  await manager.disconnect(config.id);
  const connecting = manager.connect(config);
  // Tear down while the handshake is still running.
  await manager.disconnect(config.id);
  await expect(connecting).rejects.toThrow("disconnected during connect");
  expect(manager.isConnected(config.id)).toBe(false);
}, 30_000);