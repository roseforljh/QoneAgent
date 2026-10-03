import { expect, test } from "bun:test";
import type { AssistantMessagePart, SubagentRunInfo } from "@qone/protocol";
import { applySubagentPatch, applySubagentStreaming, mergeSubagentSnapshots, updateSubagent } from "../src/lib/subagent-state";
import { createSubagentPublisher } from "../../agent-runtime/src/subagent-publisher";
import { subagentMessages } from "../src/lib/subagent-messages";

const text = (value: string, sequence = 1): AssistantMessagePart => ({ type: "text", text: value, messageSequence: sequence });
function child(id = "a"): SubagentRunInfo {
  return { id, parentSessionId: "parent", parentRunId: "run", toolCallId: `call-${id}`, depth: 1, title: id, task: "task",
    status: "running", startedAt: 1, content: "", parts: [text("saved")], turnCount: 1, retryCount: 0,
    messages: [{ id: "user", sequence: 0, role: "user", content: "task", createdAt: 1 },
      { id: "answer", sequence: 1, role: "assistant", content: "saved", parts: [text("saved")], createdAt: 2 }] };
}

test("equivalent JSON snapshots preserve every saved object and only a changed child is replaced", () => {
  const before = [child(), child("b")];
  expect(mergeSubagentSnapshots(before, JSON.parse(JSON.stringify(before)))).toBe(before);
  const next = mergeSubagentSnapshots(before, [{ ...JSON.parse(JSON.stringify(before[0])), status: "completed" }]);
  expect(next[1]).toBe(before[1]);
  expect(next[0]!.messages).toBe(before[0]!.messages);
  expect(next[0]!.parts).toBe(before[0]!.parts);
  expect(next[0]!.status).toBe("completed");
  const earlier = { ...child("c"), startedAt: 0 };
  expect(mergeSubagentSnapshots(next, [earlier]).map((item) => item.id)).toEqual(["c", "a", "b"]);
});

test("sparse parts updates preserve the suffix, update saved tool evidence, and handle append/truncate/clear", () => {
  const tool: AssistantMessagePart = { type: "tool-call", toolCallId: "tool", toolName: "read", args: {}, messageSequence: 1 };
  const first = child(); first.parts = [tool, text("later", 2)]; first.messages![1]!.parts = [tool];
  const before = subagentMessages(first);
  const completed = { ...tool, result: { full: "result" } };
  const next = applySubagentPatch(first, { id: "a", partsChanges: { length: 2, updates: [{ index: 0, part: completed }] } });
  expect(next.parts).toEqual([completed, text("later", 2)]);
  expect(next.parts[1]).toBe(first.parts[1]);
  expect(next.messages![0]).toBe(first.messages![0]);
  expect(next.messages![1]!.parts).toEqual([completed]);
  const after = subagentMessages(next);
  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(before[1]);
  expect(first.messages![1]!.parts).toEqual([tool]);
  const appended = applySubagentPatch(next, { id: "a", partsChanges: { length: 3, updates: [{ index: 2, part: text("new", 3) }] } });
  expect(appended.parts).toEqual([completed, text("later", 2), text("new", 3)]);
  const truncated = applySubagentPatch(appended, { id: "a", partsChanges: { length: 1, updates: [] } });
  expect(truncated.parts).toEqual([completed]);
  expect(applySubagentPatch(truncated, { id: "a", partsChanges: { length: 0, updates: [] } }).parts).toEqual([]);
});

test("invalid patch bounds are atomic and legacy suffixes still work", () => {
  const first = child();
  for (const start of [-1, 2, 0.5, NaN]) expect(applySubagentPatch(first, { id: "a", status: "failed", partsPatch: { start, parts: [] } })).toBe(first);
  for (const changes of [{ length: -1, updates: [] }, { length: 3, updates: [] }, { length: 2, updates: [{ index: 3, part: text("bad") }] }]) {
    expect(applySubagentPatch(first, { id: "a", status: "failed", partsChanges: changes })).toBe(first);
  }
  expect(applySubagentPatch(first, { id: "other", streaming: null })).toBe(first);
  expect(applySubagentPatch(first, { id: "a", partsPatch: { start: 1, parts: [text("new")] } }).parts).toEqual([text("saved"), text("new")]);
});

test("message upserts are idempotent, preserve unrelated history, and distinguish omitted from cleared stream", () => {
  const first = { ...child(), streaming: "live" };
  const next = applySubagentPatch(first, { id: "a", messagesAppend: [{ ...first.messages![1]!, content: "corrected" }, { id: "third", role: "assistant", sequence: 3, createdAt: 3, content: "new" }] });
  expect(next.messages!.map((message) => message.content)).toEqual(["task", "corrected", "new"]);
  expect(next.messages![0]).toBe(first.messages![0]);
  expect(next.streaming).toBe("live");
  expect(applySubagentPatch(next, { id: "a", messagesAppend: structuredClone(next.messages) })).toBe(next);
  expect(applySubagentPatch(next, { id: "a", streaming: null }).streaming).toBeUndefined();
});

test("revisions reject duplicates and stale snapshots and reset correctly across runtime restart", () => {
  const first = { ...child(), revisionEpoch: "old", revision: 10 };
  const event = { type: "subagent.streaming" as const, id: "a", sessionId: "parent", revisionEpoch: "old", revision: 11, delta: "one" };
  const next = applySubagentStreaming(first, event);
  expect(next.streaming).toBe("one");
  expect(applySubagentStreaming(next, event)).toBe(next);
  expect(mergeSubagentSnapshots([next], [first])[0]).toBe(next);
  expect(applySubagentPatch(next, { id: "a", revisionEpoch: "old", revision: 10, status: "failed" })).toBe(next);
  const restarted = mergeSubagentSnapshots([next], [{ ...first, revisionEpoch: "new", revision: 1, status: "interrupted" }])[0]!;
  expect(restarted.status).toBe("interrupted");
  expect(restarted.revisionEpoch).toBe("new");
  expect(applySubagentStreaming(restarted, { ...event, revisionEpoch: "new", revision: 2 })).toBe(restarted);
  expect(applySubagentStreaming(first, { ...event, sessionId: "wrong" })).toBe(first);
});

test("a reasoning block completed in its first coalesced delivery stays complete", () => {
  const first = child();
  const next = applySubagentStreaming(first, { type: "subagent.streaming", sessionId: "parent", id: "a", delta: "answer", reasoning: [{ delta: "finished reasoning", messageSequence: 2, contentIndex: 0, complete: true }] });
  expect(next.parts).toEqual([...first.parts, { type: "reasoning", text: "finished reasoning", messageSequence: 2, contentIndex: 0, complete: true }]);
  expect(next.streaming).toBe("answer"); expect(next.parts[0]).toBe(first.parts[0]);
});

test("publisher JSON transport and reducer keep concurrent ownership, exact text and history references", () => {
  const snapshots = new Map([child(), child("b")].map((item) => [item.id, item]));
  let state: SubagentRunInfo[] = [];
  const jobs = new Set<() => void>();
  let snapshotLoads = 0;
  const publisher = createSubagentPublisher({ intervalMs: 32, epoch: "test", load: (id) => { snapshotLoads++; return snapshots.get(id); },
    schedule: (callback) => { jobs.add(callback); return () => { jobs.delete(callback); }; },
    send: (raw) => {
      const event = JSON.parse(JSON.stringify(raw)) as typeof raw;
      if (event.type === "subagent.updated") state = mergeSubagentSnapshots(state, [event.subagent]);
      if (event.type === "subagent.patch") state = updateSubagent(state, event.id, (item) => applySubagentPatch(item, event.patch));
      if (event.type === "subagent.streaming") state = updateSubagent(state, event.id, (item) => applySubagentStreaming(item, event));
    } });
  try {
    publisher.publish("a"); publisher.publish("b");
    const history = state[0]!.messages, other = state[1];
    for (let index = 0; index < 200; index++) publisher.append("a", `${index},`);
    publisher.patch("a", { status: "waiting_approval" });
    expect(state[0]!.streaming).toBe(Array.from({ length: 200 }, (_, index) => `${index},`).join(""));
    expect(state[0]!.messages).toBe(history);
    expect(state[1]).toBe(other);
    publisher.append("b", "B"); for (const job of [...jobs]) job();
    expect(state[1]!.streaming).toBe("B");
    publisher.patch("a", { status: "completed" }); publisher.append("a", "late");
    expect(state[0]!.status).toBe("completed");
    expect(snapshotLoads).toBe(2);
    expect(jobs.size).toBe(0);
  } finally { publisher.dispose(); }
});
