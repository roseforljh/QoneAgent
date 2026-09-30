import { expect, test } from "bun:test";
import { toolGroupSummary } from "../src/components/assistant-ui/tool-group-summary";
import { toolFullTarget, toolTarget } from "../src/components/assistant-ui/tool-action-summary";

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
