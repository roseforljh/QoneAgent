import { expect, test } from "bun:test";
import { limitPreviewStrings, TOOL_PREVIEW_TEXT_LIMIT } from "@qone/protocol";

test("streamed tool argument snapshots cap every long string and keep the rest intact", () => {
  const content = "x".repeat(TOOL_PREVIEW_TEXT_LIMIT * 3);
  const capped = limitPreviewStrings({ path: "big.ts", content, edits: [{ oldText: content, newText: "short" }], count: 3 }) as {
    path: string; content: string; edits: { oldText: string; newText: string }[]; count: number;
  };
  expect(capped.path).toBe("big.ts");
  expect(capped.content.length).toBe(TOOL_PREVIEW_TEXT_LIMIT + 1);
  expect(capped.edits[0]!.oldText.length).toBe(TOOL_PREVIEW_TEXT_LIMIT + 1);
  expect(capped.edits[0]!.newText).toBe("short");
  expect(capped.count).toBe(3);
  expect(limitPreviewStrings(undefined)).toBeUndefined();
});
