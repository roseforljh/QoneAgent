import { describe, expect, test } from "bun:test";
import { closeDb, MessageRepo, openDb, RunRepo, SessionRepo, SubagentRunRepo, WorkspaceRepo } from "@qone/database";
import type { SubagentConfigInfo } from "@qone/protocol";
import type { PiAdapter } from "../src/pi-adapter";
import { registerSubagentDispatcher, type SubagentController } from "../src/subagent-runner";
import { installSubagentFinalizationGuard } from "../src/subagent-finalization-guard";
import { buildSubagentNotificationPrompt, isSubagentUpdatePrompt, SUBAGENT_AGENT_MESSAGE_MARKER } from "../src/subagent-notifications";
import { withRuntimeLocale } from "../src/runtime-localization";

const config: SubagentConfigInfo = {
  profiles: [], routing: {},
  runtime: {
    temporaryModelId: "", maxConcurrent: 1, timeoutMs: 30_000, tokenBudget: 0,
    contextMode: "task-only", contextMessages: 0, allowNested: true,
    maxDepth: 3, workflowMaxSteps: 32, backgroundEnabled: true,
  },
  updatedAt: 1,
};

function harness(options: {
  run: (id: string, prompt: string, stop: (error: Error) => void) => Promise<void>;
  maxConcurrent?: number;
  queueAccepted?: boolean;
}) {
  const db = openDb(":memory:");
  const workspaceRepo = new WorkspaceRepo(db);
  const workspace = workspaceRepo.upsert("test", process.cwd());
  const sessionRepo = new SessionRepo(db);
  const session = sessionRepo.create("concurrency", workspace.id);
  const runRepo = new RunRepo(db);
  const parent = runRepo.create(session.id);
  const repo = new SubagentRunRepo(db);
  const messages = new MessageRepo(db);
  let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
  const queued: { sessionId: string; message: string; runId?: string }[] = [];
  const stops = new Map<string, (error: Error) => void>();
  const adapter = {
    setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
    run: async (_sessionId: string, prompt: string, opts: { runId?: string }) => {
      const id = opts.runId ?? "";
      const stopped = new Promise<never>((_, reject) => stops.set(id, reject));
      await Promise.race([options.run(id, prompt, (error) => stops.get(id)?.(error)), stopped]);
    },
    stop: (id: string) => { stops.get(id)?.(new Error("stopped")); return true; },
    disposeSession: async () => undefined,
    queueSubagentUpdateNow: (sessionId: string, message: string, runId?: string) => {
      queued.push({ sessionId, message, runId });
      return options.queueAccepted ?? true;
    },
  } as unknown as PiAdapter;
  const runtime = { ...config.runtime, maxConcurrent: options.maxConcurrent ?? 1 };
  const controller: SubagentController = registerSubagentDispatcher({
    adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
    config: () => ({ ...config, runtime }), partsByRun: new Map(), messageSequenceByRun: new Map(),
    assistantBuffers: new Map(), streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(),
    // Mirrors index.ts: a root parent's messages live in the conversation table.
    appendParentMessage: (sessionId, runId, content, communication, rawMessage) => {
      messages.add(sessionId, "user", content, runId, undefined, undefined, undefined, undefined, undefined, undefined, rawMessage, communication);
    },
    publish: () => undefined, emit: () => undefined,
  });
  return {
    db, session, parent, runRepo, repo, messages, controller,
    dispatch: (input: Parameters<typeof dispatch>[0]) => dispatch(input), queued,
    // Settle every live job before the in-memory database closes.
    cleanup: async () => { await controller.dispose(session.id).catch(() => undefined); closeDb(db); },
  };
}

const input = (sessionId: string, parentRunId: string, toolCallId: string, extra: Record<string, unknown> = {}) => ({
  parentSessionId: sessionId, parentRunId, title: `任务 ${toolCallId}`, task: "执行任务",
  reason: "需要独立执行", expectedResult: "返回结论", toolCallId,
  fallbackModel: "provider/main", permissionMode: "ask" as const, ...extra,
});

describe("parent and child concurrency", () => {
  test("a nested parent waiting on a child yields its permit so maxConcurrent=1 cannot deadlock", async () => {
    const h = harness({
      maxConcurrent: 1,
      run: async (id) => {
        // The outer child delegates a nested child and then waits for it.
        if (id && h.repo.get(id)?.depth === 1 && !waiting.has(id)) {
          waiting.add(id);
          const nested = await h.dispatch(input(`${h.session.id}::subagent::${id}`, id, "nested-call", { background: true }));
          const nestedRunId = /runId=(\S+)/.exec(nested)![1]!;
          const info = await h.controller.wait(nestedRunId, 5_000, undefined, id);
          expect(info.status).toBe("completed");
        }
      },
    });
    const waiting = new Set<string>();
    try {
      const outer = JSON.parse(await h.dispatch(input(h.session.id, h.parent.id, "outer-call"))) as { runId: string };
      // The outer child completed only because the nested child got the permit.
      expect(h.runRepo.get(outer.runId)?.status).toBe("completed");
      expect(h.repo.listBySession(h.session.id)).toHaveLength(2);
    } finally {
      await h.cleanup();
    }
  });

  test("a nested parent that is woken by its child's message answers and finishes", async () => {
    const h = harness({
      maxConcurrent: 1,
      run: async (id) => {
        const row = id ? h.repo.get(id) : undefined;
        if (!row || row.depth !== 1 || waiting.has(id)) return;
        waiting.add(id);
        const nested = await h.dispatch(input(`${h.session.id}::subagent::${id}`, id, "nested-call", { background: true }));
        const nestedRunId = /runId=(\S+)/.exec(nested)![1]!;
        // The nested child asks a question while the outer child is parked.
        h.controller.messageParent(nestedRunId, "请确认目录");
        const info = await h.controller.wait(nestedRunId, 5_000, undefined, id);
        expect(info.status).toBe("completed");
        // A nested parent's transcript owns the message; the root conversation
        // is not addressed by a child of a child.
        expect(h.repo.listMessages(id).some((message) => message.content === "请确认目录")).toBe(true);
        // The outer child can still reply; delivery is asynchronous by design.
        await h.controller.control(nestedRunId, "follow_up", "用 src 目录", undefined, id);
      },
    });
    const waiting = new Set<string>();
    try {
      const outer = JSON.parse(await h.dispatch(input(h.session.id, h.parent.id, "outer-call"))) as { runId: string };
      expect(h.runRepo.get(outer.runId)?.status).toBe("completed");
    } finally {
      await h.cleanup();
    }
  });

  test("wait resolves from the job promise instead of polling", async () => {
    let release!: () => void;
    const h = harness({ run: () => new Promise<void>((resolve) => { release = resolve; }) });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const child = h.repo.listBySession(h.session.id)[0]!;
      let settled = false;
      const waiting = h.controller.wait(child.runId, 5_000).then((info) => { settled = true; return info; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      release();
      expect((await waiting).status).toBe("completed");
    } finally {
      await h.cleanup();
    }
  });

  test("a wait timeout returns the live state and leaves the child running", async () => {
    let release!: () => void;
    const h = harness({ run: () => new Promise<void>((resolve) => { release = resolve; }) });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const child = h.repo.listBySession(h.session.id)[0]!;
      const info = await h.controller.wait(child.runId, 20);
      expect(info.status).toBe("running");
      release();
      expect((await h.controller.wait(child.runId, 5_000)).status).toBe("completed");
    } finally {
      await h.cleanup();
    }
  });

  test("an aborted wait rejects and the child still finishes", async () => {
    let release!: () => void;
    const h = harness({ run: () => new Promise<void>((resolve) => { release = resolve; }) });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const child = h.repo.listBySession(h.session.id)[0]!;
      const abort = new AbortController();
      const waiting = h.controller.wait(child.runId, 5_000, abort.signal);
      abort.abort(new Error("parent cancelled"));
      await expect(waiting).rejects.toThrow("parent cancelled");
      release();
      expect((await h.controller.wait(child.runId, 5_000)).status).toBe("completed");
    } finally {
      await h.cleanup();
    }
  });
});

describe("bidirectional agent messaging", () => {
  test("child → parent is persisted on both transcripts with structured source and delivered live", async () => {
    let release!: () => void;
    const h = harness({ run: () => new Promise<void>((resolve) => { release = resolve; }) });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const child = h.repo.listBySession(h.session.id)[0]!;
      const result = h.controller.messageParent(child.runId, "需要确认目标路径");
      expect(result).toEqual({ delivered: true, toId: h.parent.id });
      expect(h.queued).toHaveLength(1);
      expect(h.queued[0]!.message.startsWith(SUBAGENT_AGENT_MESSAGE_MARKER)).toBe(true);
      expect(h.queued[0]!.runId).toBe(h.parent.id);
      const childMessage = h.repo.listMessages(child.runId).find((message) => message.communication)!;
      expect(JSON.parse(childMessage.communication!)).toEqual({
        fromId: child.runId, fromTitle: child.title, toId: h.parent.id, toTitle: "concurrency",
      });
      const parentMessage = h.messages.listBySession(h.session.id).find((message) => message.communication)!;
      expect(parentMessage.content).toBe("需要确认目标路径");
      expect(JSON.parse(parentMessage.communication!)).toEqual({
        fromId: child.runId, fromTitle: child.title, toId: h.parent.id, toTitle: "concurrency",
      });
      expect(isSubagentUpdatePrompt({ message: { role: "user", content: [{ type: "text", text: h.queued[0]!.message }] } })).toBe(true);
      release();
    } finally {
      await h.cleanup();
    }
  });

  test("an idle parent records the message without claiming delivery", async () => {
    const h = harness({ run: async () => undefined, queueAccepted: false });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const child = h.repo.listBySession(h.session.id)[0]!;
      expect(h.controller.messageParent(child.runId, "进度说明").delivered).toBe(false);
      expect(h.messages.listBySession(h.session.id).filter((message) => message.communication)).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test("parent → child follow-up carries the parent as the structured source", async () => {
    const h = harness({ run: async () => undefined });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call"));
      const child = h.repo.listBySession(h.session.id)[0]!;
      h.controller.acknowledge(child.runId);
      await h.controller.control(child.runId, "follow_up", "继续检查");
      const message = h.repo.listMessages(child.runId).filter((row) => row.content === "继续检查").at(-1)!;
      expect(JSON.parse(message.communication!)).toEqual({
        fromId: h.parent.id, fromTitle: "concurrency", toId: child.runId, toTitle: child.title,
      });
    } finally {
      await h.cleanup();
    }
  });
});

describe("finalization gate", () => {
  function guard(h: ReturnType<typeof harness>) {
    const steers: string[] = [];
    const pushed: string[] = [];
    let queued = false;
    const agent = {
      hasQueuedMessages: () => queued,
      steer: (message: { content: { text: string }[] }) => { steers.push(message.content[0]!.text); },
    };
    const session = { agent } as never;
    installSubagentFinalizationGuard(session, {
      runId: () => h.parent.id,
      controller: () => h.controller,
      push: (type) => pushed.push(type),
      eventSessionId: h.session.id,
    });
    const finishTurn = (session as unknown as { agent: { finishTurn: (turn: unknown, signal: AbortSignal) => Promise<unknown> } }).agent.finishTurn;
    return { finishTurn, steers, pushed, setQueued: (value: boolean) => { queued = value; } };
  }
  const textTurn = { message: { stopReason: "stop", content: [{ type: "text", text: "已完成" }] } };
  const toolTurn = { message: { stopReason: "stop", content: [{ type: "toolCall", id: "call" }] } };

  test("a tool turn never waits: the parent keeps working while a child runs", async () => {
    let release!: () => void;
    const h = harness({ run: () => new Promise<void>((resolve) => { release = resolve; }) });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const { finishTurn, pushed } = guard(h);
      // finishTurn runs after every tool batch; gating here stalled the parent.
      await expect(finishTurn(toolTurn, new AbortController().signal)).resolves.toBeUndefined();
      expect(pushed).toEqual([]);
      release();
    } finally {
      await h.cleanup();
    }
  });

  test("queued input is processed instead of waiting for the child", async () => {
    const h = harness({ run: () => new Promise<void>(() => {}) });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const { finishTurn, pushed, setQueued } = guard(h);
      setQueued(true);
      await expect(finishTurn(textTurn, new AbortController().signal)).resolves.toBeUndefined();
      expect(pushed).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  test("a text turn waits for the child, then asks for finalize and gates the answer", async () => {
    let release!: () => void;
    const h = harness({ run: () => new Promise<void>((resolve) => { release = resolve; }) });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const child = h.repo.listBySession(h.session.id)[0]!;
      const { finishTurn, steers, pushed } = guard(h);

      let settled = false;
      const waiting = finishTurn(textTurn, new AbortController().signal).then((value) => { settled = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      // The gate holds the final answer while the child is still running.
      expect(settled).toBe(false);
      expect(pushed).toEqual(["agent.waiting_subagents"]);

      release();
      await h.controller.wait(child.runId, 5_000);
      expect(await waiting).toEqual({ action: "continue" });
      expect(steers.at(-1)).toContain("call finalize_response");
      expect(h.controller.finalize(h.parent.id, [child.runId]).ok).toBe(false);
      h.controller.acknowledge(child.runId);
      expect(h.controller.finalize(h.parent.id, [child.runId])).toEqual({ ok: true, missing: [] });
    } finally {
      await h.cleanup();
    }
  });

  test("an aborted turn during the gate wait resolves instead of hanging", async () => {
    const h = harness({ run: () => new Promise<void>(() => {}) });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const { finishTurn } = guard(h);
      const abort = new AbortController();
      const waiting = finishTurn(textTurn, abort.signal);
      abort.abort(new Error("cancelled"));
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });

  test("a child's message wakes a parent that is waiting in the gate", async () => {
    let release!: () => void;
    const h = harness({ run: () => new Promise<void>((resolve) => { release = resolve; }) });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const child = h.repo.listBySession(h.session.id)[0]!;
      const { finishTurn, steers } = guard(h);
      let settled = false;
      const waiting = finishTurn(textTurn, new AbortController().signal).then((value) => { settled = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      // The child asks a question; the parent must wake and answer instead of
      // both sides waiting on each other.
      h.controller.messageParent(child.runId, "请确认目标目录");
      expect(await waiting).toEqual({ action: "continue" });
      expect(steers.at(-1)).toContain("Required subagent results remain unresolved");
      release();
    } finally {
      await h.cleanup();
    }
  });
});

describe("terminal resource reclamation", () => {
  test("a finished child leaves no live job, buffer, waiter or deferred start", async () => {
    const h = harness({ run: async () => undefined });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const child = h.repo.listBySession(h.session.id)[0]!;
      await h.controller.wait(child.runId, 5_000);
      // A completed child no longer accepts control or blocks the gate.
      await expect(h.controller.control(child.runId, "stop")).rejects.toThrow("not active");
      expect(h.controller.dependencyStatus(h.parent.id).blocking.map((info) => info.id)).toEqual([child.runId]);
      h.controller.acknowledge(child.runId);
      expect(h.controller.dependencyStatus(h.parent.id).blocking).toEqual([]);
      // Disposing the session is idempotent after the child already settled.
      await h.controller.dispose(h.session.id);
      await h.controller.dispose(h.session.id);
    } finally {
      await h.cleanup();
    }
  });

  test("dispose interrupts running children and settles their jobs", async () => {
    let started = 0;
    const h = harness({ run: () => { started++; return new Promise<void>(() => {}); } });
    try {
      await h.dispatch(input(h.session.id, h.parent.id, "call", { background: true }));
      const child = h.repo.listBySession(h.session.id)[0]!;
      await h.controller.dispose(h.session.id);
      expect(started).toBe(1);
      expect(h.runRepo.get(child.runId)?.status).toBe("cancelled");
      // A cancelled child is not retryable: inspecting it exhausts the dependency.
      h.controller.acknowledge(child.runId);
      expect(h.controller.query(child.runId)?.dependencyState).toBe("exhausted");
      expect(h.controller.dependencyStatus(h.parent.id).blocking).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  test("finalization guard stops steering after repeated reminders when no child is active and marks internal messages", async () => {
    const steered: unknown[] = [];
    const session = {
      agent: {
        hasQueuedMessages: () => false,
        steer: (message: unknown) => { steered.push(message); },
      },
    };
    const controller = {
      dependencyStatus: () => ({
        blocking: [{ id: "child-1", status: "completed" }],
        unacknowledged: [],
        retryRequired: [],
        requiresFinalization: true,
        authorized: false,
      }),
      waitForDependencyChange: async () => {},
    } as unknown as SubagentController;
    installSubagentFinalizationGuard(session, {
      runId: () => "run-1",
      controller: () => controller,
      push: () => {},
      eventSessionId: "session-1",
    });
    const finishTurn = (session.agent as unknown as { finishTurn: (turn: unknown, signal: AbortSignal) => Promise<unknown> }).finishTurn;
    const turn = { message: { stopReason: "stop", content: [{ type: "text", text: "done" }] } };
    const signal = new AbortController().signal;
    expect(await finishTurn(turn, signal)).toEqual({ action: "continue" });
    expect(await finishTurn(turn, signal)).toEqual({ action: "continue" });
    expect(await finishTurn(turn, signal)).toEqual({ action: "continue" });
    // 超过重试上限后放行，防止弱模型无限循环
    expect(await finishTurn(turn, signal)).toBeUndefined();
    expect(steered).toHaveLength(3);
    expect(isSubagentUpdatePrompt(steered[0])).toBe(true);
    expect(isSubagentUpdatePrompt({ role: "user", content: [{ type: "text", text: "plain" }], qoneInternal: true })).toBe(true);
  });

  test("subagent notification prompts follow runtime locale instead of hardcoding Chinese", () => {
    const notice = {
      id: "n1", sessionId: "s1", subagentRunId: "r1", version: 1, kind: "completed" as const, title: "Audit", status: "pending" as const, createdAt: 1,
    };
    const enText = withRuntimeLocale("en", () => buildSubagentNotificationPrompt([notice]));
    expect(enText).toContain("Background subagent status update:");
    expect(enText).toContain("completed");
    const zhText = withRuntimeLocale("zh-CN", () => buildSubagentNotificationPrompt([notice]));
    expect(zhText).toContain("后台子代理状态更新：");
    expect(zhText).toContain("已完成");
  });
});
