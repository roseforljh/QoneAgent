import { expect, test } from "bun:test";
import { decodeCommand } from "@qone/protocol";
import { PiAdapter } from "../src/pi-adapter.js";

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
