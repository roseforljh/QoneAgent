import { expect, test } from "bun:test";
import {
  getPastedTextFileName,
  LONG_PASTE_CHAR_LIMIT,
  shouldConvertLongPaste,
} from "../src/lib/long-paste";

test("short pasted text stays in the composer", () => {
  expect(shouldConvertLongPaste("普通的一句话")).toBe(false);
  expect(shouldConvertLongPaste("x".repeat(LONG_PASTE_CHAR_LIMIT - 1))).toBe(false);
});

test("long pasted text becomes a document title based on its first line", () => {
  const text = `PS C:\\Users\\33039\\Desktop\\QoneAgent> bun run\n${"x".repeat(LONG_PASTE_CHAR_LIMIT)}`;
  expect(shouldConvertLongPaste(text)).toBe(true);
  expect(getPastedTextFileName(text)).toBe("PS C:\\Users\\33039\\Desktop\\QoneAgent> bun run");
});

test("very long first lines are safely truncated for display", () => {
  expect(getPastedTextFileName("a".repeat(120))).toHaveLength(96);
});
