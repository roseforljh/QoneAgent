import { expect, test } from "bun:test";
import type { AppendMessage } from "@assistant-ui/react";
import type { QueueItemInfo } from "@qone/protocol";
import { createQoneMessageQueue } from "../src/lib/qone-message-queue";
import { emptySessionState, queueEditsOnDisconnect, switchSessionState } from "../src/lib/session-execution-state";
import { useStore } from "../src/store";

const message = (text: string): AppendMessage => ({
  role: "user", parentId: null, sourceId: null, runConfig: {},
  createdAt: new Date(), metadata: { custom: {} },
  content: [{ type: "text", text }], attachments: [],
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(steer: Parameters<typeof createQoneMessageQueue>[0]["steer"] = async () => true) {
  let running = true;
  let snapshot: QueueItemInfo[] = [];
  const sent: Array<{ message: AppendMessage; id: string; attachments: unknown[] }> = [];
  const errors: string[] = [];
  const queue = createQoneMessageQueue({
    sessionId: "s", isRunning: () => running, steer,
    send: (message, id, attachments) => { sent.push({ message, id, attachments }); running = true; },
    sync: (items) => { snapshot = items; }, onError: (error) => errors.push(error),
  });
  return { queue, sent, errors, snapshot: () => snapshot, setRunning: (value: boolean) => { running = value; }, idle: () => { running = false; queue.controller.notifyIdle(); } };
}
const prompts = (f: ReturnType<typeof fixture>) => f.queue.adapter.items.map((item) => item.prompt);
const slowFile = (text: string, read: Promise<ArrayBuffer>) => {
  const file = new File(["input"], "source.txt", { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", { value: () => read });
  return { ...message(text), attachments: [{
    id: "file", type: "file" as const, name: file.name, contentType: file.type, file,
    status: { type: "complete" as const }, content: [],
  }] };
};

test("saving and cancelling an edit preserve its identity and surviving neighbors", async () => {
  const f = fixture();
  for (const text of ["A", "B", "C"]) f.queue.adapter.enqueue(message(text));
  await tick();
  const id = f.queue.adapter.items[1]!.id;
  const persistentId = f.queue.getPersistentId(id)!;
  expect(f.queue.beginEdit(id)).toBe(true);
  expect(prompts(f)).toEqual(["A", "C"]);
  expect(f.snapshot().find((item) => item.id === persistentId)?.status).toBe("scheduled");
  f.queue.adapter.enqueue(message("D"));
  f.queue.remove(f.queue.adapter.items[0]!.id);
  expect(f.queue.getItem(persistentId)?.position).toBe(0);
  expect(await f.queue.edit(id, message("B2"))).toBe(true);
  expect(prompts(f)).toEqual(["B2", "C", "D"]);
  const replacedId = f.queue.getLocalId(persistentId)!;
  expect(f.queue.beginEdit(replacedId)).toBe(true);
  f.queue.remove(f.queue.adapter.items[0]!.id);
  f.queue.cancelEdit();
  expect(prompts(f)).toEqual(["B2", "D"]);
  expect(f.queue.getPersistentId(f.queue.adapter.items[0]!.id)).toBe(persistentId);
});

test("editing the head does not block later queued messages", async () => {
  const f = fixture();
  f.queue.adapter.enqueue(message("editing"));
  f.queue.adapter.enqueue(message("next"));
  await tick();
  expect(f.queue.beginEdit(f.queue.adapter.items[0]!.id)).toBe(true);
  f.idle();
  await tick();
  expect(f.sent.map((item) => item.message.content)).toEqual([message("next").content]);
});

test("the edited attachment set is validated before an idle dispatch", async () => {
  const f = fixture();
  f.queue.adapter.enqueue(message("original"));
  await tick();
  const id = f.queue.adapter.items[0]!.id;
  const persistentId = f.queue.getPersistentId(id)!;
  f.queue.beginEdit(id);
  const read = deferred<ArrayBuffer>();
  const edited = slowFile("edited", read.promise);
  const save = f.queue.edit(id, edited);
  f.idle();
  await tick();
  expect(f.sent).toHaveLength(0);
  read.resolve(new TextEncoder().encode("changed bytes").buffer);
  expect(await save).toBe(true);
  await tick();
  expect(f.sent[0]?.id).toBe(persistentId);
  const mimeType = edited.attachments[0]!.contentType;
  expect(f.sent[0]?.attachments).toEqual([{ type: "file", name: "source.txt", mimeType, data: `data:${mimeType};base64,Y2hhbmdlZCBieXRlcw==` }]);
});

test("cancelling an edit invalidates an unfinished save without resurrecting its draft", async () => {
  const f = fixture();
  f.queue.adapter.enqueue(message("original"));
  await tick();
  const id = f.queue.adapter.items[0]!.id;
  f.queue.beginEdit(id);
  const read = deferred<ArrayBuffer>();
  const save = f.queue.edit(id, slowFile("cancelled", read.promise));
  f.queue.cancelEdit();
  read.resolve(new ArrayBuffer(0));
  expect(await save).toBe(false);
  expect(prompts(f)).toEqual(["original"]);
});

test("an invalid edit leaves the original detached and can be corrected", async () => {
  const f = fixture();
  f.queue.adapter.enqueue(message("original"));
  await tick();
  const id = f.queue.adapter.items[0]!.id;
  f.queue.beginEdit(id);
  const bad = { ...message("bad"), attachments: [{
    id: "bad", type: "image" as const, name: "bad.bmp", contentType: "image/bmp",
    status: { type: "complete" as const }, content: [{ type: "image" as const, image: "data:image/bmp;base64,AA==" }],
  }] };
  await expect(f.queue.edit(id, bad)).rejects.toThrow();
  f.idle();
  await tick();
  expect(f.sent).toHaveLength(0);
  expect(await f.queue.edit(id, message("corrected"))).toBe(true);
  await tick();
  expect(f.sent[0]?.attachments).toEqual([]);
  expect(f.sent[0]?.message.content).toEqual(message("corrected").content);
});

test("a failed read from a cancelled edit cannot restore the discarded edit draft", async () => {
  const f = fixture();
  f.queue.adapter.enqueue(message("original"));
  await tick();
  const id = f.queue.adapter.items[0]!.id;
  f.queue.beginEdit(id);
  const read = deferred<ArrayBuffer>();
  const save = f.queue.edit(id, slowFile("discarded", read.promise));
  f.queue.cancelEdit();
  read.reject(new Error("late read failure"));
  expect(await save).toBe(false);
  expect(prompts(f)).toEqual(["original"]);
});

test("invalid queued attachments are never silently dispatched and deleting them releases FIFO", async () => {
  const f = fixture();
  const bad = { ...message("bad"), attachments: [{
    id: "bad", type: "file" as const, name: "missing.txt", contentType: "text/plain",
    status: { type: "complete" as const }, content: [],
  }] };
  f.queue.adapter.enqueue(bad);
  f.queue.adapter.enqueue(message("next"));
  await tick();
  f.idle();
  await tick();
  expect(f.errors).toHaveLength(1);
  expect(f.sent).toHaveLength(0);
  f.queue.remove(f.queue.adapter.items[0]!.id);
  await tick();
  expect(f.sent[0]?.message.content).toEqual(message("next").content);
});

test("deleting a file still being prepared does not wait for its bytes to dispatch the next input", async () => {
  const f = fixture();
  const read = deferred<ArrayBuffer>();
  f.queue.adapter.enqueue(slowFile("same", read.promise));
  f.queue.adapter.enqueue(message("same"));
  f.queue.remove(f.queue.adapter.items[0]!.id);
  f.idle();
  await tick();
  expect(f.sent).toHaveLength(1);
  read.resolve(new ArrayBuffer(0));
  await tick();
  expect(f.sent).toHaveLength(1);
  expect(f.snapshot()).toEqual([]);
});

test("multiple steering inputs keep click order and restore their original order on run end", async () => {
  const requests: string[] = [];
  const f = fixture(async (input) => { requests.push(input.content[0]?.type === "text" ? input.content[0].text : ""); return true; });
  for (const text of ["A", "B", "C"]) f.queue.adapter.enqueue(message(text));
  await tick();
  const [a, b] = f.queue.adapter.items;
  const aId = f.queue.getPersistentId(a!.id)!;
  const bId = f.queue.getPersistentId(b!.id)!;
  f.queue.adapter.move(b!.id, { lane: "steer", insertAfter: null });
  f.queue.adapter.move(a!.id, { lane: "steer", insertAfter: null });
  await tick();
  expect(requests).toEqual(["B", "A"]);
  expect(f.queue.adapter.steerItems.map((item) => item.prompt)).toEqual(requests);
  f.queue.settleSteer(bId, false);
  f.queue.settleSteer(aId, false);
  expect(prompts(f)).toEqual(["A", "B", "C"]);
  expect(f.snapshot().map((item) => item.text)).toEqual(["A", "B", "C"]);
});

test("steerNow submits directly to the active run instead of the FIFO lane", async () => {
  const requests: string[] = [];
  const f = fixture(async (input) => {
    requests.push(input.content[0]?.type === "text" ? input.content[0].text : "");
    return true;
  });
  f.queue.adapter.enqueue(message("direct"));
  await tick();
  const localId = f.queue.adapter.items[0]!.id;
  f.queue.steerNow(localId);
  await tick();
  expect(requests).toEqual(["direct"]);
  expect(f.queue.adapter.items).toEqual([]);
  expect(f.queue.adapter.steerItems.map((item) => item.prompt)).toEqual(["direct"]);
});

test("steerNow falls back to FIFO after the active run becomes terminal", async () => {
  const f = fixture();
  f.queue.adapter.enqueue(message("after stop"));
  await tick();
  const localId = f.queue.adapter.items[0]!.id;
  f.setRunning(false);
  f.queue.steerNow(localId);
  expect(f.queue.adapter.steerItems).toHaveLength(0);
  expect(f.queue.adapter.items.map((item) => item.prompt)).toEqual(["after stop"]);
  f.queue.controller.notifyIdle();
  await tick();
  expect(f.sent.map((item) => item.message.content[0])).toEqual([{ type: "text", text: "after stop" }]);
});

test("confirmed delivery before request acknowledgement cannot be undone by a late rejection", async () => {
  const ack = deferred<boolean>();
  const f = fixture(() => ack.promise);
  f.queue.adapter.enqueue(message("steer"));
  await tick();
  const localId = f.queue.adapter.items[0]!.id;
  const persistentId = f.queue.getPersistentId(localId)!;
  f.queue.adapter.move(localId, { lane: "steer", insertAfter: null });
  await tick();
  f.queue.settleSteer(persistentId, true);
  ack.resolve(false);
  await tick();
  expect(f.snapshot()).toEqual([]);
  expect(f.queue.adapter.steerItems).toEqual([]);
  expect(f.queue.getLocalId(persistentId)).toBeUndefined();
});

test("an unknown acknowledgement waits for confirmation rather than resending", async () => {
  const f = fixture(async () => undefined);
  f.queue.adapter.enqueue(message("steer"));
  await tick();
  const localId = f.queue.adapter.items[0]!.id;
  const persistentId = f.queue.getPersistentId(localId)!;
  f.queue.adapter.move(localId, { lane: "steer", insertAfter: null });
  await tick();
  f.idle();
  await tick();
  expect(f.sent).toHaveLength(0);
  expect(f.queue.adapter.steerItems).toHaveLength(1);
  f.queue.settleSteer(persistentId, false);
  await tick();
  expect(f.sent).toHaveLength(1);
});

test("a late rejection from an earlier attempt cannot roll back a new steering attempt", async () => {
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  let attempts = 0;
  const f = fixture(() => ++attempts === 1 ? first.promise : second.promise);
  f.queue.adapter.enqueue(message("steer"));
  await tick();
  const localId = f.queue.adapter.items[0]!.id;
  const persistentId = f.queue.getPersistentId(localId)!;
  f.queue.adapter.move(localId, { lane: "steer", insertAfter: null });
  await tick();
  f.queue.settleSteer(persistentId, false);
  f.queue.adapter.move(localId, { lane: "steer", insertAfter: null });
  first.resolve(false);
  await tick();
  expect(attempts).toBe(2);
  expect(f.queue.adapter.steerItems).toHaveLength(1);
  expect(f.queue.adapter.items).toHaveLength(0);
  second.resolve(true);
  await tick();
  f.queue.settleSteer(persistentId, true);
});

test("reconnecting while editing detaches the recovery copy before dispatch can begin", async () => {
  const f = fixture();
  f.queue.adapter.enqueue(message("original"));
  f.queue.adapter.enqueue(message("next"));
  await tick();
  const id = f.queue.adapter.items[0]!.id;
  const persistentId = f.queue.getPersistentId(id)!;
  f.queue.beginEdit(id);
  const recovery = f.snapshot();
  f.queue.suspend();
  f.idle();
  await tick();
  expect(f.sent).toEqual([]);
  const sent: string[] = [];
  const reconnected = createQoneMessageQueue({
    sessionId: "s", isRunning: () => false, steer: async () => true, sync: () => {},
    send: (message) => { sent.push(message.content[0]?.type === "text" ? message.content[0].text : ""); },
  });
  reconnected.restore(recovery, persistentId);
  await tick();
  expect(sent).toEqual(["next"]);
  expect(reconnected.getItem(persistentId)?.text).toBe("original");
  expect(await reconnected.edit(reconnected.getLocalId(persistentId)!, message("modified"))).toBe(true);
  reconnected.controller.notifyIdle();
  await tick();
  expect(sent).toEqual(["next", "modified"]);
});

test("runtime disconnect retains edits in their own sessions while clearing execution state", () => {
  const current: QueueItemInfo = { id: "q-a", sessionId: "a", text: "a", lane: "queue", status: "scheduled", position: 0, createdAt: 1, updatedAt: 1 };
  const other = { ...current, id: "q-b", sessionId: "b", text: "b" };
  const patch = queueEditsOnDisconnect({ editingQueueItem: current, backgroundSessions: {
    b: { ...emptySessionState(), editingQueueItem: other, running: true, activeRunId: "ended" },
    c: { ...emptySessionState(), running: true },
  } });
  expect(patch.editingQueueItem).toBe(current);
  expect(patch.backgroundSessions.b?.editingQueueItem).toBe(other);
  expect(patch.backgroundSessions.b?.running).toBe(false);
  expect(patch.backgroundSessions.c).toBeUndefined();
  const selected = switchSessionState({ ...useStore.getState(), ...patch, currentSessionId: "a" }, "b");
  expect(selected.editingQueueItem).toBe(other);
});

test("unprepared file input is not persisted as a text-only message", async () => {
  const f = fixture();
  const read = deferred<ArrayBuffer>();
  f.queue.adapter.enqueue(slowFile("file required", read.promise));
  const id = f.queue.adapter.items[0]!.id;
  expect(f.snapshot()).toEqual([]);
  read.resolve(new TextEncoder().encode("bytes").buffer);
  await tick();
  expect(f.snapshot()[0]?.attachments).toHaveLength(1);
  expect(f.queue.getPersistentId(id)).toBe(f.snapshot()[0]?.id);
});
