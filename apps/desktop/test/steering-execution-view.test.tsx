import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { AssistantExecution } from "../src/components/assistant-ui/assistant-execution";
import { executionStatusAtStart } from "../src/components/assistant-ui/execution-disclosure-state";

function Fixture() {
  const messages: ThreadMessageLike[] = [{ id: "before-steer", role: "assistant", status: { type: "complete", reason: "stop" }, content: [
    { type: "tool-call", toolCallId: "read", toolName: "read", args: { path: "queue.ts" }, result: "done" },
  ] }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><AssistantExecution
      ranges={[{ type: "tools", startIndex: 0, endIndex: 1 }]}
      finalAnswerStarted={false}
      statusAtStart={executionStatusAtStart(false, "completed", false)}
    ><span data-tool-list="true">read queue.ts</span></AssistantExecution></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("a completed pre-steer segment places its execution summary above its tools even without final prose", () => {
  const html = renderToStaticMarkup(<Fixture />);
  const summary = html.search(/共执行了|Ran/);
  const tool = html.indexOf('data-tool-list="true"');
  expect(summary).toBeGreaterThan(-1);
  expect(tool).toBeGreaterThan(summary);
});

test("execution header placement also preserves active and interrupted states", () => {
  expect(executionStatusAtStart(false, "running", true)).toBe(true);
  expect(executionStatusAtStart(false, undefined, true)).toBe(true);
  expect(executionStatusAtStart(true, "completed", false)).toBe(true);
  expect(executionStatusAtStart(false, "cancelled", false)).toBe(false);
  expect(executionStatusAtStart(true, "interrupted", false)).toBe(false);
});
