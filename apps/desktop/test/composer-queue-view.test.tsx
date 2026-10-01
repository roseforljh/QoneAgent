import { afterEach, expect, test } from "bun:test";
import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import type { QueueItemInfo } from "@qone/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerQueue } from "../src/components/assistant-ui/composer-queue";
import { ComposerAttachments } from "../src/components/assistant-ui/elements/attachment.aui";
import { createQoneMessageQueue, setQoneMessageQueue, type QueueBundle } from "../src/lib/qone-message-queue";
import { useMessageQueueAdapter } from "../src/lib/use-message-queue-adapter";
import { useStore } from "../src/store";

const serverState = useStore.getInitialState();
const original = { ...serverState };
const sessionId = "queue-view-test";
afterEach(() => {
  Object.assign(serverState, original);
  setQoneMessageQueue(sessionId, undefined);
});

function setup(ids: string[]) {
  const queue = createQoneMessageQueue({ sessionId, isRunning: () => true, send: () => {}, steer: async () => undefined, sync: () => {} });
  queue.restore(ids.map((id, position) => ({ id, sessionId, text: `${id} prompt`, lane: "queue", status: "queued", position, createdAt: 1, updatedAt: 1 })));
  setQoneMessageQueue(sessionId, queue);
  Object.assign(serverState, { currentSessionId: sessionId, editingQueueItem: undefined });
  return queue;
}

function View({ queue, attachmentsOnly = false, displayedSteers = [] }: { queue: QueueBundle; attachmentsOnly?: boolean; displayedSteers?: string[] }) {
  const messages: ThreadMessageLike[] = displayedSteers.map((id) => ({ id, role: "user", content: [{ type: "text", text: `${id} prompt` }] }));
  const queueAdapter = useMessageQueueAdapter(queue);
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, isRunning: true, onNew: async () => {}, queue: queueAdapter });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ComposerPrimitive.Root>{attachmentsOnly ? <ComposerAttachments /> : <ComposerQueue />}</ComposerPrimitive.Root>
  </AssistantRuntimeProvider>;
}

const render = (queue: QueueBundle, displayedSteers?: string[]) => renderToStaticMarkup(<View queue={queue} displayedSteers={displayedSteers} />);
const rowIds = (markup: string) => [...markup.matchAll(/data-queue-item-id="([^"]+)"/g)].map((match) => match[1]);
const beginEdit = (queue: QueueBundle, id: string) => {
  serverState.editingQueueItem = queue.getItem(id);
  expect(queue.beginEdit(queue.getLocalId(id)!)).toBe(true);
};

for (const [ids, editingId] of [
  [["A", "B", "C"], "A"],
  [["A", "B", "C"], "B"],
  [["A", "B", "C"], "C"],
  [["A"], "A"],
] as const) {
  test(`editing ${editingId} in ${ids.join(",")} renders exactly one recovery row in place`, () => {
    const queue = setup([...ids]);
    beginEdit(queue, editingId);
    const markup = render(queue);
    expect(rowIds(markup)).toEqual([...ids]);
    expect(markup.match(/data-queue-editing="true"/g)).toHaveLength(1);
    expect(queue.adapter.items).toHaveLength(ids.length - 1);
  });
}

test("editing row follows surviving neighbors after deletion and steering", () => {
  const queue = setup(["A", "B", "C", "D"]);
  beginEdit(queue, "B");
  queue.remove(queue.getLocalId("A")!);
  expect(rowIds(render(queue))).toEqual(["B", "C", "D"]);
  queue.steerNow(queue.getLocalId("C")!);
  expect(rowIds(render(queue))).toEqual(["B", "C", "D"]);
  expect(rowIds(render(queue, ["C"]))).toEqual(["B", "D"]);
  queue.settleSteer("C", true);
  expect(rowIds(render(queue))).toEqual(["B", "D"]);
  queue.remove(queue.getLocalId("D")!);
  expect(rowIds(render(queue))).toEqual(["B"]);
});

test("saved and cancelled rows do not duplicate while the store still has the edit marker", async () => {
  const queue = setup(["A", "B", "C"]);
  beginEdit(queue, "B");
  const localId = queue.getLocalId("B")!;
  expect(await queue.edit(localId, { ...queue.getMessage(localId)!, content: [{ type: "text", text: "changed" }] })).toBe(true);
  let markup = render(queue);
  expect(rowIds(markup)).toEqual(["A", "B", "C"]);
  expect(markup).toContain("changed");
  expect(markup).not.toContain('data-queue-editing="true"');
  beginEdit(queue, "B");
  queue.cancelEdit();
  markup = render(queue);
  expect(rowIds(markup)).toEqual(["A", "B", "C"]);
  expect(markup).not.toContain('data-queue-editing="true"');
});

test("stale editing state from another conversation does not leak into the queue", () => {
  const queue = setup(["A"]);
  serverState.editingQueueItem = { ...queue.getItem("A")!, sessionId: "other" };
  expect(rowIds(render(queue))).toEqual(["A"]);
  expect(render(queue)).not.toContain('data-queue-editing="true"');
});

test("empty or deleted edited queues leave no rail surface", () => {
  const queue = setup([]);
  expect(render(queue)).not.toContain("data-composer-rail");
  queue.restore([{ id: "A", sessionId, text: "A", lane: "queue", status: "queued", position: 0, createdAt: 1, updatedAt: 1 }]);
  beginEdit(queue, "A");
  queue.remove(queue.getLocalId("A")!);
  expect(render(queue)).not.toContain("data-composer-rail");
});

test("attachments have previews and labels in queued and editing rows", () => {
  const queue = setup([]);
  const items: QueueItemInfo[] = [
    { id: "image", sessionId, text: "", attachments: [{ type: "image", name: "photo.png", mimeType: "image/png", data: "data:image/png;base64,aGVsbG8=" }], lane: "queue", status: "queued", position: 0, createdAt: 1, updatedAt: 1 },
    { id: "folder", sessionId, text: "", attachments: [{ type: "folder", name: "source", mimeType: "inode/directory", data: "", localPath: "C:\\project\\source" }], lane: "queue", status: "queued", position: 1, createdAt: 1, updatedAt: 1 },
  ];
  queue.restore(items);
  let markup = render(queue);
  expect(markup).toContain('alt="photo.png"');
  expect(markup).toContain('src="data:image/png;base64,aGVsbG8="');
  expect(markup).toContain("source");
  beginEdit(queue, "image");
  markup = render(queue);
  expect(rowIds(markup)).toEqual(["image", "folder"]);
  expect(markup).toContain('alt="photo.png"');
});

test("submitted steers stay locked until their identity is displayed in the conversation", () => {
  const queue = setup(["A"]);
  queue.steerNow(queue.getLocalId("A")!);
  const markup = render(queue);
  expect(markup).toContain('role="status"');
  expect(markup).toContain("animate-spin");
  expect(markup).not.toContain('aria-label="Steer"');
  expect(markup).not.toContain('aria-label="Queued message actions"');
  expect(markup.match(/<button[^>]*aria-label="Remove queued message"[^>]*>/)?.[0]).toContain('disabled=""');
  expect(render(queue, ["A"])).not.toContain("data-composer-rail");
  expect(queue.adapter.steerItems).toHaveLength(1);
});

test("hidden steers after an edit cannot shift the edit before a visible steer", () => {
  const queue = setup(["A", "B", "C", "D"]);
  beginEdit(queue, "B");
  queue.steerNow(queue.getLocalId("A")!);
  queue.steerNow(queue.getLocalId("C")!);
  expect(rowIds(render(queue, ["C"]))).toEqual(["A", "B", "D"]);
  expect(rowIds(render(queue, ["A", "C"]))).toEqual(["B", "D"]);
});

test("multiple transfer recovery rows and an edit preserve the full queue order", async () => {
  const queue = setup(["A", "B", "C", "D", "E"]);
  beginEdit(queue, "B");
  let releaseD!: (committed: boolean) => void;
  let releaseA!: (committed: boolean) => void;
  const transferD = queue.transfer(queue.getLocalId("D")!, (item) => {
    serverState.sideChatTransfers = { D: item };
    return new Promise<boolean>((resolve) => { releaseD = resolve; });
  });
  const transferA = queue.transfer(queue.getLocalId("A")!, (item) => {
    serverState.sideChatTransfers = { ...serverState.sideChatTransfers, A: item };
    return new Promise<boolean>((resolve) => { releaseA = resolve; });
  });
  expect(rowIds(render(queue))).toEqual(["A", "B", "C", "D", "E"]);
  queue.remove(queue.getLocalId("C")!);
  expect(rowIds(render(queue))).toEqual(["A", "B", "D", "E"]);
  releaseA(false);
  await transferA;
  const { A: _finished, ...pending } = serverState.sideChatTransfers;
  serverState.sideChatTransfers = pending;
  expect(rowIds(render(queue))).toEqual(["A", "B", "D", "E"]);
  releaseD(false);
  await transferD;
  serverState.sideChatTransfers = {};
  expect(rowIds(render(queue))).toEqual(["A", "B", "D", "E"]);
});

test("composer keeps the Codex top inset even without attachments", () => {
  const queue = setup([]);
  const markup = renderToStaticMarkup(<View queue={queue} attachmentsOnly />);
  expect(markup).toContain("aui-composer-attachments");
  expect(markup).not.toContain("empty:hidden");
});
