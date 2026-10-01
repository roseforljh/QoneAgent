import { expect, test } from "bun:test";
import type { AppendMessage } from "@assistant-ui/react";
import { createQoneMessageQueue } from "../src/lib/qone-message-queue";
import { translateCurrent } from "../src/localization";

const message = (text: string): AppendMessage => ({
  role: "user",
  parentId: null,
  sourceId: null,
  runConfig: {},
  createdAt: new Date(),
  metadata: { custom: {} },
  content: [{ type: "text", text }],
  attachments: [],
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test("running sends merge adjacent identical submissions and keep FIFO for different prompts", async () => {
  let running = true;
  const sent: string[] = [];
  let latest: readonly { id: string; text: string }[] = [];
  const queue = createQoneMessageQueue({
    sessionId: "s",
    isRunning: () => running,
    send: (item, id) => sent.push(`${id}:${item.content[0]?.type === "text" ? item.content[0].text : ""}`),
    steer: async () => true,
    sync: (items) => { latest = items.map((item) => ({ id: item.id, text: item.text })); },
  });

  queue.adapter.enqueue(message("same"));
  queue.adapter.enqueue(message("same"));
  queue.adapter.enqueue(message("next"));
  expect(queue.adapter.items).toHaveLength(2);
  expect(new Set(latest.map((item) => item.id)).size).toBe(2);
  const firstId = latest[0]!.id;
  const secondId = latest[1]!.id;

  running = false;
  queue.controller.notifyIdle();
  await flush();
  expect(sent[0]).toBe(`${firstId}:same`);
  queue.controller.notifyIdle();
  await flush();
  expect(sent[1]).toBe(`${secondId}:next`);
});

test("idle queue dispatches one follow-up at a time across asynchronous preparation", async () => {
  let running = true;
  const sent: string[] = [];
  const queue = createQoneMessageQueue({
    sessionId: "s", isRunning: () => running,
    send: (item) => {
      sent.push(item.content[0]?.type === "text" ? item.content[0].text : "");
      running = true;
    },
    steer: async () => true, sync: () => {},
  });
  queue.adapter.enqueue(message("first"));
  queue.adapter.enqueue(message("second"));
  running = false;
  queue.controller.notifyIdle();
  await flush();
  expect(sent).toEqual(["first"]);
  expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["second"]);
  running = false;
  queue.controller.notifyIdle();
  await flush();
  expect(sent).toEqual(["first", "second"]);
});

test("editing holds the item and saves in place, while cancelling resumes the original item", async () => {
  let running = true;
  const sent: string[] = [];
  let latest: { id: string; text: string } | undefined;
  const queue = createQoneMessageQueue({
    sessionId: "s",
    isRunning: () => running,
    send: (item, id) => sent.push(`${id}:${item.content[0]?.type === "text" ? item.content[0].text : ""}`),
    steer: async () => true,
    sync: (items) => { latest = items[0] ? { id: items[0].id, text: items[0].text } : undefined; },
  });

  queue.adapter.enqueue(message("before"));
  const localId = queue.getLocalId(latest!.id)!;
  const persistentId = latest.id;
  expect(queue.beginEdit(localId)).toBe(true);
  running = false;
  queue.controller.notifyIdle();
  await flush();
  expect(sent).toEqual([]);

  queue.edit(localId, message("after"));
  await flush();
  expect(sent).toEqual([`${persistentId}:after`]);

  running = true;
  queue.adapter.enqueue(message("keep"));
  const keepId = queue.getLocalId(latest!.id)!;
  const keepPersistentId = latest.id;
  expect(queue.beginEdit(keepId)).toBe(true);
  queue.cancelEdit();
  running = false;
  queue.controller.notifyIdle();
  await flush();
  expect(sent.at(-1)).toBe(`${keepPersistentId}:keep`);
});

test("failed native steering returns the item to its original queue position", async () => {
  let running = true;
  let rejectSteer: ((value: boolean) => void) | undefined;
  const queue = createQoneMessageQueue({
    sessionId: "s",
    isRunning: () => running,
    send: () => {},
    steer: () => new Promise<boolean>((resolve) => { rejectSteer = resolve; }),
    sync: () => {},
  });
  queue.adapter.enqueue(message("A"));
  queue.adapter.enqueue(message("B"));
  const second = queue.adapter.items[1]!.id;
  queue.adapter.move(second, { lane: "steer", insertAfter: null });
  expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["A"]);
  await flush();
  rejectSteer!(false);
  await flush();
  expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["A", "B"]);
});

test("accepted steering remains pending until Pi delivers the user turn", async () => {
  let persistentId = "";
  const queue = createQoneMessageQueue({
    sessionId: "s",
    isRunning: () => true,
    send: () => {},
    steer: async () => true,
    sync: (items) => { persistentId = items[0]?.id ?? persistentId; },
  });
  queue.adapter.enqueue(message("change direction"));
  const localId = queue.adapter.items[0]!.id;
  queue.adapter.move(localId, { lane: "steer", insertAfter: null });
  await flush();
  expect(queue.adapter.steerItems.map((item) => item.prompt)).toEqual(["change direction"]);
  expect(queue.getLocalId(persistentId)).toBe(localId);

  queue.settleSteer(persistentId, true);
  expect(queue.adapter.steerItems).toHaveLength(0);
  expect(queue.getLocalId(persistentId)).toBeUndefined();
});

test("undelivered steering returns to the queue after the run ends", async () => {
  let persistentId = "";
  const queue = createQoneMessageQueue({
    sessionId: "s",
    isRunning: () => true,
    send: () => {},
    steer: async () => true,
    sync: (items) => { persistentId = items[0]?.id ?? persistentId; },
  });
  queue.adapter.enqueue(message("try again"));
  queue.adapter.move(queue.adapter.items[0]!.id, { lane: "steer", insertAfter: null });
  await flush();
  queue.settleSteer(persistentId, false);
  expect(queue.adapter.steerItems).toHaveLength(0);
  expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["try again"]);
});

test("a steering item restored after a stopped run is dispatched instead of stranded", async () => {
  const sent: string[] = [];
  const queue = createQoneMessageQueue({
    sessionId: "s",
    isRunning: () => false,
    send: (_message, id) => { sent.push(id); },
    steer: async () => true,
    sync: () => {},
  });
  queue.restore([{ id: "pending", sessionId: "s", text: "still needed", lane: "steer", status: "steering", position: 0, createdAt: 1, updatedAt: 1 }]);
  await flush();
  expect(queue.adapter.steerItems).toHaveLength(0);
  expect(sent).toEqual(["pending"]);
});

test("restored queue items dispatch original image, ZIP and folder paths", async () => {
  let running = true;
  const sent: unknown[] = [];
  const queue = createQoneMessageQueue({
    sessionId: "s",
    isRunning: () => running,
    send: (_message, _id, attachments) => { sent.push(attachments); },
    steer: async () => true,
    sync: () => {},
  });
  const attachments = [
    { type: "image" as const, name: "plot.png", mimeType: "image/png", data: "", localPath: "C:\\Media\\plot.png" },
    { type: "file" as const, name: "report.zip", mimeType: "application/zip", data: "", localPath: "C:\\Media\\report.zip" },
    { type: "folder" as const, name: "source", mimeType: "inode/directory", data: "", localPath: "C:\\Media\\source" },
  ];
  queue.restore([{ id: "pending", sessionId: "s", text: "inspect", attachments, lane: "queue", status: "queued", position: 0, createdAt: 1, updatedAt: 1 }]);
  running = false;
  queue.releaseIdle();
  queue.controller.notifyIdle();
  await flush();
  expect(sent).toEqual([attachments]);
});

test("deleting an item while editing does not release it for dispatch", async () => {
  let running = true;
  const sent: string[] = [];
  let latest: { id: string } | undefined;
  const queue = createQoneMessageQueue({
    sessionId: "s",
    isRunning: () => running,
    send: (_message, id) => sent.push(id),
    steer: async () => true,
    sync: (items) => { latest = items[0] ? { id: items[0].id } : undefined; },
  });

  queue.adapter.enqueue(message("remove me"));
  const localId = queue.getLocalId(latest!.id)!;
  expect(queue.beginEdit(localId)).toBe(true);
  queue.remove(localId);

  running = false;
  queue.controller.notifyIdle();
  await flush();
  expect(sent).toEqual([]);
  expect(queue.adapter.items).toHaveLength(0);
});

test("editing a later item lets earlier items dispatch and holds only once it reaches the head", async () => {
  let running = true;
  const sent: string[] = [];
  const queue = createQoneMessageQueue({
    sessionId: "s",
    isRunning: () => running,
    send: (item) => { sent.push(item.content[0]?.type === "text" ? item.content[0].text : ""); running = true; queue.controller.notifyBusy(); },
    steer: async () => true,
    sync: () => {},
  });
  queue.adapter.enqueue(message("A"));
  queue.adapter.enqueue(message("B"));
  queue.adapter.enqueue(message("C"));
  const editing = queue.adapter.items[1]!.id;
  expect(queue.beginEdit(editing)).toBe(true);
  expect(queue.getItem(queue.getPersistentId(editing)!)?.text).toBe("B");

  running = false;
  queue.controller.notifyIdle();
  await flush();
  expect(sent).toEqual(["A"]);

  running = false;
  queue.controller.notifyIdle();
  await flush();
  expect(sent).toEqual(["A"]);

  queue.edit(editing, message("B2"));
  await flush();
  expect(sent).toEqual(["A", "B2"]);
});

test("attachment errors are reported instead of silently swallowed", async () => {
  const errors: string[] = [];
  const queue = createQoneMessageQueue({
    sessionId: "s",
    isRunning: () => true,
    send: () => {},
    steer: async () => true,
    sync: () => {},
    onError: (error) => errors.push(error),
  });
  queue.adapter.enqueue({ ...message("with file"), attachments: [{ id: "a", type: "image", name: "x.bmp", contentType: "image/bmp", status: { type: "complete" }, content: [{ type: "image", image: "data:image/bmp;base64,AA==" }] }] });
  await flush();
  expect(errors).toEqual([translateCurrent("attachment.unsupportedImage", { name: "x.bmp" })]);
});

const withImage = (data: string): AppendMessage => ({
  ...message("same"),
  attachments: [{
    id: crypto.randomUUID(), type: "image", name: "same.png", contentType: "image/png",
    status: { type: "complete" }, content: [{ type: "image", image: `data:image/png;base64,${data}` }],
  }],
});

test("repeated attachments merge by content across fresh attachment ids", async () => {
  let running = true;
  const sent: string[] = [];
  const queue = createQoneMessageQueue({
    sessionId: "s", isRunning: () => running,
    send: (_message, _id, files) => sent.push(files[0]!.data),
    steer: async () => true, sync: () => {},
  });
  queue.adapter.enqueue(withImage("YQ=="));
  queue.adapter.enqueue(withImage("YQ=="));
  queue.adapter.enqueue(withImage("YQ=="));
  running = false;
  queue.controller.notifyIdle();
  await flush();
  expect(sent).toEqual(["data:image/png;base64,YQ=="]);
  expect(queue.adapter.items).toHaveLength(0);
});

test("same text and attachment name with different bytes stays distinct", async () => {
  const queue = createQoneMessageQueue({
    sessionId: "s", isRunning: () => true, send: () => {},
    steer: async () => true, sync: () => {},
  });
  queue.adapter.enqueue(withImage("YQ=="));
  queue.adapter.enqueue(withImage("Yg=="));
  queue.adapter.enqueue(message("same"));
  await flush();
  expect(queue.adapter.items).toHaveLength(3);
});

test("a different submission between identical messages prevents queue merging", async () => {
  const queue = createQoneMessageQueue({
    sessionId: "s", isRunning: () => true, send: () => {},
    steer: async () => true, sync: () => {},
  });
  queue.adapter.enqueue(message("same"));
  queue.adapter.enqueue(message("other"));
  queue.adapter.enqueue(message("same"));
  await flush();
  expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["same", "other", "same"]);
});

test("resending the active input does not create a follow-up, but idle retry still sends", async () => {
  let running = true;
  let sends = 0;
  const queue = createQoneMessageQueue({
    sessionId: "s", isRunning: () => running,
    isDuplicate: (_message, files) => running && files[0]?.data === "data:image/png;base64,YQ==",
    send: () => { sends++; }, steer: async () => true, sync: () => {},
  });
  queue.adapter.enqueue(withImage("YQ=="));
  await flush();
  expect(queue.adapter.items).toHaveLength(0);
  expect(sends).toBe(0);
  running = false;
  queue.controller.notifyIdle();
  queue.adapter.enqueue(withImage("YQ=="));
  await flush();
  expect(sends).toBe(1);
});

test("duplicate during asynchronous dispatch is not sent twice", async () => {
  const sent: string[] = [];
  const queue = createQoneMessageQueue({
    sessionId: "s", isRunning: () => false,
    send: (item) => {
      sent.push(item.content[0]?.type === "text" ? item.content[0].text : "");
      queue.adapter.enqueue(message("same"));
    },
    steer: async () => true, sync: () => {},
  });
  queue.adapter.enqueue(message("same"));
  await flush();
  expect(sent).toEqual(["same"]);
  expect(queue.adapter.items).toHaveLength(0);
});

test("attachment duplicate submitted during dispatch is merged even after serialization finishes", async () => {
  let sends = 0;
  const queue = createQoneMessageQueue({
    sessionId: "s", isRunning: () => false,
    send: () => {
      sends++;
      if (sends === 1) queue.adapter.enqueue(withImage("YQ=="));
    },
    steer: async () => true, sync: () => {},
  });
  queue.adapter.enqueue(withImage("YQ=="));
  await flush();
  expect(sends).toBe(1);
  expect(queue.adapter.items).toHaveLength(0);
});
