import { expect, test } from "bun:test";
import { PiAdapter } from "../src/pi-adapter";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const adapter = new PiAdapter(() => {});
  const sent: string[] = [];
  const session = {
    isStreaming: true, agent: { state: { model: undefined }, followUp: (message: { content: Array<{ text: string }> }) => { sent.push(message.content[0]!.text); } }, clears: 0,
    steer: async (text: string) => { sent.push(text); },
    followUp: async (text: string) => { sent.push(text); },
    clearQueue: () => { session.clears++; },
  };
  const internals = adapter as unknown as {
    sessions: Map<string, typeof session>; runs: Map<string, typeof session>; activeRunIds: Map<string, string>;
  };
  internals.sessions.set("s", session);
  internals.runs.set("run", session);
  internals.activeRunIds.set("s", "run");
  return { adapter, session, sent, runs: internals.activeRunIds };
}

test("live input delivery is serialized in submission order", async () => {
  const f = fixture();
  let finishFirst!: () => void;
  const wait = new Promise<void>((resolve) => { finishFirst = resolve; });
  f.session.steer = async (text) => { f.sent.push(text); if (text === "first") await wait; };
  const first = f.adapter.sendToSession("s", "first", "steer");
  const second = f.adapter.sendToSession("s", "second", "steer");
  await tick();
  expect(f.sent).toEqual(["first"]);
  finishFirst();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(f.sent).toEqual(["first", "second"]);
});

test("internal follow-ups are written to Pi's queue synchronously", () => {
  const f = fixture();
  expect(f.adapter.queueFollowUpNow("s", "notification")).toBe(true);
  expect(f.sent).toEqual(["notification"]);
});

test("a stale expected run is rejected before any input is queued", async () => {
  const f = fixture();
  expect(await f.adapter.sendToSession("s", "stale", "steer", undefined, "ended-run")).toBe(false);
  expect(f.sent).toEqual([]);
});

test("a run ending during attachment preparation cannot leave an orphaned input", async () => {
  const f = fixture();
  Object.defineProperty(f.session.agent.state, "model", {
    get: () => { queueMicrotask(() => { f.session.isStreaming = false; f.runs.delete("s"); }); return undefined; },
  });
  expect(await f.adapter.sendToSession("s", "too late", "steer")).toBe(false);
  expect(f.sent).toEqual([]);
});

test("a queued request never targets the replacement run after waiting behind another request", async () => {
  const f = fixture();
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  f.session.steer = async (text) => { f.sent.push(text); await wait; };
  const first = f.adapter.sendToSession("s", "first", "steer");
  const second = f.adapter.sendToSession("s", "second", "steer");
  await tick();
  f.runs.set("s", "replacement");
  finish();
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  expect(f.sent).toEqual(["first"]);
  expect(f.session.clears).toBe(0);
});

test("input left by Pi's asynchronous handlers is cleared if its run already ended", async () => {
  const f = fixture();
  f.session.steer = async (text) => { f.sent.push(text); f.session.isStreaming = false; };
  expect(await f.adapter.sendToSession("s", "orphan", "steer")).toBe(false);
  expect(f.session.clears).toBe(1);
});

test("a rejected input does not poison later submissions", async () => {
  const f = fixture();
  f.session.steer = async (text) => { if (text === "bad") throw new Error("rejected"); f.sent.push(text); };
  const first = f.adapter.sendToSession("s", "bad", "steer");
  const second = f.adapter.sendToSession("s", "next", "follow_up");
  await expect(first).rejects.toThrow("rejected");
  expect(await second).toBe(true);
  expect(f.sent).toEqual(["next"]);
});
