import { runtimeText, runtimeErrorInfo } from "./runtime-localization";
import { repeatedUserMessageId } from "@qone/protocol";
import type { RuntimeCommand, PermissionDecision, MessageAttachmentInfo } from "@qone/protocol";
import { thinkingLevelsForApi, parseMcpCommand } from "@qone/protocol";
import path from "node:path";
import { createLocalSkill, createResourceLoader, installLocalSkill } from "./skills.js";
import { installCloudSkill, listCloudSkills } from "./skill-catalog.js";
import { containsSecretConfig } from "./secrets.js";
import { configurePodcast } from "./reach-podcast.js";
import { normalizeSubagentConfig } from "./subagents.js";
import { type SessionCompactionCheckpoint } from "./session-compaction.js";
import { globalInstructionsDirectory, globalInstructionsPath, readGlobalInstructions, writeGlobalInstructions } from "./global-instructions.js";
import type { runtimeCommandServices } from "./index.js";

export async function handleRuntimeCommand(cmd: RuntimeCommand, services: ReturnType<typeof runtimeCommandServices>): Promise<boolean> {
  switch (cmd.type) {

    case "skills.list": {
      const requestedCwd = cmd.cwd ? path.resolve(cmd.cwd) : process.cwd();
      if (cmd.cwd && !services.workspaceRepo.list().some((workspace) => path.resolve(workspace.path).toLowerCase() === requestedCwd.toLowerCase())) {
        services.send({ type: "error", requestId: cmd.requestId, message: "skills path is outside registered workspaces" });
        return true;
      }
      const { skills } = await createResourceLoader(requestedCwd);
      for (const skill of skills) services.skillRepo.upsert(skill);
      services.send({ type: "skills.list", skills: skills });
      return true;
    }

    case "global-prompt.get":
      services.send({ type: "global-prompt", requestId: cmd.requestId, content: readGlobalInstructions(), path: globalInstructionsPath(), directory: globalInstructionsDirectory() });
      return true;

    case "global-prompt.set":
      try {
        writeGlobalInstructions(cmd.content);
        await services.adapter.refreshSkills();
        services.send({ type: "global-prompt", requestId: cmd.requestId, content: cmd.content, path: globalInstructionsPath(), directory: globalInstructionsDirectory() });
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.failed_to_save_qone_md", { p0: String(error) }) });
      }
      return true;

    case "skills.cloud.list": {
      const page = await listCloudSkills(cmd.collection, cmd.page, cmd.query);
      services.send({ type: "skills.cloud.list", requestId: cmd.requestId, ...page });
      return true;
    }
    case "skills.cloud.install": {
      const skill = await installCloudSkill(cmd.source, cmd.skillId);
      await services.adapter.refreshSkills();
      services.skillRepo.upsert(skill);
      services.send({ type: "skills.cloud.installed", requestId: cmd.requestId, skill: skill });
      return true;
    }
    case "skills.import": {
      const skill = await installLocalSkill(cmd.content);
      await services.adapter.refreshSkills();
      services.skillRepo.upsert(skill);
      services.send({ type: "skills.imported", requestId: cmd.requestId, skill: skill });
      return true;
    }
    case "skills.create": {
      const skill = await createLocalSkill(cmd.name, cmd.description, cmd.instructions);
      await services.adapter.refreshSkills();
      services.skillRepo.upsert(skill);
      services.send({ type: "skills.created", requestId: cmd.requestId, skill: skill });
      return true;
    }

    case "plugins.list":
      services.send({ type: "plugins.list", plugins: [] });
      return true;

    case "browser.status":
      services.send({ type: "browser.status", requestId: cmd.requestId, status: services.browserSync!.status() });
      return true;

    case "reach.channels":
      services.sendReachChannels(cmd.requestId);
      return true;

    case "reach.podcast.configure":
      configurePodcast(cmd.accessToken, cmd.refreshToken);
      services.send({ type: "pong", requestId: cmd.requestId });
      services.sendReachChannels();
      return true;

    case "subagent.list":
      services.sendSubagentConfig(cmd.requestId);
      return true;

    case "subagent.sync":
      services.subagentConfig = normalizeSubagentConfig(cmd.config);
      services.preferencesRepo.set("subagents.config", services.subagentConfig);
      services.sendSubagentConfig(cmd.requestId);
      return true;

    case "subagent.query": {
      const subagent = services.subagentController.query(cmd.runId);
      if (!subagent) {
        services.send({ type: "error", requestId: cmd.requestId, message: `unknown subagent ${cmd.runId}` });
        return true;
      }
      services.send({ type: "subagent.query", requestId: cmd.requestId, subagent: services.subagentPublisher.snapshot(subagent) });
      return true;
    }

    case "subagent.control": {
      try {
        await services.subagentController.control(cmd.runId, cmd.action, cmd.message);
        const subagent = services.subagentController.query(cmd.runId)!;
        services.send({ type: "subagent.controlled", requestId: cmd.requestId, subagent: services.subagentPublisher.snapshot(subagent) });
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return true;
    }

    case "browser.connect":
      try {
        const status = await services.browserSync!.connect();
        services.send({ type: "browser.status", requestId: cmd.requestId, status: status });
      } catch {
        // Browser failures already update the integration status. Avoid showing
        // the same error a second time in the page-wide banner.
        services.send({ type: "browser.status", requestId: cmd.requestId, status: services.browserSync!.status() });
      }
      return true;

    case "mcp.list":
      services.send({ type: "mcp.list", servers: services.mcpServerRepo.list().map((server) => ({ ...server, connected: services.mcp.isConnected(server.id), toolCount: services.mcp.toolCount(server.id) })) });
      return true;

    case "mcp.connect": {
      const subjectId = `mcp:${cmd.config.id}`;
      services.permissionRepo.ensure(subjectId, "mcp.connect", "ask");
      await services.authorizeCommand(subjectId, "mcp.connect", "mcp.connect", { id: cmd.config.id, name: cmd.config.name, command: cmd.config.command, url: cmd.config.url });
      services.mcpServerRepo.upsert(cmd.config);
      // The saved configuration is enabled immediately; connecting the transport
      // (especially a first-time npx download) can take much longer.
      services.send({ type: "mcp.list", servers: services.mcpServerRepo.list().map((server) => ({ ...server, connected: services.mcp.isConnected(server.id), toolCount: services.mcp.toolCount(server.id) })) });
      await services.mcp.disconnect(cmd.config.id);
      let connectError: string | undefined;
      try {
        if (cmd.config.authMode === "oauth" && !services.mcp.hasHostedToken(cmd.config)) {
          services.pendingMcpAuthRequests.set(cmd.config.id, cmd.requestId);
          const authorization = await services.mcp.beginOAuth(cmd.config);
          if (authorization) {
            services.send({ type: "mcp.oauth.authorization", requestId: cmd.requestId, serverId: cmd.config.id, ...authorization });
            setTimeout(() => {
              if (services.pendingMcpAuthRequests.get(cmd.config.id) !== cmd.requestId) return;
              services.pendingMcpAuthRequests.delete(cmd.config.id);
              services.send({ type: "error", requestId: cmd.requestId, message: "MCP account login timed out" });
            }, 10 * 60_000);
            return true;
          }
          services.pendingMcpAuthRequests.delete(cmd.config.id);
        }
        if (cmd.config.authMode === "github-device") {
          services.pendingMcpAuthRequests.set(cmd.config.id, cmd.requestId);
          const result = await services.mcp.connectGitHub(cmd.config);
          if (result.device) {
            // connectGitHub starts the device flow internally. Reuse the
            // shared callback wiring for the completion and error lifecycle.
            const device = result.device;
            services.send({ type: "mcp.github.device", serverId: cmd.config.id, userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt });
            void device.completion.catch((error) => {
              if (services.pendingMcpAuthRequests.get(cmd.config.id) !== cmd.requestId) return;
              services.pendingMcpAuthRequests.delete(cmd.config.id);
              services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
            });
            return true;
          }
          services.pendingMcpAuthRequests.delete(cmd.config.id);
        }
        const tools = await services.mcp.connect(cmd.config);
        await services.refreshCustomTools();
        services.send({ type: "mcp.connected", serverId: cmd.config.id, toolCount: tools.length });
      } catch (err) {
        services.pendingMcpAuthRequests.delete(cmd.config.id);
        connectError = String(err instanceof Error ? err.message : err);
      }
      // 无论成败都推列表：配置已持久化，前端必须立即看到新条目和连接状态，
      // 失败时 connectError 通过 error 事件透出，服务以"未连接"留在列表里。
      services.send({ type: "mcp.list", servers: services.mcpServerRepo.list().map((server) => ({ ...server, connected: services.mcp.isConnected(server.id), toolCount: services.mcp.toolCount(server.id) })) });
      if (connectError) services.send({ type: "error", requestId: cmd.requestId, message: connectError });
      return true;
    }

    case "mcp.delete": {
      const config = services.mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) {
        services.send({ type: "error", requestId: cmd.requestId, message: `unknown MCP server ${cmd.serverId}` });
        return true;
      }
      await services.mcp.disconnect(cmd.serverId);
      services.mcp.clearCredentials(cmd.serverId);
      services.pendingMcpAuthRequests.delete(cmd.serverId);
      services.mcpServerRepo.delete(cmd.serverId);
      for (const value of Object.values(config.env ?? {})) {
        if (value.startsWith("$mcp.env:")) services.runtimeSecrets.delete(value.slice(1));
      }
      await services.adapter.deleteSecret(config.oauth?.tokenSecretKey ?? `mcp.oauth:${cmd.serverId}`);
      await services.refreshCustomTools();
      services.send({ type: "mcp.list", servers: services.mcpServerRepo.list().map((server) => ({ ...server, connected: services.mcp.isConnected(server.id), toolCount: services.mcp.toolCount(server.id) })) });
      return true;
    }

    case "mcp.oauth.begin": {
      const config = services.mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) throw new Error(`unknown MCP server ${cmd.serverId}`);
      await services.authorizeCommand(`mcp:${config.id}`, "mcp.connect", "mcp.oauth", { id: config.id, name: config.name });
      const auth = await services.mcp.beginOAuth(config);
      if (auth) services.send({ type: "mcp.oauth.authorization", requestId: cmd.requestId, serverId: cmd.serverId, url: auth.url, state: auth.state });
      return true;
    }

    case "mcp.oauth.complete": {
      const config = services.mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) throw new Error(`unknown MCP server ${cmd.serverId}`);
      await services.mcp.completeOAuth(config, cmd.code, cmd.state, cmd.iss);
      // completeOAuth emits the token event and reconnects through the same
      // callback for browser redirects and manual code entry.
      return true;
    }

    case "permission.list":
      services.send({ type: "permission.list", rules: services.permissionRepo.list().map((rule) => ({
        subjectId: rule.subjectId,
        permission: rule.permission,
        decision: rule.decision as PermissionDecision,
        updatedAt: rule.updatedAt,
      })) });
      return true;

    case "permission.set": {
      const rule = services.permissionRepo.set(cmd.subjectId, cmd.permission, cmd.decision);
      services.send({ type: "permission.updated", rule: {
        subjectId: rule.subjectId,
        permission: rule.permission,
        decision: rule.decision,
        updatedAt: rule.updatedAt,
      } });
      return true;
    }

    case "compaction.settings.set": {
      const preferences = services.adapter.setCompactionPreferences(cmd);
      services.preferencesRepo.set("compaction.settings", preferences);
      services.send({ type: "pong", requestId: cmd.requestId, compaction: preferences });
      return true;
    }

    case "session.compact": {
      const session = services.sessionRepo.get(cmd.sessionId);
      const cwd = session?.workspaceId ? services.workspaceRepo.get(session.workspaceId)?.path : undefined;
      if (!session || !cwd) {
        services.send({ type: "error", requestId: cmd.requestId, message: "session workspace not found" });
        return true;
      }
      if (services.startingRunSessions.has(cmd.sessionId) || services.adapter.isRunning(cmd.sessionId) ||
          services.runRepo.listBySession(cmd.sessionId).some((run) => !services.subagentRunRepo.get(run.id) && ["created", "running", "waiting_approval", "paused"].includes(run.status))) {
        services.send({ type: "error", requestId: cmd.requestId, message: "session already has an active run" });
        return true;
      }
      const history = services.messageRepo.listBySession(cmd.sessionId);
      if (!history.length) {
        services.send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.there_is_no_session_content_to_compact") });
        return true;
      }
      try {
        const context = await services.adapter.compactSession(cmd.sessionId, cwd, cmd.model);
        try {
          services.settingsRepo.set(`compaction:${cmd.sessionId}`, { throughMessageId: history.at(-1)!.id, context: context } satisfies SessionCompactionCheckpoint);
        } catch (error) {
          // The SQLite transcript is still intact; discard the unsaved Pi state.
          await services.adapter.disposeSession(cmd.sessionId);
          throw error;
        }
        services.touchSession(cmd.sessionId);
        const marker = { id: cmd.requestId, throughMessageId: history.at(-1)!.id, createdAt: Date.now(), status: "completed" as const, source: "manual" as const };
        services.emit("context.compacted", marker, cmd.sessionId);
        services.flushEvents();
        services.send({ type: "session.compacted", requestId: cmd.requestId, sessionId: cmd.sessionId, marker: marker });
      } catch (error) {
        const marker = { id: cmd.requestId, throughMessageId: history.at(-1)!.id, createdAt: Date.now(), status: "interrupted" as const, source: "manual" as const };
        services.emit("context.compaction.interrupted", marker, cmd.sessionId);
        services.flushEvents();
        services.send({ type: "session.compactionInterrupted", requestId: cmd.requestId, sessionId: cmd.sessionId, marker: marker, message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    case "session.context.get": {
      const session = services.sessionRepo.get(cmd.sessionId);
      const cwd = session?.workspaceId ? services.workspaceRepo.get(session.workspaceId)?.path : undefined;
      if (!session || !cwd) {
        services.send({ type: "error", requestId: cmd.requestId, message: "session workspace not found" });
        return true;
      }
      try {
        const usage = await services.adapter.getContextUsage(cmd.sessionId, cwd, cmd.model);
        services.send({ type: "session.context", requestId: cmd.requestId, sessionId: cmd.sessionId, model: cmd.model, ...usage });
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return true;
    }

    case "model.list":
      await services.adapter.configureModels(services.modelConfigRepo.list());
      services.send({ type: "model.list", configs: services.modelConfigRepo.list() });
      return true;

    case "model.resolve-metadata": {
      const models = await Promise.all(cmd.models.map(async ({ id, metadata }) => {
        const resolved = await services.settingsMetadataResolver.resolve({ provider: cmd.provider, model: id, config: { apiType: cmd.apiType, baseUrl: cmd.baseUrl, autoMetadata: true, modelMetadata: metadata } });
        return { id: id, metadata: resolved.metadata, thinkingLevels: [...thinkingLevelsForApi(cmd.apiType)], sources: resolved.sources };
      }));
      services.send({ type: "model.metadata-resolved", requestId: cmd.requestId, models: models });
      return true;
    }

    case "model.upsert": {
      if (containsSecretConfig(cmd.config.config)) {
        services.send({ type: "error", requestId: cmd.requestId, message: "model secrets must be stored in Windows Credential Manager" });
        return true;
      }
      const config = services.modelConfigRepo.upsert(cmd.config);
      await services.adapter.configureModels(services.modelConfigRepo.list());
      services.send({ type: "model.updated", config: config });
      return true;
    }

    case "model.delete":
      services.modelConfigRepo.delete(cmd.id);
      await services.adapter.configureModels(services.modelConfigRepo.list());
      services.send({ type: "pong", requestId: cmd.requestId });
      return true;

    case "events.replay": {
      const after = cmd.afterSequence ?? -1;
      services.send({
        type: "events.replay",
        events: services.eventJournal.replay(after, cmd.sessionId),
      });
      return true;
    }

    case "secret.set": {
      if (cmd.key === "reach.xueqiu.cookie" || cmd.key === "reach.groq.apiKey") {
        services.runtimeSecrets.set(cmd.key, cmd.value);
        services.send({ type: "secret.saved", requestId: cmd.requestId });
        services.sendReachChannels();
        return true;
      }
      if (cmd.key.startsWith("mcp.env:")) {
        services.runtimeSecrets.set(cmd.key, cmd.value);
        const config = services.mcpServerRepo.list().find((server) => Object.values(server.env ?? {}).includes(`$${cmd.key}`));
        if (config && services.permissionRepo.get(`mcp:${config.id}`, "mcp.connect") === "allow") {
          try {
            await services.mcp.disconnect(config.id);
            const tools = await services.mcp.connect(config);
            await services.refreshCustomTools();
            services.send({ type: "mcp.connected", serverId: config.id, toolCount: tools.length });
          } catch (error) {
            await services.refreshCustomTools();
            services.log.warn("MCP API key restore failed", { serverId: config.id, err: String(error) });
          }
          services.send({ type: "mcp.list", servers: services.mcpServerRepo.list().map((server) => ({ ...server, connected: services.mcp.isConnected(server.id), toolCount: services.mcp.toolCount(server.id) })) });
        }
        services.send({ type: "secret.saved", requestId: cmd.requestId });
        return true;
      }
      const mcpSecret = services.mcpServerRepo.list().find((server) =>
        server.oauth?.tokenSecretKey === cmd.key || `mcp.oauth:${server.id}` === cmd.key ||
        (server.authMode === "oauth" && [`mcp.oauth:${server.id}.client`, `mcp.oauth:${server.id}.tokens`].includes(cmd.key)));
      if (!mcpSecret && cmd.key === "mcp.oauth:mcp-github") {
        services.mcp.setAccessToken("mcp-github", cmd.value);
        services.send({ type: "secret.saved", requestId: cmd.requestId });
        return true;
      }
      if (mcpSecret) {
        if (mcpSecret.authMode === "oauth" && cmd.key.endsWith(".client")) services.mcp.restoreHostedCredential(mcpSecret, "client", cmd.value);
        else if (mcpSecret.authMode === "oauth" && cmd.key.endsWith(".tokens")) services.mcp.restoreHostedCredential(mcpSecret, "tokens", cmd.value);
        else services.mcp.setAccessToken(mcpSecret.id, cmd.value);
        if (cmd.key !== `mcp.oauth:${mcpSecret.id}.client` && services.permissionRepo.get(`mcp:${mcpSecret.id}`, "mcp.connect") === "allow") {
          try {
            await services.mcp.disconnect(mcpSecret.id);
            const tools = await services.mcp.connect(mcpSecret);
            await services.refreshCustomTools();
            services.send({ type: "mcp.connected", serverId: mcpSecret.id, toolCount: tools.length });
            services.send({ type: "mcp.list", servers: services.mcpServerRepo.list().map((server) => ({ ...server, connected: services.mcp.isConnected(server.id), toolCount: services.mcp.toolCount(server.id) })) });
          } catch (error) {
            services.log.warn("MCP OAuth credential restore failed", { serverId: mcpSecret.id, err: String(error) });
          }
        }
      } else {
        services.runtimeSecrets.set(cmd.key, cmd.value);
        await services.adapter.setSecret(cmd.key, cmd.value);
      }
      services.send({ type: "secret.saved", requestId: cmd.requestId });
      return true;
    }

    case "secret.delete":
      services.runtimeSecrets.delete(cmd.key);
      await services.adapter.deleteSecret(cmd.key);
      services.send({ type: "pong", requestId: cmd.requestId });
      if (cmd.key === "reach.xueqiu.cookie" || cmd.key === "reach.groq.apiKey") services.sendReachChannels();
      return true;

    case "agent.run": {
      if (!cmd.goal) {
        const timer = services.goalContinuationTimers.get(cmd.sessionId);
        if (timer) { clearTimeout(timer); services.goalContinuationTimers.delete(cmd.sessionId); }
        const waitingGoal = services.goalRepo.getBySession(cmd.sessionId);
        if (waitingGoal?.status === "active" && waitingGoal.waitingReason) {
          const resumed = services.goalRepo.update(waitingGoal.id, { waitingReason: null, waitingUntil: null, stopReason: null, bumpEpoch: true });
          services.goalRepo.event(waitingGoal.id, cmd.sessionId, "resumed", { source: "user_input" });
          services.publishGoal(resumed);
        }
      }
      const s = services.sessionRepo.get(cmd.sessionId);
      if (!s) {
        services.send({ type: "error", requestId: cmd.requestId, message: `unknown session ${cmd.sessionId}` });
        return true;
      }
      if (!s.workspaceId) {
        services.send({ type: "error", requestId: cmd.requestId, message: "select a workspace before running the agent" });
        return true;
      }
      if (cmd.mcpServerId && (!services.mcp.isConnected(cmd.mcpServerId) || services.mcp.toolCount(cmd.mcpServerId) === 0)) {
        services.send({ type: "error", requestId: cmd.requestId, message: "selected MCP server is not connected or has no tools" });
        return true;
      }
      if (services.startingRunSessions.has(cmd.sessionId) || services.adapter.isRunning(cmd.sessionId) ||
          services.runRepo.listBySession(cmd.sessionId).some((run) => !services.subagentRunRepo.get(run.id) && ["created", "running", "waiting_approval", "paused"].includes(run.status))) {
        services.send({ type: "error", requestId: cmd.requestId, message: "session already has an active run" });
        return true;
      }
      if (cmd.queueItemId) {
        services.queueRepo.remove(cmd.sessionId, cmd.queueItemId);
        services.sendQueue(cmd.sessionId);
      }
      if (!cmd.goalContinuation && !cmd.replaceFromMessageId) {
        cmd.replaceFromMessageId = repeatedUserMessageId(services.messageRepo.listBySession(cmd.sessionId).map(message => ({
          ...message,
          attachments: message.attachments ? JSON.parse(message.attachments) as MessageAttachmentInfo[] : undefined,
        })), { content: cmd.message, attachments: cmd.attachments });
      }
      if (cmd.replaceFromMessageId) {
        services.startingRunSessions.add(cmd.sessionId);
        try {
          const history = services.messageRepo.listBySession(cmd.sessionId);
          const index = history.findIndex(message => message.id === cmd.replaceFromMessageId && message.role === "user");
          if (index < 0) throw new Error("user message not found in session");
          const removedRunIds = new Set(history.slice(index).flatMap(message => message.runId ? [message.runId] : []));
          const childRuns = services.subagentRunRepo.listBySession(cmd.sessionId);
          for (let changed = true; changed;) {
            changed = false;
            for (const child of childRuns) if (removedRunIds.has(child.parentRunId) && !removedRunIds.has(child.runId)) {
              removedRunIds.add(child.runId);
              changed = true;
            }
          }
          await services.subagentController.dispose(cmd.sessionId, [...removedRunIds]);
          // Pi keeps an in-memory conversation; it must be rebuilt from the trimmed DB history.
          await services.adapter.disposeSession(cmd.sessionId);
          services.flushEvents();
          services.messageRepo.truncateFrom(cmd.sessionId, cmd.replaceFromMessageId);
          await services.generatedArtifacts.removeRuns(cmd.sessionId, [...removedRunIds]);
          services.eventJournal.restore(services.eventRepo.list());
        } catch (error) {
          services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
          return true;
        } finally {
          services.startingRunSessions.delete(cmd.sessionId);
        }
      }
      const goal = cmd.goal ? services.goalRepo.getBySession(cmd.sessionId) : undefined;
      if (cmd.goal && (!goal || goal.status !== "active")) {
        services.send({ type: "error", requestId: cmd.requestId, message: "goal is not active" });
        return true;
      }
      const run = services.runRepo.create(cmd.sessionId, {
        origin: goal ? (cmd.goalContinuation ? "goal_continuation" : "goal_kickoff") : "manual",
        goalId: goal?.id,
        goalEpoch: goal?.epoch,
      });
      services.assistantPartsByRun.set(run.id, []);
      services.liveAssistantByRun.set(run.id, { content: "", parts: [], sequence: 0 });
      const turn = services.turnRepo.create(run.id);
      if (!cmd.goalContinuation) {
        const userMessage = services.messageRepo.add(cmd.sessionId, "user", cmd.message, run.id, undefined, cmd.messageId, cmd.attachments, undefined, goal?.id, cmd.quote);
        services.touchSession(cmd.sessionId, userMessage.createdAt);
      }
      services.emit("agent.started", { runId: run.id }, cmd.sessionId, run.id);
      const workspaceCwd = s.workspaceId ? services.workspaceRepo.get(s.workspaceId)?.path : undefined;
      if (s.workspaceId && !workspaceCwd) {
        services.runRepo.finish(run.id, "failed", "session workspace no longer exists");
        services.assistantPartsByRun.delete(run.id);
        services.assistantMessageSequenceByRun.delete(run.id);
        services.liveAssistantByRun.delete(run.id);
        services.turnRepo.finish(turn.id, "failed");
        services.emit("agent.failed", { message: "session workspace no longer exists" }, cmd.sessionId, run.id);
        services.send({ type: "error", requestId: cmd.requestId, message: "session workspace no longer exists" });
        return true;
      }

      const mcpCommand = cmd.mcpServerId ? parseMcpCommand(cmd.message) : undefined;
      const routedMessage = mcpCommand && mcpCommand.serverId === cmd.mcpServerId ? mcpCommand.text : cmd.message;
      const notificationDelivery = services.subagentNotificationCoordinator?.pendingPrompt(cmd.sessionId) ?? { ids: [] as string[], prompt: undefined };
      const modelMessage = [notificationDelivery.prompt, routedMessage].filter(Boolean).join("\n\n");
      Promise.resolve()
        .then(() => {
          services.subagentNotificationCoordinator?.markDelivered(notificationDelivery.ids);
          if (notificationDelivery.ids.length) services.sendSubagentNotifications(cmd.sessionId);
          return services.adapter.run(cmd.sessionId, modelMessage, { model: cmd.model, cwd: workspaceCwd, runId: run.id, eventSessionId: cmd.sessionId, permissionMode: cmd.permissionMode, thinking: cmd.thinking, attachments: cmd.attachments, mcpServerId: cmd.mcpServerId, goalId: goal?.id, goalEpoch: goal?.epoch }, (type, payload) =>
          services.emit(type, payload, cmd.sessionId, run.id)
        );
        })
        .then(async () => {
          const cancelled = services.cancelledRuns.delete(run.id);
          const parts = services.assistantPartsByRun.get(run.id) ?? [];
          const assistantMessage = services.persistPartialAssistant(cmd.sessionId, run.id, cmd.model);
          if (!assistantMessage && !cancelled && !services.persistedAssistantRuns.has(run.id)) throw new Error("AI returned an empty response");
          services.releaseUndeliveredSteers(cmd.sessionId, run.id);
          services.persistedAssistantRuns.delete(run.id);
          services.initialUserMessageSeen.delete(run.id);
          services.assistantBuffers.delete(run.id);
          services.assistantStreamBuffers.delete(run.id);
          services.assistantPartsByRun.delete(run.id);
          services.assistantMessageSequenceByRun.delete(run.id);
          services.liveAssistantByRun.delete(run.id);
          for (const key of services.toolCallIds.keys()) if (key.startsWith(`${run.id}:`)) services.toolCallIds.delete(key);
          const status = cancelled ? "cancelled" : "completed";
          services.turnRepo.finish(turn.id, status);
          services.runRepo.finish(run.id, status);
          services.touchSession(cmd.sessionId);
          if (goal) await services.adapter.disposeSession(cmd.sessionId);
          await services.releaseBrowserSession();
          services.emit(cancelled ? "agent.cancelled" : "agent.completed", assistantMessage ? {
            message: {
              id: assistantMessage.id,
              role: assistantMessage.role,
              content: assistantMessage.content,
              parts: parts,
              runId: assistantMessage.runId,
              createdAt: assistantMessage.createdAt,
            },
          } : {}, cmd.sessionId, run.id);
          if (goal && !cancelled) {
            const current = services.goalRepo.get(goal.id);
            if (current?.status === "active" && !current.waitingReason && current.epoch === goal.epoch) services.scheduleGoalContinuation(cmd.sessionId, goal.id, goal.epoch);
          } else if (!goal && !cancelled) {
            const current = services.goalRepo.getBySession(cmd.sessionId);
            if (current?.status === "active" && !current.waitingReason) services.scheduleGoalContinuation(cmd.sessionId, current.id, current.epoch);
          }
        })
        .catch(async (err) => {
          if (notificationDelivery.ids.length) {
            services.subagentNotificationCoordinator?.markPending(notificationDelivery.ids);
            services.sendSubagentNotifications(cmd.sessionId);
          }
          const cancelled = services.cancelledRuns.delete(run.id);
          const parts = services.assistantPartsByRun.get(run.id) ?? [];
          const assistantMessage = services.persistPartialAssistant(cmd.sessionId, run.id, cmd.model);
          services.releaseUndeliveredSteers(cmd.sessionId, run.id);
          services.persistedAssistantRuns.delete(run.id);
          services.initialUserMessageSeen.delete(run.id);
          services.assistantBuffers.delete(run.id);
          services.assistantStreamBuffers.delete(run.id);
          services.assistantPartsByRun.delete(run.id);
          services.assistantMessageSequenceByRun.delete(run.id);
          services.liveAssistantByRun.delete(run.id);
          for (const key of services.toolCallIds.keys()) if (key.startsWith(`${run.id}:`)) services.toolCallIds.delete(key);
          const status = cancelled ? "cancelled" : "failed";
          services.turnRepo.finish(turn.id, status);
          services.runRepo.finish(run.id, status, cancelled ? undefined : String(err));
          services.touchSession(cmd.sessionId);
          if (goal) await services.adapter.disposeSession(cmd.sessionId);
          await services.releaseBrowserSession();
          services.emit(cancelled ? "agent.cancelled" : "agent.failed", cancelled
            ? (assistantMessage ? { message: { id: assistantMessage.id, role: assistantMessage.role, content: assistantMessage.content, parts: parts, runId: assistantMessage.runId, createdAt: assistantMessage.createdAt } } : {})
            : runtimeErrorInfo(err), cmd.sessionId, run.id);
          if (goal && !cancelled) {
            const current = services.goalRepo.get(goal.id);
            if (current?.status === "active" && current.epoch === goal.epoch) {
              const updated = services.goalRepo.update(goal.id, { status: "blocked", stopReason: String(err) });
              services.goalRepo.event(goal.id, cmd.sessionId, "error", { error: String(err) }, run.id);
              services.publishGoal(updated);
            }
          }
        });

      services.send({ type: "pong", requestId: cmd.requestId });
      return true;
    }

    case "agent.steer": {
      // Queue identity is the idempotency key, including when delivery won
      // the race against acknowledgement or a duplicate IPC request arrives.
      const delivered = () => services.messageRepo.hasUserMessage(cmd.sessionId, cmd.queueItemId);
      if (delivered() || services.pendingSteers.get(cmd.sessionId)?.some((item) => item.queueItemId === cmd.queueItemId)) {
        services.send({ type: "pong", requestId: cmd.requestId });
        return true;
      }
      const session = services.sessionRepo.get(cmd.sessionId);
      if (!session || !services.adapter.isRunning(cmd.sessionId)) {
        services.send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.the_agent_is_no_longer_running_and_cannot_be") });
        return true;
      }
      const activeRun = services.runRepo.listBySession(cmd.sessionId).find((run) => run.id === cmd.runId && ["created", "running", "waiting_approval", "paused"].includes(run.status));
      if (!activeRun) {
        services.send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.the_target_agent_run_has_ended") });
        return true;
      }
      const pending = { runId: cmd.runId, queueItemId: cmd.queueItemId, message: cmd.message, attachments: cmd.attachments, quote: cmd.quote };
      const steers = services.pendingSteers.get(cmd.sessionId) ?? [];
      steers.push(pending);
      services.pendingSteers.set(cmd.sessionId, steers);
      let accepted = false;
      try {
        accepted = await services.adapter.sendToSession(cmd.sessionId, cmd.message, "steer", cmd.attachments, cmd.runId);
      } catch (error) {
        services.log.warn("steer rejected", { error: String(error), runId: cmd.runId });
      }
      if (!accepted && !delivered()) {
        const remaining = (services.pendingSteers.get(cmd.sessionId) ?? []).filter((item) => item !== pending);
        if (remaining.length) services.pendingSteers.set(cmd.sessionId, remaining);
        else services.pendingSteers.delete(cmd.sessionId);
        services.send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.pi_is_not_accepting_steering_messages") });
        return true;
      }
      // Acceptance only queues the steer inside Pi. The user turn enters the
      // transcript when Pi emits its message_end event.
      services.send({ type: "pong", requestId: cmd.requestId });
      return true;
    }

    case "agent.stop": {
      const stoppedRun = services.runRepo.get(cmd.runId);
      if (!services.adapter.stop(cmd.runId)) {
        services.send({ type: "error", requestId: cmd.requestId, message: `unknown active run ${cmd.runId}` });
        return true;
      }
      services.cancelledRuns.add(cmd.runId);
      if (stoppedRun) services.titleControllers.get(stoppedRun.sessionId)?.abort();
      if (stoppedRun?.goalId) {
        const goal = services.goalRepo.get(stoppedRun.goalId);
        if (goal?.status === "active") {
          const timer = services.goalContinuationTimers.get(stoppedRun.sessionId);
          if (timer) { clearTimeout(timer); services.goalContinuationTimers.delete(stoppedRun.sessionId); }
          const updated = services.goalRepo.update(goal.id, { status: "paused", waitingReason: null, waitingUntil: null, stopReason: "Paused by user", bumpEpoch: true });
          services.goalRepo.event(goal.id, stoppedRun.sessionId, "paused", { reason: "Paused by user" }, cmd.runId);
          services.publishGoal(updated);
        }
      }
      services.send({ type: "pong", requestId: cmd.requestId });
      return true;
    }

    case "tool.approve":
      services.adapter.approve(cmd.approvalId);
      services.commandApprovals.approve(cmd.approvalId);
      if (services.approvalRuns.has(cmd.approvalId)) {
        const runId = services.approvalRuns.get(cmd.approvalId)!;
        services.runRepo.setStatus(runId, "running");
        const toolCallId = services.approvalToolCalls.get(cmd.approvalId);
        if (toolCallId) services.toolCallRepo.setStatus(toolCallId, "running");
        const run = services.runRepo.get(runId);
        if (run) services.emit("run.status", { status: "running" }, run.sessionId, runId);
      }
      services.approvalRuns.delete(cmd.approvalId);
      services.approvalToolCalls.delete(cmd.approvalId);
      services.send({ type: "pong", requestId: cmd.requestId });
      return true;

    case "tool.reject":
      services.adapter.reject(cmd.approvalId);
      services.commandApprovals.reject(cmd.approvalId);
      if (services.approvalRuns.has(cmd.approvalId)) {
        const runId = services.approvalRuns.get(cmd.approvalId)!;
        services.runRepo.setStatus(runId, "running");
        const toolCallId = services.approvalToolCalls.get(cmd.approvalId);
        if (toolCallId) services.toolCallRepo.setStatus(toolCallId, "running");
        const run = services.runRepo.get(runId);
        if (run) services.emit("run.status", { status: "running" }, run.sessionId, runId);
      }
      services.approvalRuns.delete(cmd.approvalId);
      services.approvalToolCalls.delete(cmd.approvalId);
      services.send({ type: "pong", requestId: cmd.requestId });
      return true;
    default: return false;
  }
}
