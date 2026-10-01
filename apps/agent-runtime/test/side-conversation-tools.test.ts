import { expect, mock, test } from "bun:test";

const created: { tools: string[]; resourceLoader: { instructions?: string } }[] = [];
const tool = (name: string) => ({ name, label: name, description: name, parameters: {}, execute: async () => ({ content: [], details: {} }) });
mock.module("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: async (options: typeof created[number]) => {
    created.push(options);
    return { session: { getActiveToolNames: () => options.tools, subscribe: () => () => {}, dispose: async () => {} } };
  },
  createReadTool: () => tool("read"), createPowerShellTool: () => tool("powershell"),
  createGrepTool: () => tool("grep"), createFindTool: () => tool("find"), createLsTool: () => tool("ls"),
  createEditTool: () => tool("edit"), createWriteTool: () => tool("write"),
  SessionManager: { inMemory: () => ({}) }, SettingsManager: { inMemory: () => ({ applyOverrides: () => {} }) },
  ModelRuntime: {}, estimateTokens: () => 0,
}));
mock.module("../src/skills", () => ({ createResourceLoader: async (_cwd: string, instructions?: string) => ({ loader: { instructions }, skills: [] }) }));
const { PiAdapter } = await import("../src/pi-adapter");

test("a side conversation receives its own system boundary and no subagent tools, while parent tools remain available", async () => {
  const adapter = new PiAdapter(() => {});
  adapter.setSideConversationResolver((id) => id === "side");
  adapter.setSubagentDispatcher(async () => "delegated", {} as Parameters<PiAdapter["setSubagentDispatcher"]>[1]);
  const internal = adapter as unknown as { getSession: (id: string, cwd: string) => Promise<unknown> };
  await internal.getSession("parent", "C:\\repo");
  await internal.getSession("side", "C:\\repo");
  expect(created[0]?.tools.some((name) => name.includes("subagent"))).toBe(true);
  expect(created[1]?.tools.some((name) => name.includes("subagent"))).toBe(false);
  expect(created[1]?.tools).toContain("read");
  expect(created[1]?.resourceLoader.instructions).toContain("Only messages after the boundary are active user instructions");
  expect(created[1]?.resourceLoader.instructions).toContain("Sub-agents are off-limits");
  expect(created[0]?.resourceLoader.instructions).toBeUndefined();
  expect(created[1]?.resourceLoader).not.toBe(created[0]?.resourceLoader);
});
