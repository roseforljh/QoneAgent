import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentRunInfo } from "@qone/protocol";
import { ToolCall } from "../src/components/assistant-ui/elements/tool-call";
import { subagentForTool } from "../src/components/assistant-ui/subagent-navigation";

const child = {
  id: "child", parentSessionId: "session", parentRunId: "parent", toolCallId: "dispatch",
  title: "修复连接中卡死问题", task: "修复", status: "completed", startedAt: 1, content: "", parts: [],
} as SubagentRunInfo;

test("dispatch and follow-up tools resolve the same child by structured IDs", () => {
  expect(subagentForTool({ toolName: "dispatch_subagent", toolCallId: "dispatch" }, undefined, [child], "session", "parent")).toBe(child);
  for (const toolName of ["inspect_subagent", "control_subagent", "wait_subagent"]) {
    expect(subagentForTool({ toolName, toolCallId: "other", args: { runId: "child" } }, undefined, [child], "session", "parent")).toBe(child);
    expect(subagentForTool({ toolName, toolCallId: "other" }, { runId: "child" }, [child], "session", "parent")).toBe(child);
    expect(subagentForTool({ toolName, toolCallId: "later", args: {} }, { runId: "child" }, [child], "session", "later-parent")).toBe(child);
  }
  expect(subagentForTool({ toolName: "control_subagent", toolCallId: "other", args: { runId: "missing" } }, undefined, [child], "session", "parent")).toBeUndefined();
  expect(subagentForTool({ toolName: "dispatch_subagent", toolCallId: "dispatch" }, undefined, [child], "other-session", "parent")).toBeUndefined();
  expect(subagentForTool({ toolName: "dispatch_subagent", toolCallId: "dispatch" }, undefined, [child], "session", "other-parent")).toBeUndefined();
  expect(subagentForTool({ toolName: "control_subagent", toolCallId: "later", args: { runId: "child" } }, undefined, [child], "session", "later-parent")).toBe(child);
});

test("workflow tools resolve a child step for the existing open-subagent action", () => {
  const workflowChild = { ...child, id: "workflow-child", toolCallId: "workflow:wf-1:scout", status: "running" } as SubagentRunInfo;
  expect(subagentForTool({ toolName: "run_subagent_workflow", toolCallId: "workflow-call" }, undefined, [workflowChild], "session", "parent")).toBe(workflowChild);
});

test("agent title is a separate accessible button beside the tool disclosure", () => {
  const html = renderToStaticMarkup(<ToolCall
    label="control_subagent" activeLabel="正在执行" query="control_subagent"
    targetAction={{ label: child.title, ariaLabel: `打开子代理：${child.title}`, onClick: () => {} }}
    result="done" running={false} open={false} onOpenChange={() => {}}
  />);
  expect(html).toContain('aria-label="打开子代理：修复连接中卡死问题"');
  expect(html).toMatch(/data-slot="collapsible-trigger"[^>]*>.*?<\/button><button type="button"/);
});

