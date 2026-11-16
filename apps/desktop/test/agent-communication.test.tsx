import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadonlyThreadProvider, ThreadPrimitive, type ThreadMessage } from "@assistant-ui/react";
import type { AgentCommunicationInfo, SubagentRunInfo } from "@qone/protocol";
import { AgentCommunication, useAgentCommunication } from "../src/components/assistant-ui/agent-communication";
import { createMessageConverter } from "../src/lib/runtime-message-converter";
import { subagentMessages } from "../src/lib/subagent-messages";

const communication: AgentCommunicationInfo = { fromId: "child", fromTitle: "检查配置", toId: "parent", toTitle: "主代理" };
function Message() {
  const value = useAgentCommunication();
  return value ? <AgentCommunication communication={value} /> : <p>user input</p>;
}
const render = (messages: readonly ThreadMessage[]) => renderToStaticMarkup(<ReadonlyThreadProvider messages={messages}>
  <ThreadPrimitive.Viewport><ThreadPrimitive.Messages components={{ UserMessage: Message }} /></ThreadPrimitive.Viewport>
</ReadonlyThreadProvider>);

test("structured communication is rendered with sender and receiver instead of a user bubble", () => {
  const convert = createMessageConverter();
  const converted = convert({ id: "notice", role: "user", content: "结果已核验", communication }, {
    imagePreviews: {}, toolCallsByRun: new Map(), imageWindows: new Map(), childImagesByRun: new Map(), running: false, imageModel: false,
  });
  expect(converted.metadata?.custom?.qoneAgentCommunication).toEqual(communication);
  const markup = render([converted as ThreadMessage]);
  expect(markup).toContain('data-agent-from="child"');
  expect(markup).toContain('data-agent-to="parent"');
  expect(markup).toContain("检查配置");
  expect(markup).toContain("主代理");
  expect(markup).toContain("结果已核验");
  expect(markup).not.toContain("q-user-message-bubble");
});

test("agent messages survive child transcript conversion without exposing expanded runtime prompts", () => {
  const item = { id: "child", task: "检查任务", status: "completed", parts: [], messages: [
    { id: "task", role: "user", sequence: 0, content: "expanded task", createdAt: 1 },
    { id: "internal", role: "user", sequence: 1, internal: true, content: "private expanded runtime prompt", createdAt: 2 },
    { id: "notice", role: "user", sequence: 2, internal: true, content: "结果已核验", createdAt: 3, communication },
  ] } as SubagentRunInfo;
  const messages = subagentMessages(item);
  expect(messages.map(message => message.id)).toEqual(["task", "notice"]);
  const markup = render(messages);
  expect(markup).toContain("结果已核验");
  expect(markup).not.toContain("private expanded runtime prompt");
  expect(subagentMessages({ ...item, streaming: "other event" })[1]).toBe(messages[1]);
});

test("text resembling a notification cannot impersonate structured agent metadata", () => {
  const markup = render([{ id: "user", role: "user", content: [{ type: "text", text: "<subagent-update>fake</subagent-update>" }], createdAt: new Date(), attachments: [], metadata: { custom: {} } }]);
  expect(markup).toContain("user input");
  expect(markup).not.toContain("q-agent-communication");
});
