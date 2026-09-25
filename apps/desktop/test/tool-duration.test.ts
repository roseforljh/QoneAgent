import { expect, test } from "bun:test";
import { toolActionSummary } from "../src/components/assistant-ui/tool-action-summary";

const part = { toolName: "powershell", args: { command: "Get-ChildItem" } };
const step = { verb: "运行", target: "Get-ChildItem" };

test("short command durations stay meaningful instead of showing zero seconds", () => {
  expect(toolActionSummary(part, step, {
    toolCallId: "call-1", runId: "run-1", toolName: "powershell", status: "success",
    startedAt: 1_000, completedAt: 1_001,
  }, false, 2_000, "zh-CN")).toBe("命令已运行 <1秒");
  expect(toolActionSummary(part, step, {
    toolCallId: "call-2", runId: "run-1", toolName: "powershell", status: "running",
    startedAt: 1_000,
  }, true, 1_500, "en")).toBe("Running Get-ChildItem for <1s");
});

test("normal command durations keep the existing whole-second display", () => {
  expect(toolActionSummary(part, step, {
    toolCallId: "call-3", runId: "run-1", toolName: "powershell", status: "success",
    startedAt: 1_000, completedAt: 3_200,
  }, false, 4_000, "zh-CN")).toBe("命令已运行 2秒");
});
