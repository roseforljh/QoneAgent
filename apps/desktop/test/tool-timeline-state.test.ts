import { expect, test } from "bun:test";
import { selectActiveToolIndex } from "../src/components/assistant-ui/tool-timeline-state";

const parts = ["edit", "command-1", "command-2"].map((toolCallId) => ({ toolCallId }));

test("the title follows the latest running tool, not the first pending tool", () => {
  const calls = new Map([["command-1", { status: "running" as const }]]);
  expect(selectActiveToolIndex(parts, calls, new Set(), true)).toBe(1);
  expect(selectActiveToolIndex(parts, new Map(), new Set(), true)).toBe(2);
});

test("finished tools have a completed title even while the assistant continues", () => {
  const calls = new Map(parts.map((part) => [part.toolCallId, { status: "success" as const }]));
  expect(selectActiveToolIndex(parts, calls, new Set(), true)).toBe(-1);
  expect(selectActiveToolIndex(parts, calls, new Set(), false)).toBe(-1);
});

test("waiting approval outranks later prepared calls", () => {
  const calls = new Map([["command-1", { status: "waiting" as const }]]);
  expect(selectActiveToolIndex(parts, calls, new Set(["command-2"]), true)).toBe(1);
});
