import { expect, test } from "bun:test";
import type { PartState } from "@assistant-ui/react";
import { assistantPartRanges, visibleAssistantPartRanges } from "../src/components/assistant-ui/assistant-part-ranges";
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

test("adjacent image parts form one gallery range while separated images stay independent", () => {
  const parts = [
    { type: "image" as const, image: "data:image/png;base64,A", messageSequence: 1 },
    { type: "image" as const, image: "data:image/png;base64,B", messageSequence: 1 },
    { type: "text" as const, text: "说明", messageSequence: 1 },
    { type: "image" as const, image: "data:image/png;base64,C", messageSequence: 1 },
  ];
  expect(assistantPartRanges(parts as PartState[])).toEqual([
    { type: "images", startIndex: 0, endIndex: 2 },
    { type: "text", index: 2 },
    { type: "image", index: 3 },
  ]);
});

test("subagent capsule stays at the first dispatch call, before later text and images", () => {
  const parts = [
    { type: "text", text: "准备", status: { type: "complete" } },
    { type: "tool-call", toolName: "read", toolCallId: "read", status: { type: "complete" } },
    { type: "tool-call", toolName: "dispatch_subagent", toolCallId: "child-1", status: { type: "complete" } },
    { type: "tool-call", toolName: "dispatch_subagent", toolCallId: "child-2", status: { type: "complete" } },
    { type: "text", text: "结果", status: { type: "complete" } },
    { type: "image", image: "data:image/png;base64,A", status: { type: "complete" } },
  ] as PartState[];
  expect(visibleAssistantPartRanges(parts, true, true)).toEqual([
    { type: "text", index: 0 },
    { type: "tools", startIndex: 1, endIndex: 2 },
    { type: "subagents", index: 2 },
    { type: "text", index: 4 },
    { type: "image", index: 5 },
  ]);
});
