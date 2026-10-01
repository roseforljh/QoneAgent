import { expect, test } from "bun:test";
import type { RuntimeEvent, SubagentRunInfo } from "@qone/protocol";
import { createSubagentPublisher } from "../src/subagent-publisher";

function fixture() {
  const items = new Map<string, SubagentRunInfo>(["a", "b"].map((id) => [id, {
    id, parentSessionId: `session-${id}`, parentRunId: "parent", toolCallId: "call",
    title: "worker", task: "task", status: "running", startedAt: 1, content: "",
    parts: [], messages: [{ id: "user", role: "user", sequence: 0, content: "task", createdAt: 1 }],
  }]));
  const events: RuntimeEvent[] = [];
  let loads = 0;
  const publisher = createSubagentPublisher({
    load: (id) => { loads++; return items.get(id); },
    send: (event) => { events.push(event); }, intervalMs: 1,
  });
  return { publisher, items, events, loads: () => loads };
}

test("coalesced text contains each delta once and does not query or transmit history", async () => {
  const { publisher, events, loads } = fixture();
  try {
    publisher.publish("a");
    for (const text of ["你好", "，", "world"]) publisher.append("a", text);
    await Bun.sleep(10);
    expect(loads()).toBe(1);
    expect(events.slice(1)).toEqual([{ type: "subagent.streaming", sessionId: "session-a", id: "a", delta: "你好，world" }]);
    publisher.append("a", "!");
    await Bun.sleep(10);
    expect(events.at(-1)).toEqual({ type: "subagent.streaming", sessionId: "session-a", id: "a", delta: "!" });
    expect(loads()).toBe(1);
  } finally { publisher.dispose(); }
});

test("a state boundary supersedes pending deltas and completion closes the stream", async () => {
  const { publisher, items, events } = fixture();
  try {
    publisher.publish("a");
    publisher.append("a", "draft");
    items.set("a", { ...items.get("a")!, streaming: "draft" });
    publisher.publish("a");
    await Bun.sleep(10);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "subagent.updated", subagent: { streaming: "draft" } });
    publisher.append("a", "done");
    items.set("a", { ...items.get("a")!, status: "completed", streaming: undefined, content: "draftdone" });
    publisher.publish("a");
    publisher.append("a", "late");
    await Bun.sleep(10);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ type: "subagent.updated", subagent: { status: "completed", content: "draftdone" } });
  } finally { publisher.dispose(); }
});

test("concurrent children retain ownership and disposal cancels unsent work", async () => {
  const { publisher, events } = fixture();
  publisher.publish("a"); publisher.publish("b");
  publisher.append("a", "one"); publisher.append("b", "two");
  await Bun.sleep(10);
  expect(events.slice(2)).toEqual([
    { type: "subagent.streaming", sessionId: "session-a", id: "a", delta: "one" },
    { type: "subagent.streaming", sessionId: "session-b", id: "b", delta: "two" },
  ]);
  publisher.append("a", "pending");
  publisher.dispose();
  await Bun.sleep(10);
  expect(events).toHaveLength(4);
});

test("reasoning deltas coalesce by block with text and preserve block completion", async () => {
  const { publisher, events, loads } = fixture();
  try {
    publisher.publish("a");
    publisher.appendReasoning("a", { delta: "分析", messageSequence: 10, contentIndex: 0 });
    publisher.appendReasoning("a", { delta: "继续", messageSequence: 10, contentIndex: 0 });
    publisher.appendReasoning("a", { delta: "", messageSequence: 10, contentIndex: 0, complete: true });
    publisher.appendReasoning("a", { delta: "另一块", messageSequence: 10, contentIndex: 1 });
    publisher.appendReasoning("a", { delta: "下一轮", messageSequence: 11, contentIndex: 0 });
    publisher.append("a", "答案");
    await Bun.sleep(10);
    expect(loads()).toBe(1);
    expect(events.slice(1)).toEqual([{
      type: "subagent.streaming", sessionId: "session-a", id: "a", delta: "答案", reasoning: [
        { delta: "分析继续", messageSequence: 10, contentIndex: 0, complete: true },
        { delta: "另一块", messageSequence: 10, contentIndex: 1 },
        { delta: "下一轮", messageSequence: 11, contentIndex: 0 },
      ],
    }]);
  } finally { publisher.dispose(); }
});

test("a full snapshot supersedes pending reasoning and text without duplicating them", async () => {
  const { publisher, items, events } = fixture();
  try {
    publisher.publish("a");
    publisher.appendReasoning("a", { delta: "推理", messageSequence: 1, contentIndex: 0 });
    publisher.append("a", "回答");
    items.set("a", { ...items.get("a")!, streaming: "回答", parts: [{ type: "reasoning", text: "推理", messageSequence: 1, contentIndex: 0 }] });
    publisher.publish("a");
    await Bun.sleep(10);
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "subagent.updated", subagent: { streaming: "回答", parts: [{ text: "推理" }] } });
  } finally { publisher.dispose(); }
});
