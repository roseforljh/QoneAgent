import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { SessionTimeline } from "../src/components/assistant-ui/session-timeline";
import { useStore } from "../src/store";

function Fixture() {
  const messages: ThreadMessageLike[] = [{
    id: "group-summary", role: "assistant", status: { type: "complete", reason: "stop" },
    content: ["read", "grep"].map((toolName) => ({
      type: "tool-call" as const, toolName, toolCallId: toolName, args: { path: "source.ts" }, result: "done",
    })),
  }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={2} /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("completed timeline keeps operation labels even when timing data is present", () => {
  const previous = useStore.getState().toolCalls;
  try {
    useStore.setState({ toolCalls: ["read", "grep"].map((toolName) => ({
      toolCallId: toolName, toolName, runId: "test", status: "success", startedAt: 1000, completedAt: 2000,
    })) });
    const html = renderToStaticMarkup(<Fixture />);
    expect(html).toContain('data-slot="tool-timeline"');
    expect(html).toMatch(/读取 1 项|Read ×1/);
    expect(html).toMatch(/搜索 1 项|Search ×1/);
    expect(html).not.toMatch(/耗时|Worked for/);
  } finally {
    useStore.setState({ toolCalls: previous });
  }
});
