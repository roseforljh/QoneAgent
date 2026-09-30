import { expect, test } from "bun:test";
import type { PartState } from "@assistant-ui/react";
import { assistantPartRanges, assistantRangeSections, hasVisibleAnswer, visibleAssistantPartRanges } from "../src/components/assistant-ui/assistant-part-ranges";
import { executionCollapsed } from "../src/components/assistant-ui/execution-disclosure-state";
import { assistantMessageContent } from "../src/lib/assistant-message-parts";
import type { AssistantMessagePart } from "@qone/protocol";

test("reasoning remains visible after reload and never counts as a final answer", () => {
  const parts: AssistantMessagePart[] = [
    { type: "reasoning", text: "分析", messageSequence: 1, contentIndex: 0, complete: true },
    { type: "text", text: "回答", messageSequence: 1 },
  ];
  const live = assistantMessageContent({ content: "", parts }, [], true);
  expect(assistantMessageContent({ content: "回答", parts: JSON.parse(JSON.stringify(parts)) }, [], false)).toEqual(live);
  const ranges = assistantPartRanges(live as PartState[]);
  expect(ranges).toEqual([{ type: "reasoning", index: 0 }, { type: "text", index: 1 }]);
  expect(hasVisibleAnswer(live as PartState[], ranges.slice(0, 1))).toBe(false);
  expect(hasVisibleAnswer(live as PartState[], ranges)).toBe(true);
});

test("reasoning settles at block end before the answer and on interrupted history", () => {
  const part: AssistantMessagePart = { type: "reasoning", text: "分析", messageSequence: 1 };
  expect(assistantMessageContent({ content: "", parts: [part] }, [], true)[0]).toMatchObject({ status: { type: "running" } });
  expect(assistantMessageContent({ content: "", parts: [{ ...part, complete: true }] }, [], true)[0]).toMatchObject({ status: { type: "complete" } });
  expect(assistantMessageContent({ content: "", parts: [part] }, [], false)[0]).toMatchObject({ status: { type: "complete" } });
});

test("reasoning before, between and after tools stays inside the execution disclosure in order", () => {
  const parts: AssistantMessagePart[] = [
    { type: "reasoning", text: "思考", messageSequence: 1, complete: true },
    { type: "tool-call", toolCallId: "a", toolName: "read", args: {}, messageSequence: 1 },
    { type: "reasoning", text: "继续", messageSequence: 2, complete: true },
    { type: "tool-call", toolCallId: "b", toolName: "grep", args: {}, messageSequence: 2 },
    { type: "reasoning", text: "整理", messageSequence: 3, complete: true },
    { type: "text", text: "答案", messageSequence: 3 },
  ];
  const converted = assistantMessageContent({ content: "", parts }, [], false) as PartState[];
  const sections = assistantRangeSections(assistantPartRanges(converted));
  expect(sections.leading).toEqual([]);
  expect(sections.persistent).toEqual([]);
  expect(sections.activity).toEqual([
    { type: "reasoning", index: 0 }, { type: "tools", startIndex: 1, endIndex: 2 },
    { type: "reasoning", index: 2 }, { type: "tools", startIndex: 3, endIndex: 4 },
    { type: "reasoning", index: 4 },
  ]);
  expect(sections.answer).toEqual([{ type: "text", index: 5 }]);
});

test("render input preserves order and groups contiguous tools across model message boundaries", () => {
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
    { type: "tools", startIndex: 4, endIndex: 6 },
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
  expect(assistantPartRanges(content as PartState[])).toEqual([
    { type: "tools", startIndex: 0, endIndex: 1 },
    { type: "tools", startIndex: 2, endIndex: 3 },
  ]);
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

test("each subagent capsule stays at its dispatch call and folds with execution", () => {
  const parts = [
    { type: "text", text: "准备", status: { type: "complete" } },
    { type: "tool-call", toolName: "read", toolCallId: "read", status: { type: "complete" } },
    { type: "tool-call", toolName: "dispatch_subagent", toolCallId: "child-1", status: { type: "complete" } },
    { type: "tool-call", toolName: "dispatch_subagent", toolCallId: "child-2", status: { type: "complete" } },
    { type: "text", text: "结果", status: { type: "complete" } },
    { type: "image", image: "data:image/png;base64,A", status: { type: "complete" } },
  ] as PartState[];
  const ranges = visibleAssistantPartRanges(parts, true, true);
  expect(ranges).toEqual([
    { type: "text", index: 0 },
    { type: "tools", startIndex: 1, endIndex: 2 },
    { type: "subagents", index: 2 },
    { type: "subagents", index: 3 },
    { type: "text", index: 4 },
    { type: "image", index: 5 },
  ]);
  const sections = assistantRangeSections(ranges);
  expect(sections.activity).toEqual(ranges.slice(0, 4));
  expect(sections.answer).toEqual(ranges.slice(4));
});

test("execution folds commentary but keeps presentations, images, and the final answer visible", () => {
  const parts = [
    { type: "text", text: "准备" },
    { type: "tool-call", toolName: "read", toolCallId: "read" },
    { type: "text", text: "阶段结论" },
    { type: "image", image: "data:image/png;base64,A" },
    { type: "tool-call", toolName: "grep", toolCallId: "grep" },
    { type: "text", text: "最终回答" },
  ] as PartState[];
  const sections = assistantRangeSections(assistantPartRanges(parts));
  expect(sections.activity).toEqual([
    { type: "text", index: 0 },
    { type: "tools", startIndex: 1, endIndex: 2 },
    { type: "text", index: 2 },
    { type: "tools", startIndex: 4, endIndex: 5 },
  ]);
  expect(sections.persistent).toEqual([{ type: "image", index: 3 }]);
  expect(sections.answer).toEqual([{ type: "text", index: 5 }]);
  expect(hasVisibleAnswer(parts, sections.answer)).toBe(true);
});

test("execution waits for a visible final answer and respects manual choice and cancellation", () => {
  const parts = [
    { type: "tool-call", toolName: "read", toolCallId: "read" },
    { type: "text", text: " " },
  ] as PartState[];
  const sections = assistantRangeSections(assistantPartRanges(parts));
  expect(hasVisibleAnswer(parts, sections.answer)).toBe(false);
  expect(executionCollapsed(undefined, false, true, false)).toBe(false);
  expect(executionCollapsed(undefined, true, false, false)).toBe(false);
  expect(executionCollapsed(undefined, true, true, true)).toBe(false);
  expect(executionCollapsed(undefined, true, true, false)).toBe(true);
  expect(executionCollapsed(false, true, true, false)).toBe(false);
  expect(executionCollapsed(true, false, false, false)).toBe(true);
});

test("image before activity and a presentation within activity stay outside the disclosure", () => {
  const parts = [
    { type: "image", image: "data:image/png;base64,A" },
    { type: "text", text: "先分析" },
    { type: "tool-call", toolName: "read", toolCallId: "read" },
    { type: "tool-call", toolName: "present", toolCallId: "view" },
    { type: "tool-call", toolName: "grep", toolCallId: "grep" },
    { type: "text", text: "结论" },
  ] as PartState[];
  const sections = assistantRangeSections(assistantPartRanges(parts));
  expect(sections.leading).toEqual([{ type: "image", index: 0 }]);
  expect(sections.persistent).toEqual([{ type: "presentation", index: 3 }]);
  expect(sections.answer).toEqual([{ type: "text", index: 5 }]);
  expect(assistantRangeSections(assistantPartRanges(parts.slice(0, 2))).answer).toHaveLength(2);
});


test("reasoning without tools creates an execution region before the final answer", () => {
  const sections = assistantRangeSections([{ type: "reasoning", index: 0 }, { type: "text", index: 1 }]);
  expect(sections.activity).toEqual([{ type: "reasoning", index: 0 }]);
  expect(sections.answer).toEqual([{ type: "text", index: 1 }]);
  expect(assistantRangeSections([{ type: "text", index: 0 }]).activity).toEqual([]);
});

test("explicit phases keep commentary and pending text in activity until a final answer exists", () => {
  const parts: AssistantMessagePart[] = [
    { type: "text", text: "先查", messageSequence: 1, phase: "commentary" },
    { type: "tool-call", toolCallId: "read", toolName: "read", args: {}, messageSequence: 1 },
  ];
  const pending = assistantMessageContent({ content: "准备继续", parts }, [], true) as PartState[];
  const pendingRanges = assistantPartRanges(pending);
  expect(pendingRanges.at(-1)).toMatchObject({ type: "text", phase: "pending" });
  const active = assistantRangeSections(pendingRanges);
  expect(active.activity).toHaveLength(3);
  expect(active.answer).toEqual([]);

  const final = assistantMessageContent({ content: "", parts: [
    ...parts,
    { type: "text", text: "完成", messageSequence: 2, phase: "final_answer" },
  ] }, [], false) as PartState[];
  const finished = assistantRangeSections(assistantPartRanges(final));
  expect(finished.activity).toHaveLength(2);
  expect(finished.answer).toEqual([{ type: "text", index: 2, phase: "final_answer" }]);
  expect(hasVisibleAnswer(final, finished.answer)).toBe(true);
});

test("a text-only stream is an answer until an activity boundary is known", () => {
  const parts = assistantMessageContent({ content: "直接回答", parts: [] }, [], true) as PartState[];
  expect(assistantRangeSections(assistantPartRanges(parts)).answer).toEqual([{ type: "text", index: 0 }]);
  const legacy = assistantMessageContent({ content: "旧消息" }, [], true) as PartState[];
  expect(assistantRangeSections(assistantPartRanges(legacy)).answer).toEqual([{ type: "text", index: 0 }]);
});

test("exploration tools share a group while edits and commands form a separate group", () => {
  const parts = ["read", "grep", "ls", "edit", "write", "read"].map((toolName, index) => ({
    type: "tool-call" as const, toolName, toolCallId: String(index),
  })) as PartState[];
  expect(assistantPartRanges(parts)).toEqual([
    { type: "tools", startIndex: 0, endIndex: 3 },
    { type: "tools", startIndex: 3, endIndex: 5 },
    { type: "tools", startIndex: 5, endIndex: 6 },
  ]);
});
