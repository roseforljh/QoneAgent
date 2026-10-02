import { expect, test } from "bun:test";
import { decodeCommand, type AgentEvent } from "@qone/protocol";
import { PiAdapter } from "../src/pi-adapter.js";
import { createAgentSession, estimateTokens, ModelRuntime, SessionManager, defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { contextTokens, subscribeContextUsage } from "../src/context-usage.js";

test("context request selects the current model and returns Pi's active-session usage", async () => {
  expect(decodeCommand(JSON.stringify({ type: "session.context.get", requestId: "request", sessionId: "session", model: "provider/other" }))?.type).toBe("session.context.get");

  const adapter = new PiAdapter(() => {});
  Object.assign(adapter, { modelRuntime: { getModel: (_provider: string, modelId: string) => ({ contextWindow: modelId === "other" ? 256_000 : 1_000_000 }) } });
  const sessions = (adapter as unknown as { sessions: Map<string, unknown> }).sessions;
  sessions.set("session", { getContextUsage: () => ({ tokens: 42_000, contextWindow: 1_000_000 }), messages: [] });

  expect(await adapter.getContextUsage("session", "C:/workspace", "provider/other")).toEqual({ tokens: 42_000, contextWindow: 256_000 });

  sessions.set("session", { getContextUsage: () => ({ tokens: null, contextWindow: 1_000_000 }), messages: [{ role: "user", content: "A short prompt", timestamp: 1 }] });
  const afterCompaction = await adapter.getContextUsage("session", "C:/workspace", "provider/other");
  expect(afterCompaction.contextWindow).toBe(256_000);
  expect(afterCompaction.tokens).toBeGreaterThan(0);
});

test("context includes streaming output before the message is committed", () => {
  const message = fauxAssistantMessage(fauxText("streamed response"));
  const session = {
    getContextUsage: () => ({ tokens: 42_000 }), messages: [],
    agent: { state: { streamingMessage: message } },
  } as unknown as AgentSession;
  expect(contextTokens(session)).toBe(42_000 + estimateTokens(message));
});

test("live context updates during streaming and tool execution before the run ends", async () => {
  const faux = fauxProvider({ provider: "qone-context-test", models: [{ id: "test-model" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxText("checking context while the answer streams "), fauxToolCall("echo", {})]),
    fauxAssistantMessage(fauxText("the tool result is now part of context")),
  ]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const echo = defineTool({
    name: "echo", label: "Echo", description: "echo", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "tool result ".repeat(100) }] }),
  });
  const { session } = await createAgentSession({
    cwd: process.cwd(), sessionManager: SessionManager.inMemory(process.cwd()),
    modelRuntime: runtime, model: faux.getModel(), tools: ["echo"], customTools: [echo],
  });
  let phase = "";
  let ended = false;
  const updates: { phase: string; tokens: number; ended: boolean }[] = [];
  session.subscribe((event) => {
    phase = event.type;
    if (event.type === "agent_end") ended = true;
  });
  const unsubscribe = subscribeContextUsage(session, ({ tokens }) => updates.push({ phase, tokens, ended }));
  try {
    await session.prompt("read my context");
    const streaming = updates.filter((update) => update.phase === "message_update");
    expect(streaming.length).toBeGreaterThan(1);
    expect(streaming.every((update) => !update.ended && update.tokens > 0)).toBe(true);
    expect(updates.some((update) => update.phase === "message_end" && update.tokens >= estimateTokens({ role: "user", content: "tool result ".repeat(100), timestamp: 1 }))).toBe(true);
    expect(updates.at(-1)?.tokens).toBe(contextTokens(session));
  } finally {
    unsubscribe();
    await session.dispose();
  }
});

test("adapter publishes live context for the owning conversation and excludes child context", async () => {
  const faux = fauxProvider({ provider: "qone-context-adapter", models: [{ id: "test-model" }] });
  faux.setResponses([fauxAssistantMessage(fauxText("a streamed answer with context")), fauxAssistantMessage(fauxText("child answer"))]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const events: AgentEvent[] = [];
  const adapter = new PiAdapter((event) => events.push(event));
  const model = "qone-context-adapter/test-model";
  Object.assign(adapter, { modelRuntime: runtime, configuredModelConfigs: [{ id: model, provider: "qone-context-adapter", model: "test-model", config: {} }] });
  try {
    await adapter.run("parent", "answer", { model, cwd: process.cwd(), runId: "parent-run" }, () => {});
    const live = events.filter((event) => event.type === "context.usage");
    expect(live.length).toBeGreaterThan(1);
    expect(live.every((event) => event.sessionId === "parent" && event.runId === "parent-run")).toBe(true);
    expect(live.at(-1)?.payload).toMatchObject({ model, contextWindow: faux.getModel().contextWindow });
    expect(events.findIndex((event) => event.type === "context.usage")).toBeLessThan(events.findIndex((event) => event.type === "turn.completed"));
    events.length = 0;
    await adapter.run("child", "answer", { model, cwd: process.cwd(), runId: "child-run", eventSessionId: "parent" }, () => {});
    expect(events.some((event) => event.type === "context.usage")).toBe(false);
  } finally {
    await adapter.disposeSession("parent");
    await adapter.disposeSession("child");
  }
});

test("compaction replaces the old context baseline before streaming resumes", () => {
  let listener: Parameters<AgentSession["subscribe"]>[0] = () => {};
  let tokens = 42_000;
  const session = {
    getContextUsage: () => ({ tokens }), messages: [], model: { contextWindow: 256_000 },
    subscribe: (callback: typeof listener) => { listener = callback; return () => {}; },
  } as unknown as AgentSession;
  const updates: number[] = [];
  subscribeContextUsage(session, (usage) => updates.push(usage.tokens));
  listener({ type: "agent_start" });
  tokens = 1_000;
  listener({ type: "compaction_end", reason: "manual", result: undefined, aborted: false });
  expect(updates).toEqual([42_000, 1_000]);
});
