import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager, createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

describe("Pi model contract", () => {
  test("streams assistant text and executes a tool with a fake provider", async () => {
    const faux = fauxProvider({ provider: "qone-test", models: [{ id: "test-model" }] });
    faux.setResponses([
      fauxAssistantMessage([fauxText("before "), fauxToolCall("echo", { value: "ok" })]),
      fauxAssistantMessage(fauxText("after")),
    ]);
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    let called = false;
    const echo = defineTool({
      name: "echo",
      label: "Echo",
      description: "echo",
      parameters: Type.Object({ value: Type.String() }),
      execute: async () => { called = true; return { content: [{ type: "text", text: "ok" }] }; },
    });
    const { session } = await createAgentSession({
      cwd: process.cwd(), sessionManager: SessionManager.inMemory(process.cwd()),
      modelRuntime: runtime, model: faux.getModel(), tools: ["echo"], customTools: [echo],
    });
    const events: string[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event.type));
    try {
      await session.prompt("run echo");
      expect(called).toBe(true);
      expect(events).toContain("tool_execution_start");
      expect(events).toContain("message_end");
    } finally {
      unsubscribe();
      await session.dispose();
    }
  });

  test("abort settles without leaving a live session", { timeout: 10000 }, async () => {
    const faux = fauxProvider({ provider: "qone-abort", models: [{ id: "test-model" }], tokensPerSecond: 1 });
    faux.setResponses([fauxAssistantMessage(fauxText("a long response that is intentionally streamed slowly"))]);
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({ cwd: process.cwd(), sessionManager: SessionManager.inMemory(process.cwd()), modelRuntime: runtime, model: faux.getModel() });
    try {
      const pending = session.prompt("cancel");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await session.abort();
      await pending;
      expect(session.isStreaming).toBe(false);
    } finally {
      await session.dispose();
    }
  });
});
