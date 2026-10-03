import { expect, test } from "bun:test";
import type { AssistantMessagePart, RuntimeEvent, SubagentRunInfo } from "@qone/protocol";
import { createSubagentPublisher } from "../src/subagent-publisher";

function fixture() {
  let now = 0;
  const jobs = new Set<{ due: number; callback: () => void }>();
  const items = new Map<string, SubagentRunInfo>(["a", "b"].map((id) => [id, {
    id, parentSessionId: `session-${id}`, parentRunId: "parent", toolCallId: `call-${id}`, depth: 1,
    title: "worker", task: "task", status: "running", startedAt: 1, content: "", turnCount: 1, retryCount: 0,
    parts: [], messages: [{ id: `${id}-user`, role: "user", sequence: 0, content: "task", createdAt: 1 }],
  }]));
  const events: RuntimeEvent[] = [];
  const loads: string[] = [];
  const revisions = new Map<string, number>();
  const publisher = createSubagentPublisher({
    load: (id) => { loads.push(id); return items.get(id); },
    epoch: "test",
    send: (event) => {
      const value = event.type === "subagent.updated" ? event.subagent : event.type === "subagent.patch" ? event.patch : event.type === "subagent.streaming" ? event : undefined;
      expect(value).toBeDefined();
      const revision = (revisions.get(value!.id) ?? 0) + 1; revisions.set(value!.id, revision);
      expect(value!.revision).toBe(revision); expect(value!.revisionEpoch).toBe("test");
      const copy = structuredClone(event);
      const copied = copy.type === "subagent.updated" ? copy.subagent : copy.type === "subagent.patch" ? copy.patch : copy.type === "subagent.streaming" ? copy : undefined;
      delete copied!.revision; delete copied!.revisionEpoch;
      events.push(copy);
    }, intervalMs: 32,
    schedule: (callback, delay) => {
      const job = { due: now + delay, callback }; jobs.add(job);
      return () => { jobs.delete(job); };
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const job of [...jobs]) if (job.due <= now && jobs.delete(job)) job.callback();
  };
  return { publisher, items, events, loads, jobs, advance };
}

test("streaming deadline starts at the first delta and does not move with later tokens", () => {
  const { publisher, events, loads, advance, jobs } = fixture();
  publisher.publish("a"); publisher.append("a", "你好"); advance(20);
  publisher.append("a", "，world"); advance(11);
  expect(events).toHaveLength(1);
  advance(1);
  expect(events.slice(1)).toEqual([{ type: "subagent.streaming", sessionId: "session-a", id: "a", delta: "你好，world" }]);
  advance(100);
  expect(events).toHaveLength(2);
  expect(loads).toEqual(["a"]);
  expect(jobs.size).toBe(0);
  publisher.dispose();
});

test("approval status patch flushes pending text and reasoning before status, without duplication", () => {
  const { publisher, events, advance, loads } = fixture();
  publisher.publish("a"); publisher.append("a", "answer");
  publisher.appendReasoning("a", { delta: "think", messageSequence: 1 });
  publisher.patch("a", { status: "waiting_approval" });
  advance(100);
  expect(events.slice(1)).toEqual([
    { type: "subagent.streaming", sessionId: "session-a", id: "a", delta: "answer", reasoning: [{ delta: "think", messageSequence: 1 }] },
    { type: "subagent.patch", sessionId: "session-a", id: "a", patch: { id: "a", status: "waiting_approval" } },
  ]);
  expect(loads).toEqual(["a"]);
  publisher.dispose();
});

for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
  test(`${status} flushes pending text once, closes streaming, and permits a later resumed turn`, () => {
    const { publisher, items, events, advance, jobs } = fixture();
    publisher.publish("a"); publisher.append("a", "last answer"); publisher.patch("a", { status });
    publisher.append("a", "late"); publisher.appendReasoning("a", { delta: "late", messageSequence: 1 });
    advance(100);
    expect(events.slice(1)).toEqual([
      { type: "subagent.streaming", sessionId: "session-a", id: "a", delta: "last answer" },
      { type: "subagent.patch", sessionId: "session-a", id: "a", patch: { id: "a", status } },
    ]);
    expect(jobs.size).toBe(0);
    items.set("a", { ...items.get("a")!, status: "running", turnCount: 2 });
    publisher.publish("a"); publisher.append("a", "resumed"); advance(32);
    expect(events.at(-1)).toEqual({ type: "subagent.streaming", sessionId: "session-a", id: "a", delta: "resumed" });
    publisher.dispose();
  });
}

test("authoritative parts and text suppress only superseded buffers", () => {
  const { publisher, events, advance } = fixture();
  publisher.publish("a"); publisher.append("a", "text");
  publisher.appendReasoning("a", { delta: "think", messageSequence: 1 });
  publisher.patch("a", { streaming: "text" });
  expect(events.slice(1)).toEqual([
    { type: "subagent.streaming", sessionId: "session-a", id: "a", delta: "", reasoning: [{ delta: "think", messageSequence: 1 }] },
    { type: "subagent.patch", sessionId: "session-a", id: "a", patch: { id: "a", streaming: "text" } },
  ]);
  publisher.append("a", "more text"); publisher.appendReasoning("a", { delta: "more think", messageSequence: 1 });
  publisher.patch("a", { parts: [{ type: "reasoning", text: "thinkmore think", messageSequence: 1 }] });
  advance(100);
  expect(events.slice(3)).toEqual([
    { type: "subagent.streaming", sessionId: "session-a", id: "a", delta: "more text" },
    { type: "subagent.patch", sessionId: "session-a", id: "a", patch: { id: "a", partsChanges: { length: 1, updates: [{ index: 0, part: { type: "reasoning", text: "thinkmore think", messageSequence: 1 } }] } } },
  ]);
  publisher.dispose();
});

test("part append, replacement, truncation and clearing transmit exact boundaries", () => {
  const { publisher, items, events } = fixture();
  const first: AssistantMessagePart = { type: "text", text: "old", messageSequence: 1 };
  const second: AssistantMessagePart = { type: "text", text: "new", messageSequence: 2 };
  const replacement: AssistantMessagePart = { ...second, text: "replaced" };
  items.set("a", { ...items.get("a")!, parts: [first] }); publisher.publish("a");
  publisher.patch("a", { parts: [first, second] }); publisher.patch("a", { parts: [first, replacement] });
  publisher.patch("a", { parts: [first] }); publisher.patch("a", { parts: [] });
  expect(events.slice(1)).toEqual([
    { type: "subagent.patch", sessionId: "session-a", id: "a", patch: { id: "a", partsChanges: { length: 2, updates: [{ index: 1, part: second }] } } },
    { type: "subagent.patch", sessionId: "session-a", id: "a", patch: { id: "a", partsChanges: { length: 2, updates: [{ index: 1, part: replacement }] } } },
    { type: "subagent.patch", sessionId: "session-a", id: "a", patch: { id: "a", partsChanges: { length: 1, updates: [] } } },
    { type: "subagent.patch", sessionId: "session-a", id: "a", patch: { id: "a", partsChanges: { length: 0, updates: [] } } },
  ]);
  publisher.dispose();
});

test("interleaved children retain ownership and snapshots/disposal cancel only the correct timers", () => {
  const { publisher, events, items, advance, jobs, loads } = fixture();
  publisher.publish("a"); publisher.publish("b"); publisher.append("a", "one"); publisher.append("b", "two");
  items.set("a", { ...items.get("a")!, streaming: "one" }); publisher.publish("a"); advance(32);
  expect(events.slice(2)).toEqual([
    { type: "subagent.updated", subagent: items.get("a")! },
    { type: "subagent.streaming", sessionId: "session-b", id: "b", delta: "two" },
  ]);
  expect(loads).toEqual(["a", "b", "a"]);
  publisher.append("a", "pending"); publisher.append("b", "pending"); publisher.dispose(); advance(100);
  publisher.append("unknown", "ignored"); publisher.patch("unknown", { content: "ignored" });
  expect(events).toHaveLength(4);
  expect(jobs.size).toBe(0);
});

test("queued tool arguments use the latest canonical parts once at the fixed deadline and settle at boundaries", () => {
  const { publisher, items, events, advance, loads } = fixture();
  const tool: AssistantMessagePart = { type: "tool-call", toolCallId: "tool", toolName: "read", args: {}, messageSequence: 1 };
  items.set("a", { ...items.get("a")!, parts: [tool] }); publisher.publish("a");
  let parts: AssistantMessagePart[] = [tool];
  for (let index = 0; index < 200; index++) {
    parts = [{ ...tool, args: { path: `path-${index}` } }];
    publisher.queueParts("a", () => parts);
  }
  advance(31); expect(events).toHaveLength(1);
  advance(1);
  expect(events.slice(1)).toEqual([{ type: "subagent.patch", sessionId: "session-a", id: "a", patch: { id: "a", partsChanges: { length: 1, updates: [{ index: 0, part: parts[0]! }] } } }]);
  parts = [{ ...tool, args: { path: "final" } }]; publisher.queueParts("a", () => parts);
  publisher.patch("a", { parts, status: "completed" }); advance(100);
  expect(events).toHaveLength(3);
  expect(events.at(-1)).toEqual({ type: "subagent.patch", sessionId: "session-a", id: "a", patch: { id: "a", status: "completed", partsChanges: { length: 1, updates: [{ index: 0, part: parts[0]! }] } } });
  expect(loads).toEqual(["a"]); publisher.dispose();
});
