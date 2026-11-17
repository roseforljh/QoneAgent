import { expect, test } from "bun:test";
import { mergePathEntries, refreshWindowsPath } from "../electron/system-path";

test("registry PATH comes first and launcher-only entries are kept once", () => {
  expect(mergePathEntries("C:\\Windows\r\nC:\\Users\\a\\.bun\\bin;C:\\Windows\\\r\n", "C:\\Windows;D:\\launcher;c:\\users\\A\\.bun\\bin\\"))
    .toBe("C:\\Windows;C:\\Users\\a\\.bun\\bin;D:\\launcher");
});

test.if(process.platform === "win32")("a stale inherited PATH regains registry entries", async () => {
  const original = process.env.Path;
  process.env.Path = "D:\\only-from-launcher";
  try {
    await refreshWindowsPath();
    expect(process.env.Path).toContain("System32");
    expect(process.env.Path).toContain("D:\\only-from-launcher");
  } finally { process.env.Path = original; }
});
