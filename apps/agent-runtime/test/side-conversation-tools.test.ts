import { expect, test } from "bun:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { PiAdapter } from "../src/pi-adapter";

test("a side conversation receives its own system boundary and no subagent tools, while parent tools remain available", async () => {
  const adapter = new PiAdapter(() => {});
  const faux = fauxProvider({ provider: "qone-side-tools", models: [{ id: "test-model" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  Object.assign(adapter, { modelRuntime: runtime });
  adapter.setSideConversationResolver((id) => id === "side");
  adapter.setSubagentDispatcher(async () => "delegated", {} as Parameters<PiAdapter["setSubagentDispatcher"]>[1]);
  const internal = adapter as unknown as { getSession: (id: string, cwd: string, model: string) => Promise<AgentSession> };
  try {
    const parent = await internal.getSession("parent", process.cwd(), "qone-side-tools/test-model");
    const side = await internal.getSession("side", process.cwd(), "qone-side-tools/test-model");
    expect(parent.getActiveToolNames().some((name) => name.includes("subagent"))).toBe(true);
    expect(side.getActiveToolNames().some((name) => name.includes("subagent"))).toBe(false);
    expect(side.getActiveToolNames()).toContain("read");
    expect(side.systemPrompt).toContain("Only messages after the boundary are active user instructions");
    expect(side.systemPrompt).toContain("Sub-agents are off-limits");
    expect(parent.systemPrompt).not.toContain("Sub-agents are off-limits");
    expect(side).not.toBe(parent);
  } finally {
    await adapter.disposeSession("side");
    await adapter.disposeSession("parent");
  }
});
