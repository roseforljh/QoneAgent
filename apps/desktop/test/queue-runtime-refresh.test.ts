import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import type { AppendMessage } from "@assistant-ui/react";
import { createQoneMessageQueue, type QueueBundle } from "../src/lib/qone-message-queue";
import { createMessageQueueAdapterStore } from "../src/lib/use-message-queue-adapter";

const reactDist = dirname(Bun.resolveSync("@assistant-ui/react", import.meta.dir));
const { ExternalStoreRuntimeCore } = await import(join(reactDist, "legacy-runtime/runtime-cores/external-store/ExternalStoreRuntimeCore.js"));
const { AssistantRuntimeImpl } = await import(join(reactDist, "legacy-runtime/runtime/AssistantRuntime.js"));

function liveRuntime(queue: QueueBundle, runtimeRunning = true) {
  let store = createMessageQueueAdapterStore(queue);
  const adapter = () => ({ messages: [], isRunning: runtimeRunning, onNew: async () => {}, queue: store.getSnapshot() });
  const core = new ExternalStoreRuntimeCore(adapter());
  const runtime = new AssistantRuntimeImpl(core);
  let snapshot = store.getSnapshot();
  const publish = () => {
    if (snapshot === store.getSnapshot()) return;
    snapshot = store.getSnapshot();
    core.setAdapter(adapter());
  };
  let unsubscribe = store.subscribe(publish);
  let visible = runtime.thread.composer.getState().queue.map((item) => item.prompt);
  const watch = runtime.thread.composer.subscribe(() => {
    visible = runtime.thread.composer.getState().queue.map((item) => item.prompt);
  });
  return { runtime, visible: () => visible,
    select: (next: QueueBundle) => {
      unsubscribe();
      store = createMessageQueueAdapterStore(next);
      snapshot = store.getSnapshot();
      core.setAdapter(adapter());
      unsubscribe = store.subscribe(publish);
    },
    dispose: () => { watch(); unsubscribe(); },
  };
}

const input = (text: string): AppendMessage => ({
  role: "user", parentId: null, sourceId: null, runConfig: {}, createdAt: new Date(),
  metadata: { custom: {} }, content: [{ type: "text", text }], attachments: [],
});
const createQueue = (sessionId = "refresh") => createQoneMessageQueue({
  sessionId, isRunning: () => true, getActiveRunId: () => "run",
  send: () => { throw new Error("must remain queued"); }, steer: async () => true, sync: () => {},
});
const submit = async (view: ReturnType<typeof liveRuntime>, text: string) => {
  view.runtime.thread.composer.setText(text);
  await view.runtime.thread.composer.send();
};

test("the first composer send publishes its waiting row without typing again or receiving IPC", async () => {
  const queue = createQoneMessageQueue({ sessionId: "refresh", isRunning: () => true,
    send: () => { throw new Error("must remain queued"); }, steer: async () => true, sync: () => {},
  });
  const view = liveRuntime(queue);
  try {
    view.runtime.thread.composer.setText("first input");
    await view.runtime.thread.composer.send();
    expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["first input"]);
    expect(view.visible()).toEqual(["first input"]);
  } finally { view.dispose(); }
});

test("a normal send stays queued even when assistant-ui uses its steer submission path", async () => {
  const steered: string[] = [];
  const queue = createQoneMessageQueue({ sessionId: "mode-refresh", isRunning: () => true,
    getActiveRunId: () => "active-run",
    send: () => { throw new Error("the active run must not be replaced"); },
    steer: async (message) => { steered.push(message.content[0]?.type === "text" ? message.content[0].text : ""); return true; }, sync: () => {},
  });
  const view = liveRuntime(queue, false);
  try {
    await submit(view, "already waiting");
    await submit(view, "first input after disabling");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steered).toEqual([]);
    expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["already waiting", "first input after disabling"]);
  } finally { view.dispose(); }
});

test("each consecutive submission and removal updates the same runtime immediately", async () => {
  const queue = createQueue();
  const view = liveRuntime(queue);
  try {
    for (const text of ["A", "B", "C"]) {
      await submit(view, text);
      expect(view.visible()).toEqual(queue.adapter.items.map((item) => item.prompt));
    }
    view.runtime.thread.composer.removeQueueItem(queue.adapter.items[1]!.id);
    expect(view.visible()).toEqual(["A", "C"]);
    for (const item of [...queue.adapter.items]) view.runtime.thread.composer.removeQueueItem(item.id);
    expect(view.visible()).toEqual([]);
  } finally { view.dispose(); }
});

test("editing, cancelling and saving publish detached and restored lanes without another keystroke", async () => {
  const queue = createQueue();
  const view = liveRuntime(queue);
  try {
    for (const text of ["A", "B", "C"]) await submit(view, text);
    const b = queue.adapter.items[1]!.id;
    const persistentId = queue.getPersistentId(b)!;
    expect(queue.beginEdit(b)).toBe(true);
    expect(view.visible()).toEqual(["A", "C"]);
    queue.cancelEdit();
    expect(view.visible()).toEqual(["A", "B", "C"]);
    const restored = queue.getLocalId(persistentId)!;
    expect(queue.beginEdit(restored)).toBe(true);
    expect(await queue.edit(restored, input("B changed"))).toBe(true);
    expect(view.visible()).toEqual(["A", "B changed", "C"]);
    expect(queue.getLocalId(persistentId)).toBeDefined();
  } finally { view.dispose(); }
});

test("steering and rejection update both lanes while snapshots keep their previous contents", async () => {
  const queue = createQueue();
  const store = createMessageQueueAdapterStore(queue);
  const view = liveRuntime(queue);
  try {
    for (const text of ["A", "B", "C"]) await submit(view, text);
    const before = store.getSnapshot()!;
    const b = queue.adapter.items[1]!.id;
    const persistentId = queue.getPersistentId(b)!;
    queue.steerNow(b);
    const steering = store.getSnapshot()!;
    expect(steering.items.map((item) => item.prompt)).toEqual(["A", "C"]);
    expect(steering.steerItems.map((item) => item.prompt)).toEqual(["B"]);
    expect(view.visible()).toEqual(["B", "A", "C"]);
    queue.settleSteer(persistentId, false);
    expect(view.visible()).toEqual(["A", "B", "C"]);
    expect(before.items.map((item) => item.prompt)).toEqual(["A", "B", "C"]);
    expect(before.steerItems).toEqual([]);
    expect(steering.steerItems.map((item) => item.prompt)).toEqual(["B"]);
  } finally { view.dispose(); }
});

test("switching conversations replaces the subscription and excludes later updates from the old queue", async () => {
  const first = createQueue("first");
  const second = createQueue("second");
  const view = liveRuntime(first);
  try {
    await submit(view, "first draft");
    view.select(second);
    expect(view.visible()).toEqual([]);
    first.adapter.enqueue(input("background input"));
    expect(view.visible()).toEqual([]);
    await submit(view, "second draft");
    expect(view.visible()).toEqual(["second draft"]);
    view.select(first);
    expect(view.visible()).toEqual(["first draft", "background input"]);
  } finally { view.dispose(); }
});

test("main and side views both receive changes to their shared conversation queue", async () => {
  const queue = createQueue();
  const main = liveRuntime(queue);
  const side = liveRuntime(queue);
  try {
    await submit(main, "main input");
    expect(side.visible()).toEqual(["main input"]);
    await submit(side, "side input");
    expect(main.visible()).toEqual(["main input", "side input"]);
    side.runtime.thread.composer.removeQueueItem(queue.adapter.items[0]!.id);
    expect(main.visible()).toEqual(["side input"]);
    expect(side.visible()).toEqual(["side input"]);
  } finally { main.dispose(); side.dispose(); }
});

test("rows publish before asynchronous file preparation and cannot reappear after removal", async () => {
  let finish!: (data: ArrayBuffer) => void;
  const data = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
  const file = new File(["input"], "input.txt", { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", { value: () => data });
  const queue = createQueue();
  const view = liveRuntime(queue);
  try {
    queue.adapter.enqueue({ ...input("inspect file"), attachments: [{
      id: "file", type: "file", name: file.name, contentType: file.type, file,
      status: { type: "complete" }, content: [],
    }] });
    expect(view.visible()).toEqual(["inspect file"]);
    const id = queue.adapter.items[0]!.id;
    const persistentId = queue.getPersistentId(id)!;
    expect(queue.getItem(persistentId)).toBeUndefined();
    queue.remove(id);
    expect(view.visible()).toEqual([]);
    finish(new ArrayBuffer(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(view.visible()).toEqual([]);
    expect(queue.getPersistentId(id)).toBeUndefined();
  } finally { view.dispose(); }
});

test("stable lane snapshots do not trigger changes for busy notifications or repeat reads", () => {
  const queue = createQueue();
  const store = createMessageQueueAdapterStore(queue);
  const empty = store.getSnapshot();
  queue.controller.notifyBusy();
  expect(store.getSnapshot()).toBe(empty);
  queue.adapter.enqueue(input("A"));
  const queued = store.getSnapshot()!;
  expect(queued).not.toBe(empty);
  expect(store.getSnapshot()).toBe(queued);
  expect(queued.enqueue).toBe(queue.adapter.enqueue);
  expect(queued.remove).toBe(queue.adapter.remove);
  expect(createMessageQueueAdapterStore(null).getSnapshot()).toBeUndefined();
});
