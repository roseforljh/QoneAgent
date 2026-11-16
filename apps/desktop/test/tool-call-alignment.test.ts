import { expect, test } from "bun:test";
import type { ChatMessage, ToolCall } from "../src/store";
import { alignToolCallIds } from "../src/lib/tool-call-alignment";

const call = (toolCallId: string, runId = "run"): ToolCall => ({ toolCallId, runId, toolName: "read", status: "success" });
const message = (runId: string, ids: string[]): ChatMessage => ({
  id: runId, role: "assistant", content: "", runId,
  parts: ids.map(toolCallId => ({ type: "tool-call", toolCallId, toolName: "read", args: {} })),
});

test("exact tool IDs retain identity and fallback matching stays inside its run", () => {
  const calls = [call("a"), call("b", "other")];
  const messages = [message("run", ["a"]), message("other", ["b"])];
  expect(alignToolCallIds(calls, messages)).toBe(calls);
  expect(alignToolCallIds([call("old"), call("old", "other")], messages).map(item => item.toolCallId)).toEqual(["a", "b"]);
});

test("fallback cursors skip exact matches and repeated IDs without losing the next part", () => {
  const calls = [call("b"), call("old-1"), call("old-2"), call("d"), call("old-3")];
  const aligned = alignToolCallIds(calls, [message("run", ["a", "a", "b", "c", "d", "e"])]);
  expect(aligned.map(item => item.toolCallId)).toEqual(["b", "a", "c", "d", "e"]);
  expect(aligned[0]).toBe(calls[0]);
  expect(aligned[3]).toBe(calls[3]);
});

test("thousands of same-name fallback matches visit parts linearly instead of rescanning used prefixes", () => {
  const count = 5_000;
  let reads = 0;
  const saved = message("run", Array.from({ length: count }, (_, index) => `saved-${index}`));
  saved.parts!.forEach((part, index) => {
    Object.defineProperty(part, "toolCallId", { get() { reads++; return `saved-${index}`; } });
  });
  const aligned = alignToolCallIds(Array.from({ length: count }, (_, index) => call(`legacy-${index}`)), [saved]);
  expect(aligned.map(item => item.toolCallId)).toEqual(Array.from({ length: count }, (_, index) => `saved-${index}`));
  expect(reads).toBeLessThan(count * 12);
});
