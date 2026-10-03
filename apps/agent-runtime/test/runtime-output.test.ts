import { expect, test } from "bun:test";
import type { AgentEvent, RuntimeEvent } from "@qone/protocol";
import { createRuntimeOutput } from "../src/runtime-output";

const token = (sequence: number, delta: string, runId = "run", payload = {}): RuntimeEvent => ({ type: "agent.event", event: {
  eventId: `event-${sequence}`, sequence, sessionId: `session-${runId}`, runId, type: "message.delta", timestamp: sequence,
  payload: { delta, ...payload }, scope: "conversation",
} });
function fixture(maxEvents = 32) {
  const lines: string[] = [];
  let scheduled: (() => void) | undefined;
  let schedules = 0;
  const output = createRuntimeOutput({ write: (line) => lines.push(line), intervalMs: 8, maxEvents,
    schedule: (callback, delay) => { expect(delay).toBe(8); schedules++; scheduled = callback; return () => { scheduled = undefined; }; } });
  return { output, lines, schedules: () => schedules, tick: () => scheduled?.() };
}

test("200 adjacent tokens cross stdout once as one event with exact text and latest replay cursor", () => {
  const { output, lines, schedules, tick } = fixture();
  for (let index = 0; index < 200; index++) output.send(token(index, `字${index},`));
  expect(lines).toEqual([]); expect(schedules()).toBe(1);
  tick();
  expect(lines).toHaveLength(1);
  const expected = token(199, Array.from({ length: 200 }, (_, index) => `字${index},`).join(""));
  expect(JSON.parse(lines[0]!)).toEqual([expected]);
  expect(lines[0]!.endsWith("\n")).toBe(true);
  tick(); output.flush(); expect(lines).toHaveLength(1);
});

test("run, block, event type and payload changes remain ordered and boundaries flush before completion", () => {
  const { output, lines } = fixture();
  const events = [token(1, "a"), token(2, "b", "other"), token(3, "c", "run", { contentIndex: 1 }), token(4, "d", "run", { contentIndex: 2 })];
  const reasoning = token(5, "think", "run", { contentIndex: 2 }) as { type: "agent.event"; event: AgentEvent };
  reasoning.event.type = "message.reasoning.delta"; events.push(reasoning);
  for (const event of events) output.send(event);
  const completed = token(6, "") as { type: "agent.event"; event: AgentEvent }; completed.event.type = "message.completed";
  output.send(completed);
  expect(lines.map((line) => JSON.parse(line))).toEqual([events, completed]);
});

test("bounded batches flush at their limit and disposal flush preserves unsent output", () => {
  const { output, lines, tick } = fixture(2);
  output.send(token(1, "a")); output.send(token(2, "b", "other"));
  expect(lines.map((line) => JSON.parse(line))).toEqual([[token(1, "a"), token(2, "b", "other")]]);
  output.send(token(3, "c")); output.flush(); tick();
  expect(lines.map((line) => JSON.parse(line))).toEqual([[token(1, "a"), token(2, "b", "other")], [token(3, "c")]]);
});
