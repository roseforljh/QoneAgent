import { expect, test } from "bun:test";
import { PiAdapter } from "../src/pi-adapter";
import { ModelResponseTiming } from "../src/model-response-timing";
import { applyReasoningDelta, assistantPartsFromPiMessage, type AgentEvent, type AssistantMessagePart } from "@qone/protocol";
import { Database } from "bun:sqlite";
import { openDb, closeDb, SessionRepo, RunRepo, MessageRepo } from "@qone/database";

test("reasoning stays separate and survives interruption and persistence", () => {
  let parts: AssistantMessagePart[] = [];
  parts = applyReasoningDelta(parts, { delta: "检查", contentIndex: 0 }, 10);
  parts = applyReasoningDelta(parts, { delta: "视频", contentIndex: 0 }, 10);
  expect(parts).toEqual([{ type: "reasoning", text: "检查视频", messageSequence: 10, contentIndex: 0 }]);
  const completed = assistantPartsFromPiMessage({ message: { role: "assistant", content: [
    { type: "thinking", thinking: "检查视频", thinkingSignature: "private-signature" },
    { type: "text", text: "结果" },
  ] } }, 10);
  expect(completed.map(p => p.type)).toEqual(["reasoning", "text"]);
  expect(JSON.stringify(completed)).not.toContain("private-signature");
  const db = openDb(":memory:");
  const session = new SessionRepo(db).create();
  const run = new RunRepo(db).create(session.id);
  new MessageRepo(db).addAssistant(session.id, "", run.id, undefined, parts);
  const snapshot = db.$client.serialize(); closeDb(db);
  const reopened = openDb(":memory:", { open: () => Database.deserialize(snapshot) });
  expect(JSON.parse(new MessageRepo(reopened).listBySession(session.id)[0]!.parts!)).toEqual(parts);
  closeDb(reopened);
});

test("timings reset per model turn and distinguish reasoning from answer deltas", () => {
  const timing = new ModelResponseTiming();
  timing.record("model.request.started", {}, 100);
  timing.record("message.started", { message: { role: "assistant" } }, 200);
  timing.record("message.reasoning.delta", { delta: "thought" }, 220);
  timing.record("message.delta", { delta: "answer" }, 300);
  expect(timing.record("message.completed", { message: { role: "assistant" } }, 350)).toEqual({ startedAt: 100, firstResponseAt: 200, firstTextAt: 300, completedAt: 350, textDeltas: 1, reasoningDeltas: 1 });
  timing.record("model.request.started", {}, 400);
  expect(timing.record("message.completed", { message: { role: "assistant" } }, 450)?.textDeltas).toBe(0);
});

for (const mode of ["streamed", "batched", "reasoning-only", "cancelled"]) test(`Google adapter reasoning: ${mode}`, async () => {
  const events: AgentEvent[] = [];
  const encoder = new TextEncoder();
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.includes(":streamGenerateContent")) return Response.json({ models: [] });
    return new Response(new ReadableStream({ async start(controller) {
      const send = (parts: unknown[], finish = false) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, ...(finish ? { finishReason: "STOP" } : {}) }] })}\n\n`));
      if (mode === "reasoning-only") send([{ text: "检查视频", thought: true }], true);
      else if (mode === "cancelled") {
        send([{ text: "检查视频", thought: true }]);
        return; // Stay open until the client aborts.
      }
      else if (mode === "batched") send([{ text: "检查视频", thought: true }, { text: "结果" }], true);
      else {
        send([{ text: "检查", thought: true }]);
        await Bun.sleep(60);
        send([{ text: "视频", thought: true }]);
        await Bun.sleep(60);
        expect(events.some(e => e.type === "message.reasoning.delta")).toBe(true);
        expect(events.some(e => e.type === "message.delta")).toBe(false);
        send([{ text: "结果" }], true);
      }
      controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const adapter = new PiAdapter((event) => {
    events.push(event);
    if (mode === "cancelled" && event.type === "message.reasoning.delta") queueMicrotask(() => adapter.stop("reason-run"));
  });
  try {
    await adapter.setSecret("model.apiKey:reason-test", "test-key");
    await adapter.configureModels([{ id: "reason-test/gemini-test", provider: "reason-test", model: "gemini-test", enabled: true, updatedAt: 0,
      config: { apiType: "google", baseUrl: `http://127.0.0.1:${server.port}/v1beta`, autoMetadata: false, input: ["text"], output: ["text"], reasoning: true, contextWindow: 32000, maxTokens: 2048 } }]);
    const pending = adapter.run("reason-session", "测试", { model: "reason-test/gemini-test", runId: "reason-run", thinking: "high" }, () => {});
    if (mode === "reasoning-only" || mode === "cancelled") await expect(pending).rejects.toThrow("empty response");
    else await pending;
    expect(events.filter(e => e.type === "message.reasoning.delta").map(e => (e.payload as { delta: string }).delta).join("")).toBe("检查视频");
    expect(events.some(e => e.type === "model.request.started")).toBe(true);
    expect(events.some(e => e.type === "model.response.timing")).toBe(true);
    const final = events.findLast(e => e.type === "message.completed" && (e.payload as any).message?.role === "assistant");
    expect(assistantPartsFromPiMessage(final?.payload, 1).map(p => p.type)).toEqual(mode === "reasoning-only" || mode === "cancelled" ? ["reasoning"] : ["reasoning", "text"]);
  } finally { await adapter.disposeSession("reason-session"); server.stop(true); }
});
