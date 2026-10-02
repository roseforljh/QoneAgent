import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeEvent } from "@qone/protocol";

let onRuntimeEvent: ((event: { payload: string }) => void) | undefined;
const originalTauriCore = { ...await import("@tauri-apps/api/core") };
mock.module("@tauri-apps/api/core", () => ({ ...originalTauriCore, invoke: async () => {} }));
mock.module("@tauri-apps/api/event", () => ({
  listen: async (_name: string, listener: typeof onRuntimeEvent) => { onRuntimeEvent = listener; return () => {}; },
}));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { __TAURI_INTERNALS__: {}, localStorage: { getItem: () => null, setItem: () => {} } },
});
const { initBridge, useStore } = await import("../src/store");
const { ComposerContext } = await import("../src/components/assistant-ui/elements/composer");
const { AssistantContext } = await import("../src/components/assistant-ui/assistant-context");
const { createConversationStore } = await import("../src/lib/conversation-store");
initBridge();
await Promise.resolve();
const originalState = useStore.getState();
const serverState = useStore.getInitialState();
const originalServerState = { ...serverState };
afterEach(() => {
  useStore.setState(originalState, true);
  Object.assign(serverState, originalServerState);
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
const usage = { sessionId: "chat", model: "provider/model", tokens: 42_000, contextWindow: 256_000 };
const emit = (message: RuntimeEvent) => onRuntimeEvent?.({ payload: JSON.stringify(message) });
const push = (tokens: number, sessionId = "chat", model = "provider/model", runId = "run") => emit({
  type: "agent.event", event: {
    eventId: crypto.randomUUID(), sequence: 1, timestamp: Date.now(), sessionId, runId,
    type: "context.usage", payload: { model, tokens, contextWindow: 256_000 },
  },
});

test("context hides without usable data and appears during an active run", () => {
  for (const value of [undefined, { used: 0, total: 256_000 }, { used: 1, total: 0 }, { used: NaN, total: 256_000 }]) {
    expect(renderToStaticMarkup(<ComposerContext usage={value} />)).toBe("");
  }
  Object.assign(serverState, { currentSessionId: "chat", selectedModelId: "provider/model", running: true, contextUsage: undefined });
  expect(renderToStaticMarkup(<AssistantContext />)).toBe("");
  serverState.contextUsage = usage;
  expect(renderToStaticMarkup(<AssistantContext />)).toContain('data-slot="composer-context"');
  serverState.contextUsage = { ...usage, sessionId: "other-chat" };
  expect(renderToStaticMarkup(<AssistantContext />)).toBe("");
  serverState.contextUsage = { ...usage, model: "other/model" };
  expect(renderToStaticMarkup(<AssistantContext />)).toBe("");
});

test("live usage replaces the snapshot while running and rejects late replies and other runs/models", () => {
  useStore.setState({ connected: true, currentSessionId: "chat", selectedModelId: usage.model, running: true, activeRunId: "run", contextUsage: usage });
  useStore.getState().refreshContextUsage();
  const requestId = useStore.getState().contextUsageRequestId!;
  expect(requestId).toBeTruthy();
  expect(useStore.getState().contextUsage).toEqual(usage);
  push(43_000);
  expect(useStore.getState().running).toBe(true);
  expect(useStore.getState().contextUsage?.tokens).toBe(43_000);
  emit({ type: "session.context", requestId, ...usage });
  expect(useStore.getState().contextUsage?.tokens).toBe(43_000);
  push(1, "chat", "other/model");
  push(2, "chat", usage.model, "old-run");
  expect(useStore.getState().contextUsage?.tokens).toBe(43_000);
  useStore.getState().refreshContextUsage();
  emit({ type: "error", requestId: useStore.getState().contextUsageRequestId!, message: "context temporarily unavailable" });
  expect(useStore.getState().contextUsage?.tokens).toBe(43_000);
});

test("background conversation receives its own live usage without changing the selected chat", () => {
  useStore.setState({
    currentSessionId: "foreground", selectedModelId: usage.model, contextUsage: undefined,
    runOptionsBySession: { chat: { modelId: usage.model } }, backgroundSessions: {},
  });
  const background = createConversationStore(useStore, "chat");
  background.setState({ activeRunId: "run", running: true });
  push(45_000);
  expect(background.getState().contextUsage?.tokens).toBe(45_000);
  expect(useStore.getState().currentSessionId).toBe("foreground");
  expect(useStore.getState().contextUsage).toBeUndefined();
});
