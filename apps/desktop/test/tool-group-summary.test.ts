import { expect, test } from "bun:test";
import { toolGroupSummary } from "../src/components/assistant-ui/tool-group-summary";
import { toolFullTarget, toolTarget } from "../src/components/assistant-ui/tool-action-summary";
import { toolActivityCategory } from "../src/components/assistant-ui/tool-activity-category";

test("completed groups describe every operation in first-occurrence order", () => {
  expect(toolGroupSummary([{ verb: "读取" }, { verb: "搜索" }, { verb: "读取" }], "zh-CN"))
    .toBe("读取 2 项 · 搜索 1 项");
  expect(toolGroupSummary([{ verb: "Read" }, { verb: "Read" }], "en")).toBe("Read ×2");
  expect(toolGroupSummary([{ verb: "custom_tool" }], "en")).toBe("custom_tool ×1");
});

test("toolGroupSummary displays all files completely instead of only one file", () => {
  const stepsZh = [
    { verb: "读取", target: "composer.tsx" },
    { verb: "读取", target: "assistant-context.tsx" },
    { verb: "读取", target: "Thread.tsx" },
  ];
  expect(toolGroupSummary(stepsZh, "zh-CN"))
    .toBe("读取 3 项 (composer.tsx、assistant-context.tsx、Thread.tsx)");

  const stepsEn = [
    { verb: "Read", target: "composer.tsx" },
    { verb: "Read", target: "assistant-context.tsx" },
    { verb: "Read", target: "Thread.tsx" },
  ];
  expect(toolGroupSummary(stepsEn, "en"))
    .toBe("Read ×3 (composer.tsx, assistant-context.tsx, Thread.tsx)");
});

test("toolGroupSummary describes mixed search and multiple file reads completely", () => {
  const steps = [
    { verb: "查找", target: "desktop" },
    { verb: "查找", target: "src" },
    { verb: "搜索", target: "executionFinishing in src" },
    { verb: "读取", target: "composer.tsx" },
    { verb: "读取", target: "assistant-context.tsx" },
    { verb: "搜索", target: "executionFinishing in src" }, // duplicate target
    { verb: "读取", target: "Thread.tsx" },
  ];
  expect(toolGroupSummary(steps, "zh-CN"))
    .toBe("查找 2 项 (desktop、src) · 搜索 2 项 (executionFinishing in src) · 读取 3 项 (composer.tsx、assistant-context.tsx、Thread.tsx)");
});

test("Codex style group summary counts changed files once and keeps targets in detail rows", () => {
  const steps = [
    { verb: "编辑", target: "App.tsx", fullTarget: "apps/desktop/src/App.tsx", category: "file-change" as const },
    { verb: "编辑", target: "App.tsx", fullTarget: "apps/desktop/src/App.tsx", category: "file-change" as const },
    { verb: "运行", target: "bun run --cwd apps/desktop tsc --noEmit", category: "command" as const },
  ];
  expect(toolGroupSummary(steps, "zh-CN")).toBe("编辑了一个文件，运行了一个命令");
  expect(toolGroupSummary(steps, "en")).toBe("Edited a file and ran a command");
  expect(toolGroupSummary(steps.slice(2), "en")).toBe("Ran a command");
  expect(toolGroupSummary([
    { verb: "补丁", category: "file-change", filePaths: ["src/App.tsx", "src/Thread.tsx"] },
    { verb: "编辑", category: "file-change", filePaths: ["src/App.tsx"] },
  ], "en")).toBe("Edited files");
});

test("structured file changes from custom tools are classified as edits", () => {
  expect(toolActivityCategory("custom_patch", { details: { fileChanges: [{ path: "src/App.tsx", patch: "@@ -1 +1 @@\n-a\n+b" }] } })).toBe("file-change");
  expect(toolActivityCategory("bash", { content: [{ type: "text", text: "updated a file" }] })).toBe("command");
});

test("failed actions are not described as completed work", () => {
  const steps = [
    { verb: "编辑", category: "file-change" as const, filePaths: ["src/App.tsx"] },
    { verb: "运行", category: "command" as const, failed: true },
  ];
  expect(toolGroupSummary(steps, "zh-CN")).toBe("编辑了一个文件，一个操作失败");
  expect(toolGroupSummary(steps, "en")).toBe("Edited a file and an action failed");
  expect(toolGroupSummary(steps.slice(1), "zh-CN")).toBe("一个操作失败");
});

test("toolTarget preserves search pattern instead of discarding it for directory name", () => {
  const grepCall = {
    toolName: "grep",
    args: { pattern: "chat.executionFinishing", path: "src" },
  };
  expect(toolTarget(grepCall)).toBe("chat.executionFinishing (src)");
  expect(toolFullTarget(grepCall)).toBe("chat.executionFinishing in src");

  const findCall = {
    toolName: "find",
    args: { pattern: "*.tsx", path: "desktop" },
  };
  expect(toolTarget(findCall)).toBe("*.tsx (desktop)");
  expect(toolFullTarget(findCall)).toBe("*.tsx in desktop");

  const readCall = {
    toolName: "read",
    args: { path: "apps/desktop/src/components/Thread.tsx" },
  };
  expect(toolTarget(readCall)).toBe("Thread.tsx");
  expect(toolFullTarget(readCall)).toBe("apps/desktop/src/components/Thread.tsx");
});
