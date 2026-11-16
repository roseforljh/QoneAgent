import { expect, test } from "bun:test";
import { closeDb, GoalRepo, MessageRepo, openDb, QueueRepo, RunRepo, SessionRepo, SettingsRepo, SubagentRunRepo, TurnRepo, WorkspaceRepo } from "@qone/database";
import { decodeCommand, type RuntimeCommand } from "@qone/protocol";
import { handleRuntimeCommand } from "../src/runtime-commands";
import { handleSessionCommand } from "../src/session-commands";

function fixture() {
  const db = openDb(":memory:"), workspaceRepo = new WorkspaceRepo(db), sessionRepo = new SessionRepo(db);
  const workspace = workspaceRepo.upsert("test", process.cwd()), session = sessionRepo.create("test", workspace.id);
  const runRepo = new RunRepo(db), queueRepo = new QueueRepo(new SettingsRepo(db));
  const item = { id: "queued", sessionId: session.id, text: "objective", lane: "queue" as const, status: "queued" as const, position: 0, createdAt: 1, updatedAt: 1 };
  queueRepo.replace(session.id, [item]);
  const sent: unknown[] = [], events: string[] = [];
  const state = {
    sessionRepo, workspaceRepo, runRepo, queueRepo, goalRepo: new GoalRepo(db), messageRepo: new MessageRepo(db),
    turnRepo: new TurnRepo(db), subagentRunRepo: new SubagentRunRepo(db),
    startingRunSessions: new Set<string>(), cancelledRuns: new Set<string>(), goalContinuationTimers: new Map(), titleControllers: new Map(),
    assistantPartsByRun: new Map(), liveAssistantByRun: new Map(), initialUserMessageSeen: new Set(),
    assistantBuffers: new Map(), assistantStreamBuffers: new Map(), assistantMessageSequenceByRun: new Map(), assistantRawMessagesByRun: new Map(), toolCallIds: new Map(),
    ensureModelsReady: async () => {}, adapter: { isRunning: () => false, disposeSession: async () => {}, run: async () => {} },
    persistPartialAssistant: () => undefined, releaseUndeliveredSteers: () => {}, touchSession: () => {},
    releaseBrowserSession: async () => {}, scheduleGoalContinuation: () => {}, publishGoal: () => {}, sendQueue: () => {},
    send: (event: unknown) => { sent.push(event); }, emit: (type: string) => { events.push(type); },
    handle: async (_command: RuntimeCommand): Promise<void> => {},
  };
  const services = state as unknown as Parameters<typeof handleRuntimeCommand>[1];
  state.handle = async command => { await handleRuntimeCommand(command, services); };
  return { db, session, item, services, state, sent, events };
}

for (const invalid of ["replacement", "workspace"] as const) test(`rejected ${invalid} leaves its complete queue input unconsumed`, async () => {
  const f = fixture();
  try {
    if (invalid === "replacement") Object.assign(f.state, { subagentController: { dispose: async () => {} } });
    else f.state.workspaceRepo.get = () => undefined;
    await handleRuntimeCommand({ type: "agent.run", requestId: "rejected", sessionId: f.session.id,
      message: f.item.text, queueItemId: f.item.id, ...(invalid === "replacement" ? { replaceFromMessageId: "missing" } : {}) }, f.services);
    expect(f.state.queueRepo.list(f.session.id)).toEqual([f.item]);
    expect(f.state.runRepo.listBySession(f.session.id)).toEqual([]);
    expect(f.events).not.toContain("agent.started");
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "error", requestId: "rejected" }));
  } finally { closeDb(f.db); }
});

for (const invalid of ["workspace", "goal"] as const) test(`invalid ${invalid} is rejected before disposing or rewriting existing history`, async () => {
  const f = fixture();
  let disposed = false;
  Object.assign(f.state, { subagentController: { dispose: async () => { disposed = true; } } });
  try {
    const original = f.state.messageRepo.add(f.session.id, "user", "keep this history");
    const history = f.state.messageRepo.listBySession(f.session.id);
    if (invalid === "workspace") f.state.workspaceRepo.get = () => undefined;
    await handleRuntimeCommand({ type: "agent.run", requestId: "rewrite", sessionId: f.session.id,
      message: f.item.text, queueItemId: f.item.id, replaceFromMessageId: original.id, goal: invalid === "goal" }, f.services);
    expect(disposed).toBe(false);
    expect(f.state.messageRepo.listBySession(f.session.id)).toEqual(history);
    expect(f.state.queueRepo.list(f.session.id)).toEqual([f.item]);
    expect(f.sent).toContainEqual({ type: "error", requestId: "rewrite", message: invalid === "goal" ? "goal is not active" : "session workspace no longer exists" });
  } finally { closeDb(f.db); }
});

test("a cooperative stop waits for children, then a forced stop settles once and the conversation accepts another run", async () => {
  const f = fixture();
  let rejectRun!: (error: Error) => void, releaseChildren!: () => void;
  const children = new Promise<void>(resolve => { releaseChildren = resolve; });
  let active = false;
  Object.assign(f.state, { subagentController: { stopChildren: async (_session: string, _run: string, force: boolean) => { if (force) releaseChildren(); await children; } } });
  Object.assign(f.state.adapter, { isRunning: () => active, run: async () => {
    active = true;
    try { await new Promise<void>((_resolve, reject) => { rejectRun = reject; }); } finally { active = false; }
  }, stop: () => true, forceStop: () => { rejectRun(new Error("run aborted")); return true; } });
  try {
    const command = { type: "agent.run" as const, requestId: "run", sessionId: f.session.id, message: "first", queueItemId: f.item.id };
    await handleRuntimeCommand(command, f.services);
    await Promise.resolve();
    const runId = f.state.runRepo.listBySession(f.session.id)[0]!.id;
    const next = { ...f.item, id: "next-input", text: "next" };
    f.state.queueRepo.replace(f.session.id, [next]);
    const stopping = handleRuntimeCommand({ type: "agent.stop", requestId: "stop", runId }, f.services);
    await Promise.resolve();
    expect(f.events).not.toContain("agent.cancelled");
    await handleRuntimeCommand({ type: "agent.stop", requestId: "force", runId, force: true }, f.services);
    await stopping;
    await new Promise(resolve => setImmediate(resolve));
    expect(f.events.filter(type => type === "agent.cancelled")).toHaveLength(1);
    expect(f.state.runRepo.get(runId)?.status).toBe("cancelled");
    expect(f.state.turnRepo.listByRun(runId).map(turn => turn.status)).toEqual(["cancelled"]);
    expect(f.state.queueRepo.list(f.session.id)).toEqual([next]);
    f.state.adapter.run = async () => {};
    await handleRuntimeCommand({ ...command, requestId: "next", message: next.text, queueItemId: next.id }, f.services);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.state.runRepo.listBySession(f.session.id).map(run => run.status).sort()).toEqual(["cancelled", "completed"]);
    expect(f.state.queueRepo.list(f.session.id)).toEqual([]);
    expect(f.state.messageRepo.listBySession(f.session.id).map(message => message.content)).toEqual(["first", "next"]);
  } finally { closeDb(f.db); }
});

test("queued Goal kickoff keeps queue identity through decoding and consumes only after runtime acceptance", async () => {
  const f = fixture();
  try {
    const command = decodeCommand(JSON.stringify({ type: "goal.start", requestId: "goal", sessionId: f.session.id, objective: f.item.text, queueItemId: f.item.id }));
    if (command?.type !== "goal.start") throw new Error("invalid goal command");
    expect(command.queueItemId).toBe(f.item.id);
    await handleSessionCommand(command, f.services);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.events).toContain("agent.started");
    expect(f.events).toContain("agent.completed");
    expect(f.state.queueRepo.list(f.session.id)).toEqual([]);
    expect(f.state.runRepo.listBySession(f.session.id)[0]?.status).toBe("completed");
    // A delayed pre-acceptance client snapshot cannot resurrect the Goal input.
    f.state.queueRepo.replace(f.session.id, [f.item]);
    expect(f.state.queueRepo.list(f.session.id)).toEqual([]);
    expect(f.state.messageRepo.listBySession(f.session.id).map(message => message.content)).toEqual([f.item.text]);
  } finally { closeDb(f.db); }
});
