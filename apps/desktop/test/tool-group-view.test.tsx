import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { SessionTimeline } from "../src/components/assistant-ui/session-timeline";
import { ToolCall } from "../src/components/assistant-ui/elements/tool-call";
import { ToolResultView } from "../src/components/assistant-ui/elements/tool-result";
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

test("completed timeline uses a category summary even when timing data is present", () => {
  const previous = useStore.getState().toolCalls;
  try {
    useStore.setState({ toolCalls: ["read", "grep"].map((toolName) => ({
      toolCallId: toolName, toolName, runId: "test", status: "success", startedAt: 1000, completedAt: 2000,
    })) });
    const html = renderToStaticMarkup(<Fixture />);
    expect(html).toContain('data-slot="tool-timeline"');
    expect(html).toMatch(/读取了文件|Read files/);
    expect(html).not.toMatch(/读取 1 项|Read ×1|搜索 1 项|Search ×1/);
    expect(html).not.toMatch(/耗时|Worked for/);
  } finally {
    useStore.setState({ toolCalls: previous });
  }
});

function FailedFixture() {
  const messages: ThreadMessageLike[] = [{
    id: "failed-command", role: "assistant", status: { type: "complete", reason: "stop" },
    content: [{ type: "tool-call", toolName: "powershell", toolCallId: "failed-command-tool", args: { command: "./gradlew test" }, result: "Gradle failed", isError: true }],
  }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={1} /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("failed commands use the compact tool row instead of a separate card", () => {
  const html = renderToStaticMarkup(<FailedFixture />);
  expect(html).toContain('data-slot="tool-call"');
  expect(html).toContain('data-status="failed"');
  expect(html).not.toContain('data-slot="tool-error"');
});

test("expanded failed command has one result frame and a bounded output area", () => {
  const html = renderToStaticMarkup(<ToolCall
    label="运行"
    activeLabel="运行中"
    query="./gradlew test"
    result={<ToolResultView presentation={{ kind: "terminal", output: "Gradle failed" }} />}
    resultHasOwnFrame
    running={false}
    failed
    open
    onOpenChange={() => {}}
  />);
  expect(html).toContain('data-slot="tool-terminal-result"');
  expect(html).toContain('data-slot="tool-result-panel" class="mt-1.5"');
  expect(html).toContain('max-h-[min(16rem,38dvh)]');
  expect(html).not.toContain('max-h-[min(22rem,60dvh)]');
});
