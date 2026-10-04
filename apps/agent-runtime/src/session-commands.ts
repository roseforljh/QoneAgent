import { runtimeErrorInfo } from "./runtime-localization";
import type { RuntimeCommand, RuntimeEvent, WorkspaceInfo } from "@qone/protocol";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { listWorkspaceFiles, readWorkspaceFile, workspaceGit, workspaceDiff } from "./workspace.js";
import { readFilePreview } from "./file-preview.js";
import { subagentInfo } from "./subagent-runner.js";
import { generatedSessionTitle, provisionalSessionTitle } from "./session-title.js";
import type { runtimeCommandServices } from "./index.js";

export async function handleSessionCommand(cmd: RuntimeCommand, services: ReturnType<typeof runtimeCommandServices>): Promise<boolean> {
  switch (cmd.type) {
    case "session.snapshot": {
      const events: RuntimeEvent[] = [];
      const snapshotServices = { ...services, send: (event: RuntimeEvent) => { events.push(event); } };
      const requests: RuntimeCommand[] = [
        { type: "session.messages", requestId: cmd.requestId, sessionId: cmd.sessionId },
        { type: "goal.get", requestId: cmd.requestId, sessionId: cmd.sessionId },
        { type: "session.queue.list", requestId: cmd.requestId, sessionId: cmd.sessionId },
        { type: "session.toolCalls", requestId: cmd.requestId, sessionId: cmd.sessionId },
        { type: "session.runs", requestId: cmd.requestId, sessionId: cmd.sessionId },
        { type: "session.subagents", requestId: cmd.requestId, sessionId: cmd.sessionId },
        { type: "session.subagentNotifications", requestId: cmd.requestId, sessionId: cmd.sessionId },
        { type: "artifact.list", requestId: cmd.requestId, sessionId: cmd.sessionId },
      ];
      const pending = requests.map((request) => handleSessionCommand(request, snapshotServices));
      services.sendBatch(events);
      await Promise.all(pending);
      return true;
    }
    case "ping":
      services.send({
        type: "pong",
        requestId: cmd.requestId,
        compaction: services.adapter.getCompactionPreferences(),
        capabilities: [
          "model.resolve-metadata",
          "model.metadata-sources",
          "workspace.explorer.v2",
          "workspace.files",
          "workspace.git",
          "workspace.gitDiff",
          "file.read",
          "file.preview",
          "browser.connect",
          "reach.channels",
          "reach.podcast.configure",
          "subagents.v1",
          "subagent.notifications",
          "session.snapshot",
        ],
      });
      return true;

    case "session.create": {
      if (!services.workspaceRepo.get(cmd.workspaceId)) {
        services.send({ type: "error", requestId: cmd.requestId, message: `unknown workspace ${cmd.workspaceId}` });
        return true;
      }
      const s = services.sessionRepo.create(cmd.title, cmd.workspaceId);
      services.send({ type: "session.created", session: services.toInfo(s) });
      return true;
    }

    case "session.side-chat.create": {
      try {
        const session = services.sideConversations.create(cmd);
        services.projectResources.session(session);
        services.send({ type: "session.side-chat.created", requestId: cmd.requestId, sessionId: cmd.sessionId, queueItemId: cmd.queueItemId, session: session });
        if (cmd.queueItemId) services.sendQueue(cmd.sessionId);
        services.sendMessages(session.id);
        services.sendQueue(session.id);
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return true;
    }

    case "session.generate-title": {
      const provisional = provisionalSessionTitle(cmd.prompt);
      const current = services.sessionRepo.get(cmd.sessionId);
      if (!current) {
        services.send({ type: "error", requestId: cmd.requestId, message: `unknown session ${cmd.sessionId}` });
        return true;
      }
      if (current.title !== "New session") {
        services.send({ type: "session.renamed", session: services.toInfo(current) });
        return true;
      }
      services.send({ type: "session.renamed", session: services.toInfo(services.sessionRepo.rename(cmd.sessionId, provisional)) });
      const controller = new AbortController();
      services.titleControllers.set(cmd.sessionId, controller);
      try {
        const title = generatedSessionTitle(await services.adapter.generateTitle(cmd.prompt, cmd.model, controller.signal));
        if (!controller.signal.aborted && title && services.sessionRepo.get(cmd.sessionId)?.title === provisional && title !== provisional) {
          services.send({ type: "session.renamed", session: services.toInfo(services.sessionRepo.rename(cmd.sessionId, title)) });
        }
      } catch (error) {
        if (!controller.signal.aborted) services.log.warn("title generation failed", { sessionId: cmd.sessionId, error: String(error) });
      } finally {
        if (services.titleControllers.get(cmd.sessionId) === controller) services.titleControllers.delete(cmd.sessionId);
      }
      return true;
    }

    case "session.list": {
      const workspaceIds = new Set(services.workspaceRepo.list().map((workspace) => workspace.id));
      const all = services.sessionRepo.list().filter((session) => session.workspaceId && workspaceIds.has(session.workspaceId)).map(services.toInfo);
      services.send({
        type: "session.list",
        sessions: all.filter((session) => !session.sideChat),
        sideChats: all.filter((session) => session.sideChat),
      });
      return true;
    }

    case "session.search":
      services.send({ type: "session.search", requestId: cmd.requestId, query: cmd.query, results: services.searchSessions(cmd.query) });
      return true;

    case "session.rename": {
      try {
        services.send({ type: "session.renamed", session: services.toInfo(services.sessionRepo.rename(cmd.sessionId, cmd.title)) });
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return true;
    }

    case "session.delete":
      if (services.sideConversations.metadata(cmd.sessionId)) {
        services.titleControllers.get(cmd.sessionId)?.abort();
        const active = services.runRepo.listBySession(cmd.sessionId).filter((run) => ["created", "running", "waiting_approval", "paused"].includes(run.status));
        for (const run of active) { services.adapter.stop(run.id); services.cancelledRuns.add(run.id); }
        const stopped = await Promise.all(active.map((run) => services.adapter.waitForRun(run.id)));
        if (stopped.some((done) => !done)) {
          services.send({ type: "error", requestId: cmd.requestId, message: "side conversation is still stopping" });
          return true;
        }
      }
      for (const child of services.sessionRepo.list().filter((session) => services.sideConversations.metadata(session.id)?.parentSessionId === cmd.sessionId)) {
        await services.handle({ type: "session.delete", requestId: crypto.randomUUID(), sessionId: child.id });
      }
      await services.subagentController.dispose(cmd.sessionId);
      await services.adapter.disposeSession(cmd.sessionId);
      const deletedGoalTimer = services.goalContinuationTimers.get(cmd.sessionId);
      if (deletedGoalTimer) { clearTimeout(deletedGoalTimer); services.goalContinuationTimers.delete(cmd.sessionId); }
      const generatedFiles = services.artifactRepo.listBySession(cmd.sessionId);
      const deletedSession = services.sessionRepo.get(cmd.sessionId);
      services.sessionRepo.delete(cmd.sessionId);
      services.settingsRepo.set(`queue:${cmd.sessionId}`, []);
      services.settingsRepo.set(`side-chat:${cmd.sessionId}`, null);
      await services.generatedArtifacts.removeFiles(generatedFiles);
      if (deletedSession) services.projectResources.removeSession(deletedSession.workspaceId, cmd.sessionId);
      services.send({ type: "pong", requestId: cmd.requestId });
      return true;

    case "session.messages":
      services.sendMessages(cmd.sessionId, cmd.requestId, services.send);
      return true;

    case "goal.get": {
      const goal = services.goalRepo.getBySession(cmd.sessionId);
      services.send({ type: "goal.current", sessionId: cmd.sessionId, ...(goal ? { goal: goal } : {}) });
      if (goal?.status === "active") {
        if (goal.waitingUntil && goal.waitingReason) services.scheduleGoalWakeup(cmd.sessionId, goal.id, goal.waitingReason, goal.waitingUntil);
        else if (!goal.waitingReason && !services.runRepo.listBySession(cmd.sessionId).some((run) => run.goalId === goal.id && ["created", "running", "waiting_approval", "paused"].includes(run.status))) {
          services.scheduleGoalContinuation(cmd.sessionId, goal.id, goal.epoch);
        }
      }
      return true;
    }

    case "goal.start": {
      const session = services.sessionRepo.get(cmd.sessionId);
      if (!session || !session.workspaceId) {
        services.send({ type: "error", requestId: cmd.requestId, message: "select a workspace before starting a goal" });
        return true;
      }
      if (!cmd.objective.trim()) {
        services.send({ type: "error", requestId: cmd.requestId, message: "goal objective cannot be empty" });
        return true;
      }
      const previous = services.goalRepo.getBySession(cmd.sessionId);
      if (cmd.replaceFromMessageId && !services.messageRepo.listBySession(cmd.sessionId).some((message) => message.id === cmd.replaceFromMessageId && message.role === "user")) {
        services.send({ type: "error", requestId: cmd.requestId, message: "user message not found in session" });
        return true;
      }
      const activeRun = services.runRepo.listBySession(cmd.sessionId).find((run) =>
        !services.subagentRunRepo.get(run.id) && ["created", "running", "waiting_approval", "paused"].includes(run.status));
      if (services.startingRunSessions.has(cmd.sessionId) ||
          (activeRun && activeRun.goalId !== previous?.id) ||
          (services.adapter.isRunning(cmd.sessionId) && activeRun?.goalId !== previous?.id)) {
        services.send({ type: "error", requestId: cmd.requestId, message: "session already has an active run" });
        return true;
      }
      if (previous && ["active", "paused", "blocked"].includes(previous.status)) {
        const active = services.runRepo.listBySession(cmd.sessionId).find((run) => run.goalId === previous.id && ["created", "running", "waiting_approval", "paused"].includes(run.status));
        if (active) { services.adapter.stop(active.id); services.cancelledRuns.add(active.id); await services.adapter.waitForRun(active.id); }
        const timer = services.goalContinuationTimers.get(cmd.sessionId);
        if (timer) { clearTimeout(timer); services.goalContinuationTimers.delete(cmd.sessionId); }
      }
      if (previous) {
        services.goalRepo.deleteForSession(cmd.sessionId);
      }
      // Rebuild the Pi session so a session that was created for a normal
      // message receives the Goal tools before the kickoff turn.
      await services.adapter.disposeSession(cmd.sessionId);
      const goal = services.goalRepo.create(cmd.sessionId, cmd.objective, { model: cmd.model, permissionMode: cmd.permissionMode, thinking: cmd.thinking });
      services.publishGoal(goal);
      await services.handle({ type: "agent.run", requestId: cmd.requestId, sessionId: cmd.sessionId, message: cmd.objective, goal: true, attachments: cmd.attachments, quote: cmd.quote, messageId: cmd.messageId, replaceFromMessageId: cmd.replaceFromMessageId, model: cmd.model, permissionMode: cmd.permissionMode, thinking: cmd.thinking });
      return true;
    }

    case "goal.pause": {
      const goal = services.goalRepo.getBySession(cmd.sessionId);
      if (!goal) throw new Error("no goal in this session");
      if (goal.status !== "active") throw new Error("only an active goal can be paused");
      const active = services.runRepo.listBySession(cmd.sessionId).find((run) => run.goalId === goal.id && ["created", "running", "waiting_approval", "paused"].includes(run.status));
      if (active) { services.adapter.stop(active.id); services.cancelledRuns.add(active.id); }
      const timer = services.goalContinuationTimers.get(cmd.sessionId);
      if (timer) { clearTimeout(timer); services.goalContinuationTimers.delete(cmd.sessionId); }
      const updated = services.goalRepo.update(goal.id, { status: "paused", waitingReason: null, waitingUntil: null, stopReason: cmd.reason ?? "Paused by user", bumpEpoch: true });
      services.goalRepo.event(goal.id, cmd.sessionId, "paused", { reason: cmd.reason ?? "Paused by user" });
      services.publishGoal(updated);
      return true;
    }

    case "goal.resume": {
      const goal = services.goalRepo.getBySession(cmd.sessionId);
      if (!goal) throw new Error("no goal in this session");
      if (goal.status === "complete") throw new Error("completed goal cannot be resumed");
      if (goal.status === "active" && !goal.waitingReason) throw new Error("goal is already active");
      const active = services.runRepo.listBySession(cmd.sessionId).find((run) => run.goalId === goal.id && ["created", "running", "waiting_approval", "paused"].includes(run.status));
      if (active) { services.adapter.stop(active.id); services.cancelledRuns.add(active.id); await services.adapter.waitForRun(active.id); }
      const resumeTimer = services.goalContinuationTimers.get(cmd.sessionId);
      if (resumeTimer) { clearTimeout(resumeTimer); services.goalContinuationTimers.delete(cmd.sessionId); }
      const updated = services.goalRepo.update(goal.id, { status: "active", waitingReason: null, waitingUntil: null, stopReason: null, bumpEpoch: true });
      services.goalRepo.event(goal.id, cmd.sessionId, "resumed", {});
      services.publishGoal(updated);
      const options = services.goalRepo.getOptions(goal.id);
      void services.handle({ type: "agent.run", requestId: crypto.randomUUID(), sessionId: cmd.sessionId, message: `Continue working toward the goal. Re-check the current state, make the next useful changes, and call goal_complete when the goal is fully verified.\n\nGoal: ${updated.objective}`, goal: true, goalContinuation: true, ...options });
      return true;
    }

    case "goal.clear": {
      const goal = services.goalRepo.getBySession(cmd.sessionId);
      if (goal) {
        const active = services.runRepo.listBySession(cmd.sessionId).find((run) => run.goalId === goal.id && ["created", "running", "waiting_approval", "paused"].includes(run.status));
        if (active) { services.adapter.stop(active.id); services.cancelledRuns.add(active.id); await services.adapter.waitForRun(active.id); }
        const timer = services.goalContinuationTimers.get(cmd.sessionId);
        if (timer) { clearTimeout(timer); services.goalContinuationTimers.delete(cmd.sessionId); }
        services.goalRepo.deleteForSession(cmd.sessionId);
        services.send({ type: "goal.cleared", sessionId: cmd.sessionId, goalId: goal.id });
      }
      return true;
    }

    case "session.queue.list":
      services.sendQueue(cmd.sessionId, services.send);
      return true;

    case "queue.upsert":
      if (cmd.item.sessionId !== cmd.sessionId) {
        services.send({ type: "error", requestId: cmd.requestId, message: "queue item session mismatch" });
        return true;
      }
      services.queueRepo.upsert(cmd.item);
      services.sendQueue(cmd.sessionId);
      return true;

    case "queue.edit":
      if (cmd.item.sessionId !== cmd.sessionId) {
        services.send({ type: "error", requestId: cmd.requestId, message: "queue item session mismatch" });
        return true;
      }
      services.queueRepo.upsert(cmd.item);
      services.sendQueue(cmd.sessionId);
      return true;

    case "queue.sync":
      if (cmd.items.some((item) => item.sessionId !== cmd.sessionId)) {
        services.send({ type: "error", requestId: cmd.requestId, message: "queue item session mismatch" });
        return true;
      }
      services.queueRepo.replace(cmd.sessionId, cmd.items);
      services.sendQueue(cmd.sessionId);
      return true;

    case "queue.remove":
      services.queueRepo.remove(cmd.sessionId, cmd.queueItemId);
      services.sendQueue(cmd.sessionId);
      return true;

    case "session.runs":
      services.send({
        type: "session.runs",
        sessionId: cmd.sessionId,
        runs: services.runRepo.listBySession(cmd.sessionId).filter((run) => !services.subagentRunRepo.get(run.id)).map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          status: r.status as never,
          startedAt: r.startedAt ?? undefined,
          completedAt: r.completedAt ?? undefined,
          error: r.error ?? undefined,
        })),
      });
      return true;

    case "session.toolCalls":
      services.send({ type: "session.toolCalls", sessionId: cmd.sessionId, toolCalls: services.toolCallRepo.listBySession(cmd.sessionId).filter((call) => !services.subagentRunRepo.get(call.runId)).map((t) => ({
        id: t.id, runId: t.runId, toolName: t.toolName,
        arguments: t.arguments ?? undefined, resultSummary: t.resultSummary ?? undefined,
        status: t.status, startedAt: t.startedAt ?? undefined, completedAt: t.completedAt ?? undefined,
      })) });
      return true;

    case "session.subagents":
      services.send({ type: "session.subagents", sessionId: cmd.sessionId, subagents: services.subagentRunRepo.listBySession(cmd.sessionId).flatMap((row) => {
        const info = subagentInfo(row.runId, services.subagentRunRepo, services.runRepo, services.subagentStreams, services.assistantPartsByRun.get(row.runId));
        return info ? [services.subagentPublisher.snapshot(info)] : [];
      }) });
      return true;

    case "session.subagentNotifications":
      services.sendSubagentNotifications(cmd.sessionId, services.send);
      return true;

    case "artifact.list":
      services.send({ type: "artifact.list", sessionId: cmd.sessionId, artifacts: services.artifactRepo.listBySession(cmd.sessionId).map((artifact) => ({
        id: artifact.id, sessionId: artifact.sessionId, runId: artifact.runId ?? undefined, type: artifact.type, name: artifact.name,
        path: artifact.path, mimeType: artifact.mimeType ?? undefined, size: artifact.size ?? undefined, createdAt: artifact.createdAt,
      })) });
      return true;

    case "workspace.list":
      services.send({ type: "workspace.list", workspaces: services.workspaceRepo.list() as WorkspaceInfo[] });
      return true;

    case "workspace.upsert": {
      const workspacePath = path.resolve(cmd.path);
      if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
        services.send({ type: "error", requestId: cmd.requestId, message: `workspace directory does not exist: ${cmd.path}` });
        return true;
      }
      const workspace = services.workspaceRepo.upsert(cmd.name, workspacePath) as WorkspaceInfo;
      services.projectResources.project(workspace);
      services.send({ type: "workspace.updated", workspace });
      return true;
    }

    case "workspace.rename": {
      try {
        const workspace = services.workspaceRepo.rename(cmd.workspaceId, cmd.name) as WorkspaceInfo;
        services.projectResources.project(workspace);
        services.send({ type: "workspace.renamed", workspace });
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return true;
    }

    case "workspace.delete":
      if (!services.workspaceRepo.get(cmd.workspaceId)) {
        services.send({ type: "error", requestId: cmd.requestId, message: `unknown workspace ${cmd.workspaceId}` });
        return true;
      }
      services.workspaceRepo.delete(cmd.workspaceId);
      services.projectResources.removeProjectMetadata(cmd.workspaceId);
      services.send({ type: "workspace.deleted", workspaceId: cmd.workspaceId });
      return true;

    case "file.preview": {
      const workspace = cmd.workspaceId ? services.workspaceRepo.get(cmd.workspaceId) : undefined;
      if (cmd.workspaceId && !workspace) throw new Error("Unknown workspace");
      services.send({ type: cmd.type, requestId: cmd.requestId, workspaceId: cmd.workspaceId, path: cmd.path, file: await readFilePreview(cmd.path, workspace?.path, cmd.full) });
      return true;
    }
    case "workspace.files":
    case "workspace.git":
    case "workspace.gitDiff":
    case "file.read": {
      const workspace = services.workspaceRepo.get(cmd.workspaceId);
      if (!workspace) throw new Error("Unknown workspace");
      const context = { requestId: cmd.requestId, workspaceId: workspace.id };
      if (cmd.type === "workspace.files") {
        services.send({ type: cmd.type, ...context, path: cmd.path ?? "", files: await listWorkspaceFiles(workspace.path, cmd.path) });
      } else if (cmd.type === "workspace.git") {
        services.send({ type: cmd.type, ...context, ...await workspaceGit(workspace.path) });
      } else if (cmd.type === "workspace.gitDiff") {
        services.send({ type: cmd.type, ...context, path: cmd.path, ...await workspaceDiff(workspace.path, cmd.path, cmd.scope) });
      } else {
        services.send({ type: cmd.type, ...context, path: cmd.path, ...await readWorkspaceFile(workspace.path, cmd.path) });
      }
      return true;
    }
    default: return false;
  }
}
