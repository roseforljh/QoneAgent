import { expect, test } from "bun:test";
import type { AgentEvent } from "@qone/protocol";
import { updateLiveAssistant, type LiveAssistantState } from "../src/live-assistant";

const base: LiveAssistantState = { content: "", parts: [], sequence: 0 };
const event = (sequence: number, type: string, payload: unknown): AgentEvent => ({
  eventId: String(sequence), sequence, type, timestamp: sequence, runId: "run-1", sessionId: "session-1", payload,
});

test("rebuilds streamed text and tool parts in the same order as the desktop reducer", () => {
  let state = updateLiveAssistant(base, event(1, "message.started", { message: { role: "assistant" } }));
  state = updateLiveAssistant(state, event(2, "message.delta", { delta: "先说" }));
  state = updateLiveAssistant(state, event(3, "message.block.started", { blockType: "tool-call", toolCallId: "call-1", toolName: "read", args: { path: "a.ts" } }));
  state = updateLiveAssistant(state, event(4, "tool.completed", { toolCallId: "call-1", result: "ok" }));
  state = updateLiveAssistant(state, event(5, "message.delta", { delta: "继续输出" }));

  expect(state.content).toBe("继续输出");
  expect(state.parts).toEqual([
    { type: "text", text: "先说", messageSequence: 1, phase: "commentary" },
    { type: "tool-call", toolCallId: "call-1", toolName: "read", args: { path: "a.ts" }, messageSequence: 1, result: "ok", isError: false },
  ]);
  expect(state.sequence).toBe(5);
});

test("replaces the live segment with the completed message parts", () => {
  let state = updateLiveAssistant(base, event(10, "message.started", { message: { role: "assistant" } }));
  state = updateLiveAssistant(state, event(11, "message.delta", { delta: "partial" }));
  state = updateLiveAssistant(state, event(12, "message.completed", {
    message: { role: "assistant", content: [{ type: "text", text: "complete" }], stopReason: "stop" },
  }));

  expect(state.content).toBe("");
  expect(state.messageSequence).toBeUndefined();
  expect(state.parts).toEqual([{ type: "text", text: "complete", messageSequence: 10, phase: "final_answer" }]);
});
