import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { UserMessage, UserMessageContent, UserMessageAttachments } from "../src/components/assistant-ui/user-message";
import { AssistantMessageActions, UserMessageActions } from "../src/components/assistant-ui/message-actions";
import { MessagePair } from "../src/components/assistant-ui/elements/message-pair";

function Fixture({ paired, running = false, text = "User prompt" }: { paired: boolean; running?: boolean; text?: string }) {
  const messages: ThreadMessageLike[] = [{ id: "user", role: "user", content: [{ type: "text", text }] }];
  if (paired) messages.push({
    id: "assistant", role: "assistant", content: [{ type: "text", text: "Assistant reply" }],
    status: running ? { type: "running" } : { type: "complete", reason: "stop" },
  });
  const runtime = useExternalStoreRuntime({
    messages, isRunning: running, convertMessage: (message: ThreadMessageLike) => message,
    onNew: async () => {}, onReload: async () => {},
  });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    UserMessage: paired ? () => null : UserMessage,
    AssistantMessage: () => <MessagePair
      userMessage="" words={[]} visibleWords={0} streaming={running} userContentIsSurface
      userContent={<ThreadPrimitive.Unstable_MessageById messageId="user" components={{ Message: UserMessageContent }} />}
      userAttachmentContent={<ThreadPrimitive.Unstable_MessageById messageId="user" components={{ Message: UserMessageAttachments }} />}
      userActions={<ThreadPrimitive.Unstable_MessageById messageId="user" components={{ Message: UserMessageActions }} />}
      assistantContent={<MessagePrimitive.Parts />}
      actions={<AssistantMessageActions />}
    />,
  }} /></AssistantRuntimeProvider>;
}

function renderThread(props: Parameters<typeof Fixture>[0]) {
  return renderToStaticMarkup(<Fixture {...props} />);
}

test("pending and paired user messages each offer one copy action without regeneration", () => {
  for (const paired of [false, true]) {
    const html = renderThread({ paired });
    const userActions = html.match(/class="q-message-actions q-user-message-actions"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    expect(userActions).toBeDefined();
    expect(userActions!.match(/<button\b/g)).toHaveLength(1);
    expect(userActions).toMatch(/aria-label="(?:复制|Copy)"/);
    expect(userActions).not.toMatch(/重新回答|Regenerate reply/);
    expect(userActions).toContain('data-slot="codex-icon"');
    expect(html).toContain('class="q-user-message-action-slot"');
    expect(html).not.toContain("q-message-action-slot");
    expect(html).toContain("max-w-[70%]");
  }
});

test("copying user text remains available while an answer is running", () => {
  const html = renderThread({ paired: true, running: true });
  expect(html).toContain("q-user-message-actions");
  expect(html).toMatch(/aria-label="(?:复制|Copy)"/);
  expect(html).not.toMatch(/aria-label="(?:重新回答|Regenerate reply)"/);
});

test("a completed assistant answer retains its own regeneration action", () => {
  const html = renderThread({ paired: true });
  expect(html.match(/aria-label="(?:重新回答|Regenerate reply)"/g)).toHaveLength(1);
  expect(html.match(/aria-label="(?:复制|Copy)"/g)).toHaveLength(2);
  expect(html).toContain('class="q-assistant-message-action-slot"');
});

test("blank user text does not expose an empty copy action", () => {
  const html = renderThread({ paired: false, text: " " });
  expect(html).not.toContain("q-user-message-actions");
  expect(html).not.toMatch(/aria-label="(?:复制|Copy)"/);
});
