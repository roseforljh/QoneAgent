import { afterAll, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { McpManager, type McpServerConfig } from "../src/index";
import { ToolClocks } from "../src/tool-clock";

const caller = new AsyncLocalStorage<string>();
const asked: { serverId: string; message: string; caller?: string }[] = [];
const manager = new McpManager(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
  callerContext: () => caller.getStore(),
  onElicitation: async (config, params, _signal, from) => {
    asked.push({ serverId: config.id, message: params.message, caller: from });
    await Bun.sleep(20);
    return { action: "accept", content: { name: "Ada" } };
  },
});
const config: McpServerConfig = {
  id: "elicitation-fixture", name: "Elicitation fixture",
  command: process.execPath, args: ["run", path.join(import.meta.dir, "fixtures", "elicitation-server.ts")],
};

afterAll(() => manager.disconnectAll());

test("a server's elicitation during a tool call reaches the host and the answer returns to the tool", async () => {
  const tools = await manager.connect(config);
  const ask = tools.find((tool) => (tool as { qoneToolName?: string }).qoneToolName === "mcp:elicitation-fixture:ask_name")!;
  const result = await caller.run("session-1", () => ask.execute("call-ask", {}, undefined, undefined, {} as never)) as { content: { text?: string }[] };
  // The question is tagged with the conversation whose tool call is waiting.
  expect(asked).toEqual([{ serverId: config.id, message: "Which name should be used?", caller: "session-1" }]);
  expect(JSON.parse(result.content[0]!.text!)).toEqual({ action: "accept", content: { name: "Ada" } });
});

test("tool timeouts stop while the person answers and restart in full afterwards", async () => {
  const clocks = new ToolClocks(40);
  let timedOut = false;
  const stop = clocks.track("server", () => { timedOut = true; });
  await clocks.whileWaiting("server", () => Bun.sleep(80));
  expect(timedOut).toBe(false);
  await Bun.sleep(20);
  expect(timedOut).toBe(false);
  await Bun.sleep(40);
  expect(timedOut).toBe(true);
  stop();
  // Other servers keep counting while one waits.
  let other = false;
  const stopOther = clocks.track("other", () => { other = true; });
  await clocks.whileWaiting("server", () => Bun.sleep(60));
  expect(other).toBe(true);
  stopOther();
});
