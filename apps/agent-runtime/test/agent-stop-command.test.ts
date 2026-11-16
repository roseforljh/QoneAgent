import { expect, test } from "bun:test";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { handleRuntimeCommand } from "../src/runtime-commands";

function services(run: { id: string; sessionId: string; status: string }, adapterKnowsRun: boolean) {
  const sent: RuntimeEvent[] = [];
  const emitted: string[] = [];
  const finished: string[] = [];
  const fake = {
    runRepo: { get: () => run, finish: (_id: string, status: string) => { finished.push(status); } },
    adapter: { stop: () => adapterKnowsRun, forceStop: () => adapterKnowsRun },
    cancelledRuns: new Set<string>(),
    subagentController: { stopChildren: async () => {} },
    assistantPartsByRun: new Map(), assistantBuffers: new Map(), assistantStreamBuffers: new Map(),
    assistantMessageSequenceByRun: new Map(), assistantRawMessagesByRun: new Map(), liveAssistantByRun: new Map(),
    initialUserMessageSeen: new Set(), toolCallIds: new Map(),
    persistPartialAssistant: () => undefined, releaseUndeliveredSteers: () => {},
    turnRepo: { listByRun: () => [{ id: "turn", status: "running" }], finish: () => {} },
    approvalRuns: new Map(), approvalToolCalls: new Map(), commandApprovals: { reject: () => {} },
    titleControllers: new Map(),
    goalRepo: { get: () => undefined },
    send: (event: RuntimeEvent) => { sent.push(event); },
    emit: (type: string) => { emitted.push(type); },
  };
  return { fake: fake as unknown as Parameters<typeof handleRuntimeCommand>[1], sent, emitted, finished };
}
const stop = (force?: boolean): RuntimeCommand => ({ type: "agent.stop", requestId: "stop", runId: "run-1", ...(force ? { force } : {}) });

test("a forced stop closes a run whose record is stuck active after execution ended", async () => {
  const stuck = services({ id: "run-1", sessionId: "s", status: "running" }, false);
  await handleRuntimeCommand(stop(true), stuck.fake);
  expect(stuck.finished).toEqual(["cancelled"]);
  expect(stuck.emitted).toEqual(["agent.cancelled"]);
  expect(stuck.sent).toEqual([{ type: "pong", requestId: "stop" }]);

  // A normal stop of the same stale record reports it instead of rewriting history.
  const normal = services({ id: "run-1", sessionId: "s", status: "running" }, false);
  await handleRuntimeCommand(stop(), normal.fake);
  expect(normal.finished).toEqual([]);
  expect(normal.sent[0]).toMatchObject({ type: "error", requestId: "stop" });

  // A run that already ended is never reopened or re-closed.
  const ended = services({ id: "run-1", sessionId: "s", status: "completed" }, false);
  await handleRuntimeCommand(stop(true), ended.fake);
  expect(ended.finished).toEqual([]);
  expect(ended.sent[0]).toMatchObject({ type: "error" });
});

test("concurrent forced stale stops close the run only once after descendants settle", async () => {
  const run = { id: "run-1", sessionId: "s", status: "running" };
  const fixture = services(run, false);
  let release!: () => void;
  const children = new Promise<void>(resolve => { release = resolve; });
  fixture.fake.subagentController.stopChildren = () => children;
  fixture.fake.runRepo.finish = (_id, status) => { run.status = status; fixture.finished.push(status); };
  const first = handleRuntimeCommand(stop(true), fixture.fake), second = handleRuntimeCommand(stop(true), fixture.fake);
  expect(fixture.emitted).toEqual([]);
  release();
  await Promise.all([first, second]);
  expect(fixture.finished).toEqual(["cancelled"]);
  expect(fixture.emitted).toEqual(["agent.cancelled"]);
});

test("a live run is stopped through the adapter and marked cancelled", async () => {
  const live = services({ id: "run-1", sessionId: "s", status: "running" }, true);
  await handleRuntimeCommand(stop(true), live.fake);
  expect(live.fake.cancelledRuns.has("run-1")).toBe(true);
  expect(live.sent).toEqual([{ type: "pong", requestId: "stop" }]);
});
