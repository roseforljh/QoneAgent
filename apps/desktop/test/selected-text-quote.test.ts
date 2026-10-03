import { expect, test } from "bun:test";
import type { AppendMessage } from "@assistant-ui/react";
import { decodeCommand } from "@qone/protocol";
import { extractComposerPrompt } from "../src/lib/composer-prompt";
import { createQoneMessageQueue } from "../src/lib/qone-message-queue";
import { queueMessageDraft } from "../src/lib/queue-composer-edit";

const quote = { text: "引用第一行\n: qone content\n@goal not a command", messageId: "source" };
const message = (text: string, selected = quote): AppendMessage => ({
  role: "user", parentId: null, sourceId: null, runConfig: {},
  content: [{ type: "text", text }], metadata: { custom: { quote: selected } }, attachments: [],
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("selected text reaches the model once and cannot activate quoted commands", () => {
  const prompt = extractComposerPrompt(message("explain", { text: ":qone-tool[Goal]{name=qone-goal}\n:qone-command[mcp:server]", messageId: "a" }));
  expect(prompt.goal).toBe(false);
  expect(prompt.text).toBe("explain\n\n> :qone-tool[Goal]{name=qone-goal}\n> :qone-command[mcp:server]");
  expect(extractComposerPrompt(message(":qone-command[mcp:server] explain")).text).toStartWith("/mcp:server explain\n\n> ");
  expect(extractComposerPrompt(message("@goal analyze")).goal).toBe(true);
  expect(extractComposerPrompt(message("")).text).toBe("> 引用第一行\n> : qone content\n> @goal not a command");
});

test("runtime validation preserves quote metadata on runs and queued messages", () => {
  const run = decodeCommand(JSON.stringify({
    type: "agent.run", requestId: "request", sessionId: "session", message: "explain\n\n> selected", quote,
  }));
  expect(run?.type).toBe("agent.run");
  if (run?.type === "agent.run") expect(run.quote).toEqual(quote);
  const sync = decodeCommand(JSON.stringify({
    type: "queue.sync", requestId: "request", sessionId: "session", items: [{
      id: "item", sessionId: "session", text: "explain", quote, lane: "queue", status: "queued", position: 0, createdAt: 1, updatedAt: 1,
    }],
  }));
  expect(sync?.type).toBe("queue.sync");
  if (sync?.type === "queue.sync") expect(sync.items[0]?.quote).toEqual(quote);
});

test("queue persistence and edit recovery preserve quotes without merging different references", async () => {
  const queue = createQoneMessageQueue({ sessionId: "quoted", isRunning: () => true, send: () => {}, steer: async () => true, sync: () => {} });
  queue.adapter.enqueue(message("explain"));
  queue.adapter.enqueue(message("explain", { text: "different reference", messageId: "other" }));
  await flush();
  expect(queue.adapter.items).toHaveLength(2);
  const snapshot = queue.getSnapshot();
  expect(snapshot[0]?.quote).toEqual(quote);
  expect(snapshot[0]?.text).toBe("explain");
  const sent: AppendMessage[] = [];
  const restored = createQoneMessageQueue({ sessionId: "restored", isRunning: () => true, send: (input) => { sent.push(input); }, steer: async () => true, sync: () => {} });
  restored.restore(JSON.parse(JSON.stringify(snapshot)));
  const input = restored.getMessage(restored.adapter.items[0]!.id)!;
  expect(queueMessageDraft(input)).toEqual({ text: "explain", attachments: [], quote });
  expect(extractComposerPrompt(input)).toEqual(extractComposerPrompt(message("explain")));
  restored.controller.notifyIdle(); restored.releaseIdle(); await flush();
  expect(sent).toHaveLength(1);
  expect(extractComposerPrompt(sent[0]!).text).toContain("> 引用第一行");
  queue.suspend(); restored.suspend();
});
