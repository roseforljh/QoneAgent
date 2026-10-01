import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import type { ExternalStoreAdapter } from "@assistant-ui/react";
import { createQoneMessageQueue } from "../src/lib/qone-message-queue";
import { beginQueueComposerEdit, queueMessageDraft } from "../src/lib/queue-composer-edit";
import { getDraftComposer } from "../src/lib/composer-draft-runtime";
import { bindComposerDrafts, ComposerDraftStore } from "../src/lib/composer-drafts";
import { serializeMessageAttachments } from "../src/lib/message-attachments";
import { QoneAttachmentAdapter } from "../src/lib/file-attachment-adapter";

const reactDist = dirname(Bun.resolveSync("@assistant-ui/react", import.meta.dir));
const { ExternalStoreRuntimeCore } = await import(join(reactDist, "legacy-runtime/runtime-cores/external-store/ExternalStoreRuntimeCore.js"));
const { AssistantRuntimeImpl } = await import(join(reactDist, "legacy-runtime/runtime/AssistantRuntime.js"));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("editing restores every native attachment atomically and keeps changed chips across a session switch", async () => {
  const queue = createQoneMessageQueue({ sessionId: "a", isRunning: () => true, send: () => {}, steer: async () => true, sync: () => {} });
  const files = [
    { type: "image" as const, name: "plot.png", mimeType: "image/png", data: "", localPath: "C:\\Media\\plot.png" },
    { type: "file" as const, name: "archive.zip", mimeType: "application/zip", data: "", localPath: "C:\\Media\\archive.zip" },
    { type: "folder" as const, name: "source", mimeType: "inode/directory", data: "", localPath: "C:\\Media\\source" },
  ];
  queue.restore([{ id: "queued", sessionId: "a", text: "inspect", attachments: files, lane: "queue", status: "queued", position: 0, createdAt: 1, updatedAt: 1 }]);
  const adapter = (id: string): ExternalStoreAdapter => ({
    messages: [], isRunning: true, onNew: async () => {}, queue: id === "a" ? queue.adapter : undefined,
    adapters: { attachments: new QoneAttachmentAdapter(), threadList: { threadId: id, threads: ["a", "b"].map((id) => ({ id, status: "regular" as const })) } },
  });
  const core = new ExternalStoreRuntimeCore(adapter("a"));
  const runtime = new AssistantRuntimeImpl(core);
  const drafts = new ComposerDraftStore();
  let selected = "a";
  let dispose = bindComposerDrafts(runtime, "a", () => selected === "a", drafts);
  const localId = queue.getLocalId("queued")!;
  const originalChips = queue.getMessage(localId)!.attachments!;
  expect(beginQueueComposerEdit(queue, localId, getDraftComposer(runtime))?.id).toBe("queued");
  expect(runtime.thread.composer.getState().attachments).toBe(originalChips);
  await runtime.thread.composer.getAttachmentByIndex(1).remove();
  runtime.thread.composer.setText("edited");
  selected = "b";
  core.setAdapter(adapter("b"));
  dispose();
  dispose = bindComposerDrafts(runtime, "b", () => selected === "b", drafts);
  expect(runtime.thread.composer.getState().text).toBe("");
  selected = "a";
  core.setAdapter(adapter("a"));
  dispose();
  dispose = bindComposerDrafts(runtime, "a", () => selected === "a", drafts);
  const edited = { ...queue.getMessage(localId)!, content: [{ type: "text" as const, text: runtime.thread.composer.getState().text }], attachments: runtime.thread.composer.getState().attachments as typeof originalChips };
  expect(await serializeMessageAttachments(edited)).toEqual([files[0], files[2]]);
  expect(await queue.edit(localId, edited)).toBe(true);
  await tick();
  expect(queue.getItem("queued")?.attachments).toEqual([files[0], files[2]]);
  dispose();
});

test("editing cannot overwrite an existing composer draft", () => {
  const queue = createQoneMessageQueue({ sessionId: "a", isRunning: () => true, send: () => {}, steer: async () => true, sync: () => {} });
  queue.restore([{ id: "queued", sessionId: "a", text: "queued", lane: "queue", status: "queued", position: 0, createdAt: 1, updatedAt: 1 }]);
  const core = new ExternalStoreRuntimeCore({ messages: [], isRunning: true, onNew: async () => {}, queue: queue.adapter });
  const runtime = new AssistantRuntimeImpl(core);
  runtime.thread.composer.setText("unsent draft");
  expect(beginQueueComposerEdit(queue, queue.getLocalId("queued")!, getDraftComposer(runtime))).toBeUndefined();
  expect(runtime.thread.composer.getState().text).toBe("unsent draft");
  expect(queue.adapter.items).toHaveLength(1);
});

test("an edit draft keeps original whitespace and its quoted source", () => {
  const quote = { text: "quoted answer", messageId: "assistant" };
  const draft = queueMessageDraft({
    role: "user", parentId: null, sourceId: null, runConfig: {}, createdAt: new Date(),
    content: [{ type: "text", text: "  edit\n\n" }], attachments: [], metadata: { custom: { quote } },
  });
  expect(draft.text).toBe("  edit\n\n");
  expect(draft.quote).toEqual(quote);
});
