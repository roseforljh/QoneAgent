// Shared harness for the chat store tests. Bun keeps one module-mock registry
// per process, so the bridge mock lives here and both suites import it first.
import { afterAll, mock } from "bun:test";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

export const commands: RuntimeCommand[] = [];
let sendFailure: ((command: RuntimeCommand) => Promise<void>) | undefined;
let onRuntimeEvent: ((event: { payload: string }) => void) | undefined;

const originalBridge = { ...await import("../../src/lib/desktop-bridge") };
mock.module("../../src/lib/desktop-bridge", () => ({
  ...originalBridge,
  isDesktop: () => true,
  invoke: async (command: string, args?: { cmd?: string; key?: string }) => {
    if (command === "runtime_send" && args?.cmd) {
      const parsed = JSON.parse(args.cmd) as RuntimeCommand;
      commands.push(parsed);
      await sendFailure?.(parsed);
    }
    if (command === "secret_get" && args?.key === "mcp.env:mcp-key-restore/TEST_API_KEY") return "restored-test-key";
    return undefined;
  },
  listen: async (_name: string, listener: typeof onRuntimeEvent) => {
    onRuntimeEvent = listener;
    return () => {};
  },
}));

export const storage = new Map<string, string>();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    electronBridge: { invoke: async () => undefined, listen: async () => () => {}, convertFileSrc: (p: string) => p },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  },
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const { initBridge, useStore, requestModelMetadata } = await import("../../src/store");
initBridge();
await Promise.resolve();

export { useStore, requestModelMetadata };
export const emit = (message: RuntimeEvent) => onRuntimeEvent?.({ payload: JSON.stringify(message) });
export const event = (type: string, payload: unknown) => ({
  eventId: crypto.randomUUID(),
  sessionId: "session-1",
  runId: "run-1",
  sequence: 1,
  type,
  timestamp: Date.now(),
  payload,
});
export const setSendFailure = (fn: typeof sendFailure) => { sendFailure = fn; };
/** Both suites share one zustand store, so each file resets it before every test. */
export const resetHarness = () => { commands.length = 0; sendFailure = undefined; };
