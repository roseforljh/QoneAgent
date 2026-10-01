import { expect, test } from "bun:test";
import type { AppendMessage } from "@assistant-ui/react";
import type { ChatMessage } from "../src/store";
import { createQoneMessageQueue } from "../src/lib/qone-message-queue";
import { appendSteeringMessages, steeringMessages } from "../src/lib/use-steering-messages";

const input = (text: string): AppendMessage => ({
  role: "user", parentId: null, sourceId: null, runConfig: {}, createdAt: new Date(),
  metadata: { custom: {} }, content: [{ type: "text", text }], attachments: [],
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("clicking steer displays the submitted user message before acknowledgement and keeps earlier tools above it", async () => {
  let acknowledge!: (accepted: boolean) => void;
  const queue = createQoneMessageQueue({
    sessionId: "s", isRunning: () => true, getActiveRunId: () => "r",
    send: () => { throw new Error("must not start another run"); }, sync: () => {},
    steer: () => new Promise<boolean>((resolve) => { acknowledge = resolve; }),
  });
  queue.adapter.enqueue(input("first"));
  queue.adapter.enqueue(input("steer"));
  const id = queue.adapter.items[1]!.id;
  const persistentId = queue.getPersistentId(id)!;
  queue.steerNow(id);
  const submitted = steeringMessages(queue, queue.adapter.steerItems, "r");
  expect(submitted).toMatchObject([{ id: persistentId, role: "user", content: "steer", runId: "r" }]);
  const history: ChatMessage[] = [{ id: "streaming", role: "assistant", content: "", parts: [
    { type: "tool-call", toolName: "read", toolCallId: "t", args: {}, messageSequence: 1 },
  ] }];
  expect(appendSteeringMessages(history, submitted).map((message) => message.id)).toEqual(["streaming", persistentId]);
  await tick();
  acknowledge(false);
  await tick();
  expect(steeringMessages(queue, queue.adapter.steerItems, "r")).toEqual([]);
  expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["first", "steer"]);
});

test("multiple pending steers follow click order, retain attachments, and reconcile by identity without duplicates", async () => {
  const queue = createQoneMessageQueue({ sessionId: "s", isRunning: () => true,
    send: () => {}, steer: async () => true, sync: () => {},
  });
  queue.restore(["A", "B"].map((text, position) => ({ id: text, sessionId: "s", text,
    lane: "queue", status: "queued", position, createdAt: 1, updatedAt: 1,
    attachments: [{ type: "file", name: `${text}.txt`, mimeType: "text/plain", data: "", localPath: `C:/files/${text}.txt` }],
  })));
  const [a, b] = queue.adapter.items;
  queue.steerNow(b!.id);
  queue.steerNow(a!.id);
  await tick();
  const submitted = steeringMessages(queue, queue.adapter.steerItems, "r");
  expect(submitted.map((message) => message.content)).toEqual(["B", "A"]);
  expect(submitted[0]?.attachments?.[0]?.localPath).toBe("C:/files/B.txt");
  const canonical = [{ ...submitted[0]!, persisted: true }];
  expect(appendSteeringMessages(canonical, submitted).map((message) => message.id)).toEqual(["B", "A"]);
  queue.settleSteer("B", true);
  expect(steeringMessages(queue, queue.adapter.steerItems, "r").map((message) => message.id)).toEqual(["A"]);
});
