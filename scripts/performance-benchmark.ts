import { strict as assert } from "node:assert";
import { MessageRepo, SessionRepo, WorkspaceRepo, openDb } from "../packages/database/src/index";
import { SequencedEventJournal } from "../packages/shared/src/event-bus";
import type { RuntimeEvent, SubagentRunInfo } from "../packages/protocol/src/index";
import { createSubagentPublisher } from "../apps/agent-runtime/src/subagent-publisher";
import { assistantMessageContent } from "../apps/desktop/src/lib/assistant-message-parts";
import { createMessageConverter, type MessageConversionContext } from "../apps/desktop/src/lib/runtime-message-converter";
import { measureConversationRail } from "../apps/desktop/src/lib/conversation-rail-layout";
import type { ChatMessage } from "../apps/desktop/src/store";

// Synthetic, local measurements. This script opens no browser and changes no
// application database. Fixture sizes describe workloads, not product limits.
function measure(operation: () => unknown, repeats = 5) {
  operation();
  const times = Array.from({ length: repeats }, () => {
    Bun.gc(true);
    const start = performance.now();
    operation();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return Number(times[Math.floor(times.length / 2)]!.toFixed(2));
}

const journalSize = 2_000;
const eventCount = 200_000;
const journalBeforeMs = measure(() => {
  const events: { sequence: number }[] = [];
  for (let sequence = 0; sequence < eventCount; sequence++) {
    events.push({ sequence });
    if (events.length > journalSize) events.splice(0, events.length - journalSize);
  }
  assert.equal(events[0]!.sequence, eventCount - journalSize);
});
const journalAfterMs = measure(() => {
  const journal = new SequencedEventJournal<{ sequence: number }>(0, journalSize);
  for (let index = 0; index < eventCount; index++) journal.record((sequence) => ({ sequence }));
  assert.equal(journal.replay()[0]!.sequence, eventCount - journalSize);
});

const db = openDb(":memory:");
const sessions = new SessionRepo(db);
const messages = new MessageRepo(db);
const workspace = new WorkspaceRepo(db).upsert("benchmark", "C:/synthetic-performance-fixture");
const sessionCount = 200;
const messagesPerSession = 100;
db.$client.transaction(() => {
  for (let index = 0; index < sessionCount; index++) {
    const session = sessions.create(`chat ${index}`, workspace.id);
    db.$client.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(index, session.id);
    for (let message = 0; message < messagesPerSession; message++) messages.add(
      session.id, "assistant", `${index % 3 === 0 && message === 0 ? "性能" : "普通"} ${"content ".repeat(128)}`,
      undefined, undefined, undefined, undefined,
      [{ type: "tool-call", toolCallId: `${index}:${message}`, toolName: "read", args: { path: "fixture" }, result: "saved result ".repeat(160), messageSequence: message }],
    );
  }
})();
const searchBefore = (query: string) => {
  const needle = query.toLocaleLowerCase();
  const results: string[] = [];
  for (const session of sessions.list()) {
    if (session.title.toLocaleLowerCase().includes(needle)
      || messages.listBySession(session.id).some((message) => message.content.toLocaleLowerCase().includes(needle))) results.push(session.id);
    if (results.length >= 50) break;
  }
  return results;
};
const search = ["性能", "不存在的查询"].map((query) => {
  assert.deepEqual(sessions.search(query).map((item) => item.session.id), searchBefore(query));
  return { query, beforeMs: measure(() => searchBefore(query)), afterMs: measure(() => sessions.search(query)) };
});
db.$client.close();

const historySize = 1_200;
const updates = 100;
const history: ChatMessage[] = Array.from({ length: historySize }, (_, index) => ({
  id: `message-${index}`, role: "assistant", runId: `run-${index}`, createdAt: index, content: "answer",
  parts: [...Array.from({ length: 8 }, (_, part) => ({
    type: "tool-call" as const, toolCallId: `tool-${index}-${part}`, toolName: "read",
    args: { path: `src/module-${part}.ts`, context: "argument ".repeat(40) },
    result: "complete", messageSequence: part,
  })), { type: "text", text: "answer", messageSequence: 9 }],
}));
const context: MessageConversionContext = {
  imagePreviews: {}, toolCallsByRun: new Map(), imageWindows: new Map(), childImagesByRun: new Map(),
  running: true, imageModel: false,
};
const convert = createMessageConverter();
const first = history.map((message) => convert(message, context));
assert(history.every((message, index) => convert(message, context) === first[index]));
const conversionBeforeMs = measure(() => {
  for (let update = 0; update < updates; update++) history.map((message) => ({
    id: message.id, role: "assistant", createdAt: new Date(message.createdAt!),
    content: assistantMessageContent(message, [], false), status: { type: "complete", reason: "stop" },
  }));
});
const conversionAfterMs = measure(() => {
  for (let update = 0; update < updates; update++) history.map((message) => convert(message, context));
});

let measurements = 0;
const blocks = Array.from({ length: 10_000 }, (_, index) => ({
  dataset: { turnId: String(index) },
  getBoundingClientRect: () => { measurements++; return { top: index * 100, bottom: (index + 1) * 100 }; },
}));
for (const block of blocks) { if (block.getBoundingClientRect().top >= 900_500) break; }
const railBeforeMeasurements = measurements;
measurements = 0;
assert.deepEqual(measureConversationRail(blocks, { top: 900_000, bottom: 900_500 }, 900_001), {
  activeId: "9000", visibleIds: ["9000", "9001", "9002", "9003", "9004"],
});
const railAfterMeasurements = measurements;

const child: SubagentRunInfo = {
  id: "child", parentSessionId: "session", parentRunId: "parent", toolCallId: "tool", title: "worker", task: "task",
  status: "running", startedAt: 1, content: "", parts: [],
  messages: Array.from({ length: 100 }, (_, index) => ({
    id: `saved-${index}`, role: "assistant", sequence: index, content: "saved history ".repeat(80), createdAt: index,
  })),
};
let loads = 0;
const events: RuntimeEvent[] = [];
const publisher = createSubagentPublisher({ load: () => { loads++; return child; }, send: (event) => events.push(event), intervalMs: 1 });
publisher.publish(child.id);
let streamed = "";
let subagentBeforeBytes = 0;
for (let window = 0; window < 20; window++) {
  for (let delta = 0; delta < 50; delta++) {
    streamed += "字";
    publisher.append(child.id, "字");
  }
  subagentBeforeBytes += Buffer.byteLength(JSON.stringify({ type: "subagent.updated", subagent: { ...child, streaming: streamed } }));
  await Bun.sleep(10);
}
publisher.dispose();
const deltas = events.filter((event) => event.type === "subagent.streaming");
assert.equal(deltas.map((event) => event.delta).join(""), streamed);
assert.equal(loads, 1);
const subagentAfterBytes = deltas.reduce((size, event) => size + Buffer.byteLength(JSON.stringify(event)), 0);

console.log(JSON.stringify({
  environment: { bun: Bun.version, platform: process.platform, arch: process.arch, timing: "warmup plus median of five runs; milliseconds; synthetic fixtures" },
  journal: { capacity: journalSize, events: eventCount, beforeMs: journalBeforeMs, afterMs: journalAfterMs },
  search: { sessions: sessionCount, messages: sessionCount * messagesPerSession, queries: search },
  messageConversion: { savedMessages: historySize, updates, beforeMs: conversionBeforeMs, afterMs: conversionAfterMs, reusedSavedMessages: first.length },
  conversationRail: { turns: blocks.length, beforeMeasurements: railBeforeMeasurements, afterMeasurements: railAfterMeasurements },
  subagentTransport: { windows: 20, deltas: 1_000, savedMessages: child.messages!.length,
    beforeBytes: subagentBeforeBytes, afterBytes: subagentAfterBytes, snapshotLoadsDuringStreaming: loads - 1 },
}, null, 2));
