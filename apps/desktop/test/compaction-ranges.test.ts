import { expect, test } from "bun:test";
import { assistantRangeSections } from "../src/components/assistant-ui/assistant-part-ranges";
import { compactionDisplayIndex, compactionRangeSegments, type PositionedCompaction } from "../src/components/assistant-ui/compaction-ranges";

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
