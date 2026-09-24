import { expect, test } from "bun:test";
import type { PartState } from "@assistant-ui/react";
import { assistantPartRanges } from "../src/components/assistant-ui/assistant-part-ranges";
import { assistantMessageContent } from "../src/lib/assistant-message-parts";
import type { AssistantMessagePart } from "@qone/protocol";

test("render input preserves Pi text/tool order and splits tool groups at message boundaries", () => {
  const parts: AssistantMessagePart[] = [
    { type: "text", text: "旁白一", messageSequence: 10 },
    { type: "tool-call", toolCallId: "a", toolName: "read", args: {}, messageSequence: 10 },
    { type: "tool-call", toolCallId: "b", toolName: "grep", args: {}, messageSequence: 10 },
    { type: "text", text: "阶段结论", messageSequence: 20 },
    { type: "tool-call", toolCallId: "c", toolName: "ls", args: {}, messageSequence: 20 },
    { type: "tool-call", toolCallId: "d", toolName: "read", args: {}, messageSequence: 30 },
    { type: "text", text: "最终总结", messageSequence: 40 },
  ];
  const live = assistantMessageContent({ content: "", parts }, [], true);
  const reloaded = assistantMessageContent({ content: "最终总结", parts: JSON.parse(JSON.stringify(parts)) }, [], false);
  expect(reloaded).toEqual(live);
  expect(assistantPartRanges(live as PartState[])).toEqual([
    { type: "text", index: 0 },
    { type: "tools", startIndex: 1, endIndex: 3 },
    { type: "text", index: 3 },
    { type: "tools", startIndex: 4, endIndex: 5 },
    { type: "tools", startIndex: 5, endIndex: 6 },
    { type: "text", index: 6 },
  ]);
});

test("legacy final-text messages still render with their saved tool list", () => {
  const content = assistantMessageContent({ content: "旧总结" }, [{
    toolCallId: "old-tool", runId: "old-run", toolName: "read", status: "success", result: "ok",
  }], false);
  expect(content).toMatchObject([
    { type: "tool-call", toolCallId: "old-tool", result: "ok" },
    { type: "text", text: "旧总结" },
  ]);
});

test("a Pi text block separates tool groups even if assistant-ui hides whitespace text", () => {
  const parts: AssistantMessagePart[] = [
    { type: "tool-call", toolCallId: "a", toolName: "read", args: {}, messageSequence: 10 },
    { type: "text", text: " ", messageSequence: 10 },
    { type: "tool-call", toolCallId: "b", toolName: "grep", args: {}, messageSequence: 10 },
  ];
  const content = assistantMessageContent({ content: "", parts }, [], false);
  const visible = content.filter((part) => part.type !== "text" || part.text.trim());
  expect(assistantPartRanges(visible as PartState[])).toEqual([
    { type: "tools", startIndex: 0, endIndex: 1 },
    { type: "tools", startIndex: 1, endIndex: 2 },
  ]);
});
