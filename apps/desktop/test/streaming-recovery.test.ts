import { afterAll, expect, mock, test } from "bun:test";
import type { RuntimeEvent } from "@qone/protocol";

let listener: ((event: { payload: string }) => void) | undefined;
mock.module("@tauri-apps/api/core", () => ({ invoke: async () => {} }));
mock.module("@tauri-apps/api/event", () => ({
  listen: async (_name: string, callback: typeof listener) => { listener = callback; return () => {}; },
}));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { __TAURI_INTERNALS__: {}, localStorage: { getItem: () => null, setItem: () => {} } },
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const { initBridge, useStore } = await import("../src/store");
initBridge();
await Promise.resolve();

test("restores a live assistant segment from the session snapshot", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({
      currentSessionId: "session-1",
      messages: [{ id: "user-1", role: "user", content: "question", createdAt: 1 }],
      running: false,
      activeRunId: undefined,
      streaming: "",
      streamingParts: [],
      activeMessageSequence: undefined,
      runningSessionIds: [],
      compactions: [],
    });
    const message: RuntimeEvent = {
      type: "session.messages",
      sessionId: "session-1",
      messages: [{ id: "user-1", sessionId: "session-1", role: "user", content: "question", createdAt: 1 }],
      streaming: {
        runId: "run-1",
        content: "partial answer",
        messageSequence: 4,
        sequence: 8,
        parts: [{ type: "text", text: "before tool", messageSequence: 4, phase: "commentary" }],
      },
    };
    listener?.({ payload: JSON.stringify(message) });

    expect(useStore.getState()).toMatchObject({
      running: true,
      activeRunId: "run-1",
      streaming: "partial answer",
      activeMessageSequence: 4,
      streamingParts: [{ type: "text", text: "before tool", messageSequence: 4, phase: "commentary" }],
      runningSessionIds: ["session-1"],
    });
  } finally {
    useStore.setState(previous, true);
  }
});
