import { expect, test } from "bun:test";
import type { AppendMessage } from "@assistant-ui/react";
import type { QueueItemInfo } from "@qone/protocol";
import { createQoneMessageQueue } from "../src/lib/qone-message-queue";

const message = (text: string): AppendMessage => ({ role: "user", parentId: null, sourceId: null, runConfig: {}, createdAt: new Date(), metadata: { custom: {} }, content: [{ type: "text", text }], attachments: [] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { resolve, reject, promise };
}
function fixture() {
  let running = true;
  let snapshot: QueueItemInfo[] = [];
  const sent: string[] = [];
  const steered: string[] = [];
  const queue = createQoneMessageQueue({
    sessionId: "parent", isRunning: () => running, getActiveRunId: () => "parent-run",
    send: (input) => { sent.push(input.content[0]?.type === "text" ? input.content[0].text : ""); running = true; },
    steer: async (input) => { steered.push(input.content[0]?.type === "text" ? input.content[0].text : ""); return true; },
    sync: (items) => { snapshot = items; },
  });
  return { queue, sent, steered, snapshot: () => snapshot, idle: () => { running = false; queue.controller.notifyIdle(); } };
}

test("ordinary running submissions always remain in FIFO, including assistant-ui steer calls", async () => {
  const f = fixture();
  f.queue.adapter.steer(message("waiting")); await tick();
  const waitingId = f.queue.getPersistentId(f.queue.adapter.items[0]!.id);
  f.queue.adapter.steer({ ...message("live input"), steer: true }); await tick();
  expect(f.steered).toEqual([]);
  expect(f.queue.adapter.items.map((item) => item.prompt)).toEqual(["waiting", "live input"]);
  expect(f.queue.getPersistentId(f.queue.adapter.items[0]!.id)).toBe(waitingId);
});

test("an ordinary submission still starts the run when idle", async () => {
  const f = fixture(); f.idle();
  f.queue.adapter.steer(message("idle input")); await tick();
  expect(f.sent).toEqual(["idle input"]); expect(f.steered).toEqual([]);
});

test("the explicit row steer path is separate from ordinary composer submission", async () => {
  const f = fixture();
  f.queue.adapter.enqueue(message("waiting"));
  await tick();
  expect(f.steered).toEqual([]);
  const localId = f.queue.adapter.items[0]!.id;
  f.queue.steerNow(localId);
  await tick();
  expect(f.steered).toEqual(["waiting"]);
  expect(f.queue.adapter.items).toEqual([]);
});

test("side transfer detaches only its input and does not block the parent's next run", async () => {
  const f = fixture();
  for (const text of ["A", "B"]) f.queue.adapter.enqueue(message(text)); await tick();
  const localId = f.queue.adapter.items[0]!.id;
  const id = f.queue.getPersistentId(localId)!;
  const pending = deferred<boolean>();
  const result = f.queue.transfer(localId, () => pending.promise);
  expect(f.queue.getItem(id)?.status).toBe("scheduled");
  expect(f.queue.beginEdit(localId)).toBe(false);
  f.queue.remove(localId); f.queue.steerNow(localId);
  expect(await f.queue.edit(localId, message("overwrite"))).toBe(false);
  f.idle(); await tick(); expect(f.sent).toEqual(["B"]);
  pending.resolve(true); expect(await result).toBe(true);
  expect(f.queue.getItem(id)).toBeUndefined(); expect(f.snapshot()).toEqual([]);
});

test("rejected side transfer restores original identity, complete attachments and surviving position", async () => {
  const f = fixture();
  f.queue.restore(["A", "B", "C"].map((text, position) => ({
    id: text, sessionId: "parent", text, position, lane: "queue", status: "queued", createdAt: position + 1, updatedAt: position + 1,
    attachments: text === "B" ? [{ type: "folder", name: "src", mimeType: "inode/directory", data: "", localPath: "C:\\repo\\src" }] : undefined,
  })));
  const pending = deferred<boolean>();
  const result = f.queue.transfer(f.queue.getLocalId("B")!, () => pending.promise);
  f.queue.remove(f.queue.getLocalId("A")!); f.queue.adapter.enqueue(message("D")); await tick();
  pending.reject(new Error("creation failed"));
  await expect(result).rejects.toThrow("creation failed");
  expect(f.queue.adapter.items.map((item) => item.prompt)).toEqual(["B", "C", "D"]);
  expect(f.queue.getItem("B")?.attachments?.[0]?.localPath).toBe("C:\\repo\\src");
  expect(f.queue.getItem("B")?.status).toBe("queued");
});

test("simultaneous side transfer failures restore ordering even in reverse response order", async () => {
  const f = fixture();
  for (const text of ["A", "B", "C"]) f.queue.adapter.enqueue(message(text)); await tick();
  const ids = f.queue.adapter.items.map((item) => item.id);
  const a = deferred<boolean>(); const b = deferred<boolean>();
  const first = f.queue.transfer(ids[0]!, () => a.promise);
  const second = f.queue.transfer(ids[1]!, () => b.promise);
  expect(await f.queue.transfer(ids[0]!, async () => true)).toBe(false);
  b.resolve(false); await second; a.resolve(false); await first;
  expect(f.queue.adapter.items.map((item) => item.prompt)).toEqual(["A", "B", "C"]);
});

test("transfer restoration follows an edited neighbor's new local identity", async () => {
  const f = fixture();
  for (const text of ["A", "B", "C"]) f.queue.adapter.enqueue(message(text)); await tick();
  const [a, b] = f.queue.adapter.items;
  const pending = deferred<boolean>();
  const transfer = f.queue.transfer(b!.id, () => pending.promise);
  expect(f.queue.beginEdit(a!.id)).toBe(true);
  expect(await f.queue.edit(a!.id, message("edited A"))).toBe(true);
  f.queue.remove(f.queue.adapter.items.find((item) => item.prompt === "C")!.id);
  pending.resolve(false); await transfer;
  expect(f.queue.adapter.items.map((item) => item.prompt)).toEqual(["edited A", "B"]);
});
