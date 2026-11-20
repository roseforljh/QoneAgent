import { expect, test } from "bun:test";
import { mergePathEntries, refreshWindowsPath, resolveWindowsShell, windowsPowerShellPath } from "../electron/system-path";

test("registry PATH comes first and launcher-only entries are kept once", () => {
  expect(mergePathEntries("C:\\Windows\r\nC:\\Users\\a\\.bun\\bin;C:\\Windows\\\r\n", "C:\\Windows;D:\\launcher;c:\\users\\A\\.bun\\bin\\"))
    .toBe("C:\\Windows;C:\\Users\\a\\.bun\\bin;D:\\launcher");
});

test("resolveWindowsShell resolves the last PATH entry without trailing semicolon and falls back to Windows PowerShell", () => {
  const existing = new Set(["C:\\Tools\\pwsh.exe"]);
  expect(resolveWindowsShell(
    "pwsh.exe",
    { Path: "C:\\Windows\\System32;C:\\Tools", SystemRoot: "C:\\Windows" },
    (candidate) => existing.has(candidate),
  )).toBe("C:\\Tools\\pwsh.exe");

  // 找不到 pwsh.exe 时自动降级到系统内置 powershell.exe。
  expect(resolveWindowsShell(
    "pwsh.exe",
    { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
    () => false,
  )).toBe(windowsPowerShellPath({ SystemRoot: "C:\\Windows" }));

  // 绝对路径不可用时回退重新解析，避免跨账户提权场景失败。
  expect(resolveWindowsShell(
    "C:\\Users\\other\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe",
    { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    () => false,
  )).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
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
