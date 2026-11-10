import { expect, test } from "bun:test";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { PiAdapter } from "../src/pi-adapter";

const probe = (name: string): ToolDefinition => ({
  name, label: name, description: "Lifecycle probe", parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
});

test("Pi custom turns, MCP tool reloads and model switches retain Qone prompt and restored history", async () => {
  const faux = fauxProvider({ provider: "qone-lifecycle", models: [{ id: "first", reasoning: true }, { id: "second", reasoning: true }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const requests: { names: string[]; messages: string }[] = [];
  faux.setResponses(Array.from({ length: 4 }, () => (context) => {
    const messages = JSON.stringify(context.messages);
    expect(messages).toContain("Keep long-running tests and builds streaming");
    expect(messages).toContain("RESTORED_USER_CONTEXT");
    requests.push({ names: getCurrentTools(context.messages).map((tool) => tool.name), messages });
    return fauxAssistantMessage(fauxText("ok"));
  }));
  const adapter = new PiAdapter(() => {}, {}, undefined, () => [
    { id: "old-user", role: "user", content: "RESTORED_USER_CONTEXT", createdAt: 1 },
    { id: "old-answer", role: "assistant", content: "Restored answer", createdAt: 2 },
  ]);
  Object.assign(adapter, { modelRuntime: runtime });
  const options = { cwd: process.cwd(), model: "qone-lifecycle/first", permissionMode: "full" as const, thinking: "high" as const };
  try {
    await adapter.setCustomTools([probe("mcp_lifecycle_old")]);
    await adapter.run("lifecycle", "first request", options, () => {});
    const first = adapter.getSessions()[0]!;
    await first.sendCustomMessage({ customType: "compatibility", content: "CUSTOM_TURN_CONTEXT", display: false }, { triggerTurn: true });
    expect(requests[1]!.messages).toContain("CUSTOM_TURN_CONTEXT");
    await adapter.setCustomTools([probe("mcp_lifecycle_new")]);
    await adapter.run("lifecycle", "after MCP reload", options, () => {});
    const rebuilt = adapter.getSessions()[0]!;
    expect(rebuilt).not.toBe(first);
    await adapter.run("lifecycle", "after model switch", { ...options, model: "qone-lifecycle/second" }, () => {});
    const switched = adapter.getSessions()[0]!;
    expect(switched).not.toBe(rebuilt);
    expect(switched.model?.id).toBe("second");
    expect(switched.thinkingLevel).toBe("high");
    expect(requests).toHaveLength(4);
    for (const request of requests.slice(0, 2)) expect(request.names).toContain("mcp_lifecycle_old");
    for (const request of requests.slice(2)) {
      expect(request.names).toContain("mcp_lifecycle_new");
      expect(request.names).not.toContain("mcp_lifecycle_old");
      expect(request.names).toContain("codemode");
    }
  } finally {
    await adapter.disposeSession("lifecycle");
  }
});

test("concurrent codemode calls finish with distinct nested results", async () => {
  const faux = fauxProvider({ provider: "qone-codemode-queue", models: [{ id: "test" }] });
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("codemode", { code: 'return { marker: "first", value: await tools.qone_queue_probe({}) };' }),
      fauxToolCall("codemode", { code: 'return { marker: "second", value: await tools.qone_queue_probe({}) };' }),
    ]),
    (context) => {
      const results = context.messages.filter((message) => message.role === "toolResult" && message.toolName === "codemode");
      expect(results).toHaveLength(2);
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(JSON.stringify(results[0])).toContain("first");
      expect(JSON.stringify(results[1])).toContain("second");
      return fauxAssistantMessage(fauxText("done"));
    },
  ]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const adapter = new PiAdapter(() => {});
  Object.assign(adapter, { modelRuntime: runtime });
  await adapter.setCustomTools([probe("qone_queue_probe")]);
  try {
    await adapter.run("codemode-queue", "run both", { cwd: process.cwd(), model: "qone-codemode-queue/test", permissionMode: "full" }, () => {});
  } finally {
    await adapter.disposeSession("codemode-queue");
  }
}, 15_000);
