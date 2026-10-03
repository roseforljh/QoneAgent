import { expect, test } from "bun:test";
import { runtimeEvents } from "../src/lib/runtime-event-payload";

test("Channel batches and legacy encoded NDJSON yield the same ordered typed events", () => {
  const a = { type: "pong", requestId: "a" }, b = { type: "runtime.exited" }, c = { type: "session.queue", sessionId: "s", items: [] };
  expect([...runtimeEvents([a, [JSON.stringify([b]), c]])]).toEqual([a, b, c]);
  expect([...runtimeEvents(JSON.stringify([a, b, c]))]).toEqual([a, b, c]);
  expect([...runtimeEvents(JSON.stringify(a))]).toEqual([a]);
});

test("malformed, null and primitive values do not interrupt subsequent valid events", () => {
  const valid = { type: "pong", requestId: "valid", text: 'embedded "type":"runtime.exited"' };
  expect([...runtimeEvents([null, undefined, 1, true, "invalid", "null", {}, { type: 1 }, [[valid]]])]).toEqual([valid]);
  let payload: unknown = valid;
  for (let index = 0; index < 2000; index++) payload = [payload];
  expect([...runtimeEvents(payload)]).toEqual([valid]);
});
