import { afterEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import type { AppendMessage, ExternalStoreAdapter } from "@assistant-ui/react";
import type { MessageAttachmentInfo, RuntimeCommand } from "@qone/protocol";
import { getDraftComposer } from "../src/lib/composer-draft-runtime";
import { composerDrafts } from "../src/lib/composer-drafts";
import { extractComposerPrompt } from "../src/lib/composer-prompt";
import { serializeInlineQuote } from "../src/lib/inline-quote";
import { serializeMessageAttachments } from "../src/lib/message-attachments";
import { handleTruncateEvent, resetTruncateRequests, returnUserMessageToComposer, userMessageDraft } from "../src/lib/user-message-edit";
import { useStore } from "../src/store";

const coreDist = dirname(Bun.resolveSync("@assistant-ui/core", dirname(Bun.resolveSync("@assistant-ui/react", import.meta.dir))));
const { ExternalStoreRuntimeCore } = await import(join(coreDist, "runtimes/internal.js"));
const { AssistantRuntimeImpl } = await import(join(coreDist, "internal.js"));

const initialState = useStore.getState();
afterEach(() => {
  resetTruncateRequests();
  useStore.setState(initialState, true);
  composerDrafts.prune([]);
});

function createRuntime() {
  const adapter: ExternalStoreAdapter = {
    messages: [],
    isRunning: false,
    onNew: async () => {},
  };
  const core = new ExternalStoreRuntimeCore(adapter);
  return new AssistantRuntimeImpl(core);
}

test("userMessageDraft restores command chips, goal chips, legacy quotes, and all attachment types", async () => {
  const pngData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const attachments: MessageAttachmentInfo[] = [
    { type: "image", name: "clipboard.png", mimeType: "image/png", data: pngData },
    { type: "image", name: "local.png", mimeType: "image/png", data: "", localPath: "C:\\Media\\local.png" },
    { type: "folder", name: "src", mimeType: "inode/directory", data: "", localPath: "C:\\Repo\\src" },
  ];
  const quote = { text: "quoted answer", messageId: "assistant-1" };
  const draft = userMessageDraft({
    content: "/skill:review inspect this\n\n> quoted answer",
    attachments,
    quote,
    goalId: "goal-1",
  }, { goalKickoff: true, goalLabel: "目标" });

  expect(draft.quote).toBeUndefined();
  expect(draft.text).toBe(`:qone-tool[目标]{name=qone-goal} :qone-command[skill:review] inspect this ${serializeInlineQuote(quote.text)} `);
  expect(draft.attachments).toHaveLength(3);
  expect(draft.attachments[0]?.file).toBeInstanceOf(File);

  const reparsed = extractComposerPrompt({
    role: "user",
    parentId: null,
    sourceId: null,
    runConfig: {},
    createdAt: new Date(),
    content: [{ type: "text", text: draft.text }],
    attachments: draft.attachments,
  } as AppendMessage);
  expect(reparsed.goal).toBe(true);
  expect(reparsed.text).toBe(`/skill:review inspect this ${serializeInlineQuote(quote.text)}`);

  const reserialized = await serializeMessageAttachments({
    role: "user",
    parentId: null,
    sourceId: null,
    runConfig: {},
    createdAt: new Date(),
    content: [],
    attachments: draft.attachments,
  } as AppendMessage);
  expect(reserialized).toEqual(attachments);
});

test("returnUserMessageToComposer sends session.truncate, restores message into composer, and focuses it", async () => {
  const runtime = createRuntime();
  const sent: RuntimeCommand[] = [];
  const pngData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  useStore.setState({
    connected: true,
    currentSessionId: "session-1",
    running: false,
    messages: [
      { id: "user-1", role: "user", content: "earlier", persisted: true, createdAt: 1 },
      { id: "assistant-1", role: "assistant", content: "reply", persisted: true, createdAt: 2 },
      {
        id: "user-2",
        role: "user",
        content: "为什么这个图层总出现？",
        persisted: true,
        attachments: [{ type: "image", name: "shot.png", mimeType: "image/png", data: pngData }],
        createdAt: 3,
      },
      { id: "assistant-2", role: "assistant", content: "answer 2", persisted: true, createdAt: 4 },
    ],
    chatRunError: { sessionId: "session-1", userMessageId: "user-2", detail: "boom" },
    send: async (cmd) => {
      sent.push(cmd);
      if (cmd.type === "session.truncate") {
        // 模拟运行时返回 session.messages 时，因 chatRunError 尚未清理而短暂保留 user-2，随后同批次收到 pong
        queueMicrotask(() => {
          useStore.setState((state) => ({ messages: state.messages.slice(0, 3) }));
          handleTruncateEvent({ type: "pong", requestId: cmd.requestId });
        });
      }
      return true;
    },
  });

  let focused = false;
  const ok = await returnUserMessageToComposer({
    sessionId: "session-1",
    messageId: "user-2",
    composer: getDraftComposer(runtime),
    isActive: () => true,
    focusComposer: () => { focused = true; },
  });

  expect(ok).toBe(true);
  expect(focused).toBe(true);
  expect(sent).toEqual([expect.objectContaining({ type: "session.truncate", sessionId: "session-1", messageId: "user-2" })]);
  expect(useStore.getState().messages.map((m) => m.id)).toEqual(["user-1", "assistant-1"]);
  expect(useStore.getState().chatRunError).toBeUndefined();
  expect(runtime.thread.composer.getState().text).toBe("为什么这个图层总出现？");
  expect(runtime.thread.composer.getState().attachments).toHaveLength(1);
});

test("returnUserMessageToComposer blocks when composer already has unsent draft", async () => {
  const runtime = createRuntime();
  runtime.thread.composer.setText("existing draft");
  const sent: RuntimeCommand[] = [];
  useStore.setState({
    connected: true,
    currentSessionId: "session-1",
    running: false,
    messages: [{ id: "user-1", role: "user", content: "sent", persisted: true, createdAt: 1 }],
    send: async (cmd) => { sent.push(cmd); return true; },
  });

  const ok = await returnUserMessageToComposer({
    sessionId: "session-1",
    messageId: "user-1",
    composer: getDraftComposer(runtime),
    isActive: () => true,
  });

  expect(ok).toBe(false);
  expect(sent).toHaveLength(0);
  expect(runtime.thread.composer.getState().text).toBe("existing draft");
  expect(useStore.getState().lastError).toBeTruthy();
});

test("returnUserMessageToComposer reverts unpersisted failed messages locally without backend truncate", async () => {
  const runtime = createRuntime();
  const sent: RuntimeCommand[] = [];
  useStore.setState({
    connected: true,
    currentSessionId: "session-1",
    running: false,
    messages: [{ id: "user-local", role: "user", content: "failed prompt", persisted: false, createdAt: 1 }],
    chatRunError: { sessionId: "session-1", userMessageId: "user-local", detail: "network error" },
    send: async (cmd) => { sent.push(cmd); return true; },
  });

  const ok = await returnUserMessageToComposer({
    sessionId: "session-1",
    messageId: "user-local",
    composer: getDraftComposer(runtime),
    isActive: () => true,
  });

  expect(ok).toBe(true);
  expect(sent).toHaveLength(0);
  expect(useStore.getState().messages).toEqual([]);
  expect(useStore.getState().chatRunError).toBeUndefined();
  expect(runtime.thread.composer.getState().text).toBe("failed prompt");
});
