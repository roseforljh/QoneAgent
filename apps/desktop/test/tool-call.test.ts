import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCall } from "../src/components/assistant-ui/elements/tool-call";
import { ToolResultView } from "../src/components/assistant-ui/elements/tool-result";
import { formatToolPayload, toolCallStatus, toolResultText } from "../src/components/assistant-ui/tool-call-display";

test("tool states do not mark pending or failed calls as successful", () => {
  expect(toolCallStatus({})).toBe("running");
  expect(toolCallStatus({ status: { type: "requires-action" } })).toBe("waiting");
  expect(toolCallStatus({ result: "done" })).toBe("success");
  expect(toolCallStatus({ result: "error", isError: true })).toBe("failed");
  expect(toolCallStatus({ result: "done" }, { status: "waiting" })).toBe("waiting");
});

test("tool request and result stay readable and bounded", () => {
  expect(formatToolPayload('{"path":"a.ts"}')).toBe('{\n  "path": "a.ts"\n}');
  expect(formatToolPayload("not JSON")).toBe("not JSON");
  expect(formatToolPayload("x".repeat(20_100))).toHaveLength(20_001);
});

test("empty command output falls back to a visible failure message", () => {
  expect(toolResultText("", undefined, "工具失败")).toBe("工具失败");
  expect(toolResultText("  ", "  ", "工具失败")).toBe("工具失败");
  expect(toolResultText("permission denied", undefined, "工具失败")).toBe("permission denied");
  expect(toolResultText("", { error: "permission denied" }, "工具失败")).toContain("permission denied");
});

test("official ToolCall displays actual request, result, and failure state", () => {
  const html = renderToStaticMarkup(createElement(ToolCall, {
    label: "读取",
    activeLabel: "正在读取",
    query: "file.ts",
    request: '{ "path": "file.ts" }',
    result: "file content",
    running: false,
    failed: true,
    open: true,
    onOpenChange: () => {},
  }));
  expect(html).toContain('data-slot="tool-call"');
  expect(html).toContain('data-status="failed"');
  expect(html).toContain("file content");
  expect(html).toContain("file.ts");
  expect(html).toContain('data-slot="tool-result-panel"');
  expect(html).toContain("border-border/40");
  expect(html).toContain('data-slot="codex-icon"');
  expect(html).not.toContain("text-red-");
  expect(html).not.toContain("text-amber-");
  expect(html).not.toContain("Request");
  expect(html).not.toContain("{ \"path\": \"file.ts\" }");
});

test("framed command output has one visible card", () => {
  const html = renderToStaticMarkup(createElement(ToolCall, {
    label: "运行", activeLabel: "正在运行", query: "Get-ChildItem",
    result: createElement(ToolResultView, { presentation: { kind: "terminal", output: "Name\n.agent" } }),
    resultHasOwnFrame: true,
    running: false, open: true, onOpenChange: () => {},
  }));
  expect(html).toMatch(/data-slot="tool-result-panel" class="mt-1.5"/);
  expect(html).toContain('data-slot="tool-terminal-result"');
  expect(html).not.toContain("border-border/40");
  expect(html).toContain("Name\n.agent");
});
