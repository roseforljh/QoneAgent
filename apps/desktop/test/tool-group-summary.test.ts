import { expect, test } from "bun:test";
import { toolGroupSummary } from "../src/components/assistant-ui/tool-group-summary";
import { commandForTool, toolActionSummary, toolFullTarget, toolOperationLabels, toolPreparationLabel, toolTarget } from "../src/components/assistant-ui/tool-action-summary";
import { toolActivityCategory } from "../src/components/assistant-ui/tool-activity-category";

test("completed groups show only the latest operation without comma-joined lists", () => {
  expect(toolGroupSummary([{ verb: "读取" }, { verb: "搜索" }, { verb: "读取" }], "zh-CN"))
    .toBe("读取");
  expect(toolGroupSummary([{ verb: "Read" }, { verb: "Read" }], "en")).toBe("Read");
  expect(toolGroupSummary([{ verb: "custom_tool" }], "en")).toBe("custom_tool");
});

test("toolGroupSummary shows only the latest file instead of listing all files", () => {
  const stepsZh = [
    { verb: "读取", target: "composer.tsx" },
    { verb: "读取", target: "assistant-context.tsx" },
    { verb: "读取", target: "Thread.tsx" },
  ];
  expect(toolGroupSummary(stepsZh, "zh-CN"))
    .toBe("读取 Thread.tsx");

  const stepsEn = [
    { verb: "Read", target: "composer.tsx" },
    { verb: "Read", target: "assistant-context.tsx" },
    { verb: "Read", target: "Thread.tsx" },
  ];
  expect(toolGroupSummary(stepsEn, "en"))
    .toBe("Read Thread.tsx");
});

test("toolGroupSummary shows the latest step for mixed search and file reads", () => {
  const steps = [
    { verb: "查找", target: "desktop" },
    { verb: "查找", target: "src" },
    { verb: "搜索", target: "executionFinishing in src" },
    { verb: "读取", target: "composer.tsx" },
    { verb: "读取", target: "assistant-context.tsx" },
    { verb: "搜索", target: "executionFinishing in src" },
    { verb: "读取", target: "Thread.tsx" },
  ];
  expect(toolGroupSummary(steps, "zh-CN"))
    .toBe("读取 Thread.tsx");
});

test("group summary shows the latest concrete action concisely", () => {
  const steps = [
    { verb: "编辑", target: "App.tsx", fullTarget: "apps/desktop/src/App.tsx", category: "file-change" as const },
    { verb: "编辑", target: "App.tsx", fullTarget: "apps/desktop/src/App.tsx", category: "file-change" as const },
    { verb: "运行", target: "bun run --cwd apps/desktop tsc --noEmit", category: "command" as const },
  ];
  expect(toolGroupSummary(steps, "zh-CN")).toBe("运行了 bun run --cwd apps/desktop tsc --noEmit");
  expect(toolGroupSummary(steps, "en")).toBe("Ran bun run --cwd apps/desktop tsc --noEmit");
  expect(toolGroupSummary([{ verb: "运行", category: "command" as const }], "en")).toBe("Ran a command");
  expect(toolGroupSummary([
    { verb: "补丁", category: "file-change", filePaths: ["src/App.tsx", "src/Thread.tsx"] },
    { verb: "编辑", category: "file-change", filePaths: ["src/App.tsx"] },
  ], "en")).toBe("Edited App.tsx");
  expect(toolGroupSummary([
    { verb: "编辑", category: "file-change", filePaths: ["src/A.tsx", "src/B.tsx", "src/C.tsx"] },
  ], "zh-CN")).toBe("修改了 3 个文件");
  expect(toolGroupSummary([
    { verb: "编辑", target: "main.ts", category: "file-change" as const },
    { toolName: "read", verb: "读取", target: "main.ts", category: "exploration" as const },
  ], "zh-CN")).toBe("读取了 main.ts");
});

test("structured file changes from custom tools are classified as edits", () => {
  expect(toolActivityCategory("custom_patch", { details: { fileChanges: [{ path: "src/App.tsx", patch: "@@ -1 +1 @@\n-a\n+b" }] } })).toBe("file-change");
  expect(toolActivityCategory("bash", { content: [{ type: "text", text: "updated a file" }] })).toBe("command");
});

test("failed latest action is reported directly without combining earlier actions", () => {
  const steps = [
    { verb: "编辑", category: "file-change" as const, filePaths: ["src/App.tsx"] },
    { verb: "运行", category: "command" as const, failed: true },
  ];
  expect(toolGroupSummary(steps, "zh-CN")).toBe("运行出错");
  expect(toolGroupSummary(steps, "en")).toBe("Command failed");
  expect(toolGroupSummary(steps.slice(1), "zh-CN")).toBe("运行出错");
});

test("integration calls show the latest action without boilerplate lists", () => {
  const context7 = { id: "mcp-context7", name: "Context7", logo: "context7.svg" };
  const playwright = { id: "mcp-playwright", name: "Playwright", logo: "playwright.svg" };
  expect(toolGroupSummary([
    { verb: "调用", category: "integration", integration: context7 },
    { verb: "调用", category: "integration", integration: context7 },
    { verb: "调用", category: "integration", integration: playwright },
    { verb: "运行", category: "command" },
  ], "zh-CN")).toBe("运行了命令");
  expect(toolGroupSummary([
    { verb: "Call", category: "integration", integration: context7 },
    { verb: "Call", category: "integration", integration: playwright },
  ], "en")).toBe("Used Playwright");
  expect(toolGroupSummary([
    { verb: "Call", category: "integration", integration: context7 },
    { verb: "Run", category: "command" },
    { verb: "Read", category: "exploration" },
  ], "en")).toBe("Read a file");
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

test("missing or partial arguments never turn the tool name into a target", () => {
  for (const toolName of ["read", "grep", "ls", "powershell", "custom_tool", "mcp:context7:resolve-library-id"]) {
    const part = { toolName, args: { path: "  " } };
    expect(toolTarget(part)).toBe("");
    expect(toolFullTarget(part)).toBe("");
  }
});

test("live arguments take precedence over a stale streamed preview", () => {
  const call = { toolCallId: "read-live", runId: "test", toolName: "read", status: "success" as const, args: { path: "src/tool-group-summary.ts" } };
  const part = { toolName: "read", args: { path: "src/toolGroupSummary" } };
  expect(toolTarget(part, call)).toBe("tool-group-summary.ts");
  expect(toolFullTarget(part, call)).toBe("src/tool-group-summary.ts");
  expect(commandForTool({ toolName: "powershell", args: { command: "bun" } }, {
    ...call, toolName: "powershell", args: { command: "bun test" },
  })).toBe("bun test");
});

test("single exploration actions distinguish reads, searches and listings in both languages", () => {
  expect(toolOperationLabels({ toolName: "read" }, "读取", "zh-CN")).toEqual({ active: "正在读取", completed: "读取了" });
  expect(toolOperationLabels({ toolName: "grep" }, "Search", "en")).toEqual({ active: "Searching", completed: "Searched" });
  expect(toolOperationLabels({ toolName: "ls" }, "查看", "zh-CN")).toEqual({ active: "正在查看", completed: "查看了" });
  expect(toolOperationLabels({ toolName: "powershell" }, "Run", "en")).toEqual({ active: "Running", completed: "Ran" });
  expect(toolActionSummary({ toolName: "read" }, { verb: "Read", target: "summary.ts" }, undefined, true, 0, "en")).toBe("Reading summary.ts");
  expect(toolActionSummary({ toolName: "read" }, { verb: "Read", target: "" }, undefined, true, 0, "en")).toBe("Reading");
  expect(toolActionSummary({ toolName: "read", result: "done" }, { verb: "读取", target: "summary.ts" }, undefined, false, 0, "zh-CN")).toBe("读取了 summary.ts");
  expect(toolGroupSummary([{ verb: "读取", category: "exploration" }], "zh-CN")).toBe("读取了文件");
});

test("mutation and custom labels remain semantic without duplicating a missing target", () => {
  expect(toolOperationLabels({ toolName: "edit" }, "Edit", "en")).toEqual({ active: "Editing", completed: "Edited" });
  expect(toolOperationLabels({ toolName: "write" }, "写入", "zh-CN")).toEqual({ active: "正在写入", completed: "写入了" });
  expect(toolOperationLabels({ toolName: "custom_tool" }, "custom_tool", "zh-CN")).toEqual({ active: "正在用 custom_tool", completed: "用了 custom_tool" });
  expect(toolActionSummary({ toolName: "mcp:context7:resolve-library-id" }, { verb: "resolve-library-id", target: "", integration: { name: "Context7" } }, undefined, true, 0, "en")).toBe("Using Context7");
});

test("preparation titles describe the action and integration without exposing argument generation", () => {
  expect(toolPreparationLabel({ toolName: "read" }, { verb: "读取" }, "zh-CN")).toBe("准备读取");
  expect(toolPreparationLabel({ toolName: "grep" }, { verb: "Search" }, "en")).toBe("About to search");
  expect(toolPreparationLabel({ toolName: "mcp:context7:resolve-library-id" }, { verb: "resolve-library-id", integration: { name: "Context7" } }, "en")).toBe("Connecting to Context7");
  expect(toolPreparationLabel({ toolName: "custom_tool" }, { verb: "custom_tool" }, "zh-CN")).toBe("准备中…");
});

test("a command field on an integration is not classified as local shell execution", () => {
  const part = { toolName: "mcp:github:run-action", args: { command: "repository check" } };
  expect(commandForTool(part)).toBeUndefined();
  expect(toolTarget(part)).toBe("repository check");
  expect(toolActionSummary(part, { verb: "GitHub", target: "repository check", integration: { name: "GitHub" } }, undefined, true, 0, "en")).toBe("Using GitHub repository check");
});

test("web sources do not claim to be installed integrations", () => {
  const web = { id: "web", name: "网页", logo: "globe.svg", kind: "source" as const };
  expect(toolGroupSummary([{ verb: "网页", category: "integration", integration: web }], "zh-CN")).toBe("看了网页");
  expect(toolGroupSummary([
    { verb: "Web", category: "integration", integration: { ...web, name: "Web" } },
    { verb: "Context7", category: "integration", integration: { id: "context7", name: "Context7", logo: "context7.svg" } },
  ], "en")).toBe("Used Context7");
});

test("custom tool names do not inherit a search schema from a substring", () => {
  const part = { toolName: "mcp:custom:research_file", args: { path: "src/report.ts", query: "background" } };
  expect(toolTarget(part)).toBe("report.ts");
  expect(toolFullTarget(part)).toBe("src/report.ts");
});

test("web searches and page reads retain their own semantic actions", () => {
  expect(toolOperationLabels({ toolName: "web_search" }, "搜索网页", "zh-CN")).toEqual({ active: "正在搜网页", completed: "搜了网页" });
  expect(toolActivityCategory("web_search")).toBe("web-search");
  expect(toolGroupSummary([
    { verb: "Search the web", category: "web-search" },
    { verb: "Search the web", category: "web-search" },
    { verb: "Read", category: "exploration" },
  ], "en")).toBe("Read a file");
});

test("internal auxiliary tools do not pollute group titles with generic tool invocation", () => {
  const steps = [
    { verb: "编辑", target: "index.ts", fullTarget: "apps/agent-runtime/src/index.ts", category: "file-change" as const },
    { verb: "调用", target: "subagent", category: "tool" as const },
  ];
  expect(toolGroupSummary(steps, "zh-CN")).toBe("修改了 index.ts");
  expect(toolGroupSummary(steps, "en")).toBe("Edited index.ts");
  expect(toolActivityCategory("codemode")).toBe("command");
});

