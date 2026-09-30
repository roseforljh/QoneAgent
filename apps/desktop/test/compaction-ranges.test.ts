import { expect, test } from "bun:test";
import { assistantRangeSections, executionDisplayBlocks } from "../src/components/assistant-ui/assistant-part-ranges";
import { compactionDisplayIndex, compactionRangeSegments, executionSegmentLayout, positionedAssistantRanges, type PositionedCompaction } from "../src/components/assistant-ui/compaction-ranges";

const marker = (id: string, partIndex: number): PositionedCompaction => ({ id, partIndex, startedAt: 10, source: "automatic", status: "completed" });

test("reasoning on both sides of compaction stays in its own execution region", () => {
  const segments = compactionRangeSegments([
    { type: "reasoning", index: 0 }, { type: "tools", startIndex: 1, endIndex: 2 },
    { type: "reasoning", index: 2 }, { type: "text", index: 3 },
  ], [marker("compact", 2)]);
  const before = assistantRangeSections(segments[0]!.ranges);
  const after = assistantRangeSections(segments[1]!.ranges);
  expect(before.activity).toEqual([{ type: "reasoning", index: 0 }, { type: "tools", startIndex: 1, endIndex: 2 }]);
  expect(after.activity).toEqual([{ type: "reasoning", index: 2 }]);
  expect(after.answer).toEqual([{ type: "text", index: 3 }]);
});

test("reasoning display changes do not move compaction across tools or answer text", () => {
  const parts = [{ type: "reasoning" }, { type: "text" }, { type: "tool-call" }, { type: "reasoning" }, { type: "text" }];
  expect(compactionDisplayIndex(parts, 2)).toBe(3);
  expect(compactionDisplayIndex(parts.filter((part) => part.type !== "reasoning"), 2)).toBe(2);
  expect(compactionDisplayIndex(parts, 0)).toBe(0);
});

test("compaction splits a tool group at the recorded boundary", () => {
  expect(compactionRangeSegments([
    { type: "text", index: 0 }, { type: "tools", startIndex: 1, endIndex: 5 }, { type: "text", index: 5 },
  ], [marker("compact", 3)])).toEqual([
    { ranges: [{ type: "text", index: 0 }, { type: "tools", startIndex: 1, endIndex: 3 }], marker: marker("compact", 3) },
    { ranges: [{ type: "tools", startIndex: 3, endIndex: 5 }, { type: "text", index: 5 }] },
  ]);
});

test("start, consecutive and trailing compactions retain order without losing content", () => {
  const markers = [marker("last", 2), marker("first", 0), marker("second", 0)];
  const segments = compactionRangeSegments([{ type: "text", index: 0 }, { type: "image", index: 1 }], markers);
  expect(segments.flatMap((segment) => segment.ranges)).toEqual([{ type: "text", index: 0 }, { type: "image", index: 1 }]);
  expect(segments.map((segment) => segment.marker?.id)).toEqual(["first", "second", "last", undefined]);
  expect(segments[0]?.ranges).toEqual([]);
  expect(segments.at(-1)?.ranges).toEqual([]);
});

test("hidden parts do not shift the boundary and empty messages still show running compaction", () => {
  expect(compactionRangeSegments([{ type: "text", index: 4 }], [marker("compact", 3)])[0]?.ranges).toEqual([]);
  const running = { ...marker("running", 0), status: "running" as const };
  expect(compactionRangeSegments([], [running])[0]?.marker).toEqual(running);
});

test("split process sections share one disclosure and one status after the last activity", () => {
  const segments = compactionRangeSegments([
    { type: "text", index: 0, phase: "commentary" },
    { type: "tools", startIndex: 1, endIndex: 2 },
    { type: "text", index: 2, phase: "commentary" },
    { type: "tools", startIndex: 3, endIndex: 4 },
    { type: "text", index: 4, phase: "final_answer" },
  ], [marker("compact", 2)]);
  const layout = executionSegmentLayout(segments);
  expect(layout.groups.map((group) => group.activity.length)).toEqual([2, 2]);
  expect(layout.groups[1]?.answer).toEqual([{ type: "text", index: 4, phase: "final_answer" }]);
  expect(layout.firstActivitySegment).toBe(0);
  expect(layout.lastActivitySegment).toBe(1);
  expect(layout.statusSegmentIndex).toBe(1);
  expect(layout.disclosureStartIndex).toBe(0);
});

test("a compaction immediately before the answer keeps the divider after the marker", () => {
  const segments = compactionRangeSegments([
    { type: "text", index: 0, phase: "commentary" },
    { type: "tools", startIndex: 1, endIndex: 2 },
    { type: "text", index: 2, phase: "final_answer" },
  ], [marker("compact", 2)]);
  const layout = executionSegmentLayout(segments);
  expect(layout.groups[1]?.activity).toEqual([]);
  expect(layout.lastActivitySegment).toBe(0);
  expect(layout.statusSegmentIndex).toBe(1);
});

test("compaction stays at its event boundary inside the collapsible execution", () => {
  const ranges = positionedAssistantRanges([
    { type: "text", index: 0, phase: "commentary" },
    { type: "tools", startIndex: 1, endIndex: 2 },
    { type: "subagents", index: 2 },
    { type: "text", index: 3, phase: "final_answer" },
  ], [marker("compact", 3)]);
  expect(ranges.map((range) => range.type)).toEqual(["text", "tools", "subagents", "compaction", "text"]);
  const sections = assistantRangeSections(ranges);
  expect(sections.activity.map((range) => range.type)).toEqual(["text", "tools", "subagents", "compaction"]);
  expect(sections.answer.map((range) => range.type)).toEqual(["text"]);
});

test("compaction after a completed answer remains at the end of the reply", () => {
  const ranges = positionedAssistantRanges([
    { type: "tools", startIndex: 0, endIndex: 1 },
    { type: "text", index: 1, phase: "final_answer" },
  ], [marker("after-answer", 2)]);
  const sections = assistantRangeSections(ranges);
  expect(sections.activity.map((range) => range.type)).toEqual(["tools"]);
  expect(sections.answer.map((range) => range.type)).toEqual(["text", "compaction"]);
});

test("interleaved media does not shift a subagent or compaction marker", () => {
  const ranges = positionedAssistantRanges([
    { type: "tools", startIndex: 0, endIndex: 1 },
    { type: "image", index: 1 },
    { type: "subagents", index: 2 },
    { type: "text", index: 3, phase: "final_answer" },
  ], [marker("compact", 3)]);
  const blocks = executionDisplayBlocks(assistantRangeSections(ranges).process);
  expect(blocks.map((block) => [block.kind, block.ranges.map((range) => range.type)])).toEqual([
    ["activity", ["tools"]],
    ["persistent", ["image"]],
    ["activity", ["subagents", "compaction"]],
  ]);
});
