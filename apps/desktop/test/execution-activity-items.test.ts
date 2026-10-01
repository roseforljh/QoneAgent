import { expect, test } from "bun:test";
import type { PartState } from "@assistant-ui/react";
import { assistantPartRanges } from "../src/components/assistant-ui/assistant-part-ranges";
import { positionedAssistantRanges } from "../src/components/assistant-ui/compaction-ranges";
import { executionActivityItems } from "../src/components/assistant-ui/execution-activity-items";
import { assistantMessageContent } from "../src/lib/assistant-message-parts";
import { ACTIVITY_TITLE_TOOL, type AssistantMessagePart } from "@qone/protocol";

const read = (id: string): PartState => ({ type: "tool-call", toolCallId: id, toolName: "read", args: { path: `${id}.ts` }, result: "done" }) as PartState;
const reasoning = (text = "Continue"): PartState => ({ type: "reasoning", text, status: { type: "complete" } }) as PartState;
const stage = (id: string, title: string): PartState => ({ type: "tool-call", toolCallId: id, toolName: ACTIVITY_TITLE_TOOL, args: { title }, result: { title } }) as PartState;

test("authored purposes delimit stages even with one tool and include preceding planning", () => {
  const parts = [reasoning(), stage("inspect", "Investigate lifecycle transitions"), read("source"), stage("verify", "Verify lifecycle cleanup"), read("tests")];
  const groups = executionActivityItems(assistantPartRanges(parts), parts);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatchObject({ kind: "tools", startIndex: 0, endIndex: 3, title: "Investigate lifecycle transitions" });
  expect(groups[1]).toMatchObject({ kind: "tools", startIndex: 3, endIndex: 5, title: "Verify lifecycle cleanup" });
});

test("failed work and compaction retain their actual positions within an authored stage", () => {
  const parts = [stage("inspect", "Investigate lifecycle transitions"), read("source"), { ...read("failed"), isError: true }, read("retry")] as PartState[];
  const ranges = positionedAssistantRanges(assistantPartRanges(parts), [{ id: "compact", partIndex: 3, startedAt: 1, status: "completed", source: "automatic" }]);
  const groups = executionActivityItems(ranges, parts);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ kind: "tools", title: "Investigate lifecycle transitions" });
  expect(groups[0]?.kind === "tools" && groups[0].ranges.map((range) => range.type)).toEqual(["tools", "compaction", "tools"]);
});

test("invalid metadata does not replace a heading and live arguments replace partial captions", () => {
  const parts = [stage("inspect", "Inspect"), read("source"), stage("empty", " "), read("next")];
  const calls = new Map([["inspect", { status: "success" as const, args: { title: "Investigate lifecycle transitions" } }]]);
  expect(executionActivityItems(assistantPartRanges(parts), parts, calls)).toHaveLength(1);
  expect(executionActivityItems(assistantPartRanges(parts), parts, calls)[0]).toMatchObject({ title: "Investigate lifecycle transitions" });
});

test("authored titles survive conversion from persisted message parts without live calls", () => {
  const source: AssistantMessagePart[] = [
    { type: "tool-call", toolName: ACTIVITY_TITLE_TOOL, toolCallId: "inspect", args: { title: "Investigate lifecycle transitions" }, result: "recorded", messageSequence: 1 },
    { type: "tool-call", toolName: "read", toolCallId: "a", args: { path: "a.ts" }, result: "done", messageSequence: 2 },
  ];
  const live = assistantMessageContent({ content: "", parts: source }, [], true) as PartState[];
  const history = assistantMessageContent({ content: "", parts: JSON.parse(JSON.stringify(source)) }, [], false) as PartState[];
  const groups = executionActivityItems(assistantPartRanges(live), live);
  expect(groups).toEqual(executionActivityItems(assistantPartRanges(history), history));
  expect(groups[0]).toMatchObject({ title: "Investigate lifecycle transitions" });
});

test("a phase groups reads across reasoning while preserving every part in order", () => {
  const parts = [reasoning(), read("first"), reasoning(), read("second"), reasoning()];
  const ranges = assistantPartRanges(parts);
  const groups = executionActivityItems(ranges, parts);
  expect(groups).toEqual([{ kind: "tools", startIndex: 0, endIndex: 5, ranges }]);
  expect(groups[0]?.kind === "tools" && groups[0].ranges.map((range) => range.type)).toEqual(["reasoning", "tools", "reasoning", "tools", "reasoning"]);
});

test("a phase combines exploration, mutation and commands into one activity summary", () => {
  const parts = [read("source"), { ...read("edit"), toolName: "edit" }, { ...read("test"), toolName: "powershell", args: { command: "bun test" } }] as PartState[];
  const groups = executionActivityItems(assistantPartRanges(parts), parts);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ kind: "tools", startIndex: 0, endIndex: 3 });
});

test("commentary, media and compaction close a phase at their real positions", () => {
  const parts = [read("a"), read("b"), { type: "text", text: "Next phase" }, read("c"), read("d"), { type: "image", image: "data:image/png;base64,A" }, read("e"), read("f"), read("g"), read("h")] as PartState[];
  const ranges = positionedAssistantRanges(assistantPartRanges(parts), [{ id: "compact", partIndex: 8, startedAt: 1, status: "completed", source: "automatic" }]);
  const items = executionActivityItems(ranges, parts);
  expect(items.map((item) => item.kind === "tools" ? [item.startIndex, item.endIndex] : item.range.type)).toEqual([[0, 2], "text", [3, 5], "image", [6, 8], "compaction", [8, 10]]);
});

test("failed actions remain independent and close both sides of a phase", () => {
  const parts = [read("a"), read("b"), { ...read("failed"), isError: true }, read("c"), read("d")] as PartState[];
  const ranges = assistantPartRanges(parts);
  expect(executionActivityItems(ranges, parts).map((item) => item.kind === "tools" ? [item.startIndex, item.endIndex] : item.range)).toEqual([
    [0, 2], { type: "tools", startIndex: 2, endIndex: 3 }, [3, 5],
  ]);
  const liveParts = parts.map((part) => part.type === "tool-call" ? { ...part, isError: false } : part);
  expect(executionActivityItems(assistantPartRanges(liveParts), liveParts, new Map([["failed", { status: "failed" }]])).map((item) => item.kind)).toEqual(["tools", "part", "tools"]);
});

test("an omitted whitespace text part still closes the tool phase", () => {
  const parts = [read("a"), read("b"), { type: "text", text: " " }, read("c"), read("d")] as PartState[];
  expect(executionActivityItems(assistantPartRanges(parts), parts).map((item) => item.kind === "tools" && [item.startIndex, item.endIndex])).toEqual([[0, 2], [3, 5]]);
});

test("one tool or reasoning alone retains its own disclosure", () => {
  for (const parts of [[reasoning()], [reasoning(), read("single"), reasoning()]]) {
    const ranges = assistantPartRanges(parts);
    expect(executionActivityItems(ranges, parts)).toEqual(ranges.map((range) => ({ kind: "part", range })));
  }
});

test("grouping leaves source ranges untouched and survives reload with the same boundaries", () => {
  const source: AssistantMessagePart[] = [
    { type: "reasoning", text: "Inspect", messageSequence: 1, complete: true },
    { type: "tool-call", toolName: "read", toolCallId: "a", args: { path: "a.ts" }, result: "done", messageSequence: 1 },
    { type: "reasoning", text: "Continue", messageSequence: 2, complete: true },
    { type: "tool-call", toolName: "read", toolCallId: "b", args: { path: "b.ts" }, result: "done", messageSequence: 2 },
  ];
  const live = assistantMessageContent({ content: "", parts: source }, [], true) as PartState[];
  const history = assistantMessageContent({ content: "", parts: JSON.parse(JSON.stringify(source)) }, [], false) as PartState[];
  const ranges = assistantPartRanges(live);
  const original = structuredClone(ranges);
  const groups = executionActivityItems(ranges, live);
  expect(ranges).toEqual(original);
  expect(groups).toEqual(executionActivityItems(assistantPartRanges(history), history));
  expect(groups).toHaveLength(1);
});
