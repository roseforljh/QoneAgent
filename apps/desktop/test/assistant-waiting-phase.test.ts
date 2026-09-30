import { expect, test } from "bun:test";
import { assistantWaitingPhase } from "../src/components/assistant-ui/assistant-waiting-phase";
import type { AssistantMessagePart } from "@qone/protocol";

const tool: AssistantMessagePart = { type: "tool-call", toolCallId: "read-1", toolName: "read", args: { path: "file.ts" }, messageSequence: 1 };
const base = { messageRunning: true, compacting: false, hasCurrentText: false, hasReasoning: false, requestStartedAt: undefined };

test("automatic compaction owns the waiting indicator until it finishes", () => {
  const calls = new Map([["read-1", { status: "success" as const }]]);
  expect(assistantWaitingPhase({ ...base, compacting: true, parts: [tool], toolCallsById: calls })).toBeUndefined();
  expect(assistantWaitingPhase({ ...base, compacting: false, parts: [tool], toolCallsById: calls })).toBe("thinking");
});

test("the model keeps a thinking shimmer after the last tool has completed", () => {
  expect(assistantWaitingPhase({ ...base, parts: [tool], toolCallsById: new Map([["read-1", { status: "success" }]]) })).toBe("thinking");
  expect(assistantWaitingPhase({ ...base, parts: [{ ...tool, result: "file contents" }], toolCallsById: new Map() })).toBe("thinking");
});

test("running or pending tools do not show a second waiting indicator", () => {
  expect(assistantWaitingPhase({ ...base, parts: [tool], toolCallsById: new Map([["read-1", { status: "running" }]]) })).toBeUndefined();
  expect(assistantWaitingPhase({ ...base, parts: [tool], toolCallsById: new Map() })).toBeUndefined();
});

test("an earlier unfinished tool still blocks the waiting indicator", () => {
  const later: AssistantMessagePart = { ...tool, toolCallId: "read-2", result: "done" };
  expect(assistantWaitingPhase({ ...base, parts: [tool, later], toolCallsById: new Map([["read-1", { status: "running" }], ["read-2", { status: "success" }]]) })).toBeUndefined();
});

test("text, reasoning and a completed run stop the thinking fallback", () => {
  const calls = new Map([["read-1", { status: "success" as const }]]);
  expect(assistantWaitingPhase({ ...base, hasCurrentText: true, parts: [tool], toolCallsById: calls })).toBeUndefined();
  expect(assistantWaitingPhase({ ...base, hasReasoning: true, parts: [tool], toolCallsById: calls })).toBeUndefined();
  expect(assistantWaitingPhase({ ...base, messageRunning: false, parts: [tool], toolCallsById: calls })).toBeUndefined();
  expect(assistantWaitingPhase({ ...base, parts: [], toolCallsById: new Map() })).toBe("preparing");
  expect(assistantWaitingPhase({ ...base, requestStartedAt: 1, parts: [], toolCallsById: new Map() })).toBe("waiting");
});
