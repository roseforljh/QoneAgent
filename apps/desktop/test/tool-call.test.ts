import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCall } from "../src/components/assistant-ui/elements/tool-call";
import { formatToolPayload, toolCallStatus } from "../src/components/assistant-ui/tool-call-display";

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
});
