import { expect, test } from "bun:test";
import { computeDiff } from "../src/components/assistant-ui/elements/diff-viewer";

test("snapshot diff keeps changed hunks and omits distant unchanged lines", () => {
  const oldLines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[39] = "changed line 40";

  const diff = computeDiff(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`);
  expect(diff.additions).toBe(1);
  expect(diff.deletions).toBe(1);
  expect(diff.lines.some((line) => line.content === "line 1")).toBe(false);
  expect(diff.lines.some((line) => line.content === "line 80")).toBe(false);
  expect(diff.lines.some((line) => line.content === "changed line 40" && line.type === "add")).toBe(true);
  expect(diff.lines.filter((line) => line.type === "skip")).toHaveLength(1);
});

test("separate changes stay in separate hunks", () => {
  const oldLines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[9] = "changed line 10";
  newLines[69] = "changed line 70";

  const diff = computeDiff(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`);
  expect(diff.lines.filter((line) => line.type === "skip")).toHaveLength(2);
  expect(diff.lines.some((line) => line.content === "line 40")).toBe(false);
  expect(diff.lines.filter((line) => line.type === "add")).toHaveLength(2);
});
