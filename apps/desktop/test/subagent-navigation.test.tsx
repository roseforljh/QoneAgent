import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentRunInfo } from "@qone/protocol";
import { ToolCall } from "../src/components/assistant-ui/elements/tool-call";
import { hasSubagentCreationCall, shouldRenderSubagentTool, subagentForTool } from "../src/components/assistant-ui/subagent-navigation";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { SessionTimeline } from "../src/components/assistant-ui/session-timeline";
import { useStore } from "../src/store";

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

test("follow-up operations reuse the creation entry instead of rendering a duplicate", () => {
  const messages = [{ runId: "parent", parts: [{ type: "tool-call", toolName: "dispatch_subagent", toolCallId: "dispatch" }] }];
  const currentParts = [{ type: "tool-call", toolName: "control_subagent", toolCallId: "follow-up", args: { runId: child.id } }];
  expect(hasSubagentCreationCall(messages, currentParts, child)).toBe(true);
  expect(shouldRenderSubagentTool(currentParts[0]!, child, messages, currentParts)).toBe(false);
  expect(shouldRenderSubagentTool({ toolName: "control_subagent", toolCallId: "follow-up" }, child, [], currentParts)).toBe(true);
});

test("historical follow-up rows are hidden when the creation row is in an earlier message", () => {
  const serverState = useStore.getInitialState();
  const previous = { ...serverState };
  try {
    Object.assign(serverState, {
      currentSessionId: "session", activeRunId: "later-parent", subagents: [child], toolCalls: [],
      messages: [{ id: "created-message", role: "assistant", runId: "parent", parts: [{ type: "tool-call", toolName: "dispatch_subagent", toolCallId: "dispatch" }] }],
    });
    const html = renderToStaticMarkup(<TimelineFixture content={[{
      type: "tool-call", toolName: "inspect_subagent", toolCallId: "inspect", args: { runId: child.id }, result: "private child output",
    }]} />);
    expect(html).not.toContain('data-slot="tool-target-link"');
    expect(html).not.toContain("private child output");
  } finally { Object.assign(serverState, previous); }
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

function TimelineFixture({ content, running = false }: { content: ThreadMessageLike["content"]; running?: boolean }) {
  const messages: ThreadMessageLike[] = [{ id: "streaming", role: "assistant", content,
    status: running ? { type: "running" } : { type: "complete", reason: "stop" } }];
  const runtime = useExternalStoreRuntime({ messages, isRunning: running, convertMessage: (message) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={1} /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("actual timeline reuses the child link for creation and cross-turn calls in foreground or background", () => {
  const serverState = useStore.getInitialState();
  const previous = { ...serverState };
  try {
    for (const background of [false, true]) {
      for (const status of ["running", "completed", "failed"] as const) {
        Object.assign(serverState, { currentSessionId: "session", activeRunId: "parent", subagents: [{ ...child, background, status }], toolCalls: [] });
        for (const toolName of ["dispatch_subagent", "inspect_subagent", "control_subagent", "wait_subagent"]) {
          serverState.activeRunId = toolName === "dispatch_subagent" ? "parent" : "later-parent";
          const html = renderToStaticMarkup(<TimelineFixture content={[{
            type: "tool-call", toolName, toolCallId: toolName === "dispatch_subagent" ? "dispatch" : "later-call",
            args: { runId: child.id }, result: "private child output",
          }]} />);
          expect(html).toContain('data-slot="tool-target-link"');
          expect(html).toContain(child.title);
          expect(html).toMatch(/aria-label="(?:打开子代理：|Open subagent: )修复连接中卡死问题"/);
          expect(html).not.toContain('data-slot="tool-result-panel"');
          expect(html).not.toContain(toolName);
          expect(html).not.toContain("private child output");
          expect(html).toMatch(/<button(?=[^>]*data-slot="collapsible-trigger")(?=[^>]*\sdisabled="")[^>]*>/);
        }
      }
    }
  } finally { Object.assign(serverState, previous); }
});

test("subagent calls never fall back to expandable result cards while arguments or snapshots are pending", () => {
  const serverState = useStore.getInitialState();
  const previous = { ...serverState };
  try {
    Object.assign(serverState, { currentSessionId: "session", activeRunId: "parent", subagents: [], toolCalls: [] });
    for (const toolName of ["dispatch_subagent", "run_subagent_workflow", "inspect_subagent", "control_subagent", "wait_subagent"]) {
      const html = renderToStaticMarkup(<TimelineFixture running content={[{ type: "tool-call", toolName, toolCallId: "pending", args: {} }]} />);
      expect(html).not.toContain('data-slot="tool-target-link"');
      expect(html).not.toContain('data-slot="tool-result-panel"');
      expect(html).not.toContain(toolName);
      expect(html).toMatch(/<button(?=[^>]*data-slot="collapsible-trigger")(?=[^>]*\sdisabled="")[^>]*>/);
    }
  } finally { Object.assign(serverState, previous); }
});

