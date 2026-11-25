import { acknowledgeMcpCredentials, applyMcpCredential, connectMcp, mcpServerList } from "./mcp-connections";
import { runtimeText, runtimeError, runtimeErrorInfo } from "./runtime-localization";
import { syncClaudeCode } from "./claude-code/sync";
import { resendMcpIcons } from "./mcp-icons";
import { acknowledgeClaudeCredentials } from "./claude-code/credentials";
import { repeatedUserMessageId, mcpCredentialKeys } from "@qone/protocol";
import type { RuntimeCommand, PermissionDecision, MessageAttachmentInfo } from "@qone/protocol";
import { thinkingLevelsForApi, parseMcpCommand, supportsMemorySummary } from "@qone/protocol";
import path from "node:path";
import { createLocalSkill, createResourceLoader, deleteLocalSkill, installLocalSkill } from "./skills.js";
import { installCloudSkill, listCloudSkills } from "./skill-catalog.js";
import { setBuiltinSkillEnabled, syncPonytailProject, updateBuiltinSkill } from "./builtin-skills/manager.js";
import { containsSecretConfig } from "./secrets.js";
import { configurePodcast } from "./reach-podcast.js";
import { normalizeSubagentConfig } from "./subagents.js";
import { type SessionCompactionCheckpoint } from "./session-compaction.js";
import { globalInstructionsDirectory, globalInstructionsPath, readGlobalInstructions, writeGlobalInstructions } from "./global-instructions.js";
import type { runtimeCommandServices } from "./index.js";

/** A conversation turn is starting, running or compacting; a new turn must wait. */
export function sessionHasActiveRun(services: ReturnType<typeof runtimeCommandServices>, sessionId: string): boolean {
  return services.startingRunSessions.has(sessionId) || services.adapter.isRunning(sessionId)
    || services.runRepo.listBySession(sessionId).some((run) => !services.subagentRunRepo.get(run.id) && ["created", "running", "waiting_approval", "paused"].includes(run.status));
}

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

    case "mcp.credentials.restored":
      acknowledgeMcpCredentials(cmd);
      return true;

    case "claude-code.credentials.saved":
      acknowledgeClaudeCredentials(cmd.requestId, cmd.saved);
      return true;

    case "claude-code.sync": {
      const result = await syncClaudeCode(cmd, services);
      if (cmd.target === "skills" && result.status === "complete") {
        const { skills } = await createResourceLoader(process.cwd());
        for (const skill of skills) services.skillRepo.upsert(skill);
        services.send({ type: "skills.list", skills });
      }
      services.send({ type: "claude-code.synced", requestId: cmd.requestId, result });
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

    case "servers.list": case "servers.add": case "servers.update": case "servers.delete": case "servers.test":
    case "servers.move": case "servers.group.create": case "servers.group.rename": case "servers.group.delete":
    case "servers.discover": case "servers.tunnel.close":
    case "server.terminal.open": case "server.terminal.write": case "server.terminal.resize": case "server.terminal.close":
      try {
        await services.servers.handle(cmd);
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, message: error instanceof Error ? error.message : String(error) });
      }
      return true;

    case "memory.get":
    case "memory.enabled.set":
    case "memory.model.set":
    case "memory.note.save":
    case "memory.note.delete":
    case "memory.preference.edit":
    case "memory.summary.delete":
      try {
        const store = services.memory.store;
        if (cmd.type === "memory.enabled.set") {
          services.preferencesRepo.set("memory.enabled", cmd.enabled);
          // The memory tool only exists while memory is on, so sessions rebuild their tool set.
          if (store.setEnabled(cmd.enabled)) await services.adapter.invalidateSessions();
        } else if (cmd.type === "memory.model.set") {
          if (cmd.modelId === null) services.preferencesRepo.delete("memory.model");
          else {
            const model = services.modelConfigRepo.list().find(config => config.id === cmd.modelId);
            if (!model || !supportsMemorySummary(model)) throw runtimeError("memory.model_unavailable");
            services.preferencesRepo.set("memory.model", model.id);
          }
        } else if (cmd.type === "memory.note.save") {
          const workspace = cmd.preference?.workspaceId;
          if (workspace && !services.workspaceRepo.get(workspace)) throw runtimeError("memory.workspace_unavailable");
          store.saveNote(cmd.content, { id: cmd.id, preference: cmd.preference });
        } else if (cmd.type === "memory.preference.edit") {
          const workspace = cmd.value?.preference.workspaceId;
          if (workspace && !services.workspaceRepo.get(workspace)) throw runtimeError("memory.workspace_unavailable");
          services.memory.editAutomaticPreference(cmd.id, cmd.value);
        } else if (cmd.type === "memory.note.delete") store.deleteNote(cmd.id);
        else if (cmd.type === "memory.summary.delete") store.forgetSummary(cmd.id);
        services.send({ type: "memory.state", requestId: cmd.requestId, state: services.memory.state() });
        if (cmd.type === "memory.enabled.set" || cmd.type === "memory.model.set") services.executionAnalysis.invalidate();
        if (cmd.type !== "memory.get") void services.memory.refresh();
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return true;

    case "stats.get":
    case "stats.record.set":
    case "stats.memoryAccess.set":
      try {
        const stats = services.executionStats;
        if (cmd.type === "stats.record.set") stats.setRecord(cmd.record);
        else if (cmd.type === "stats.memoryAccess.set") stats.setMemoryAccess(cmd.enabled);
        services.send({ type: "stats.state", requestId: cmd.requestId, state: stats.state(cmd.type === "stats.get" ? cmd.range : "today") });
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return true;

    case "skills.cloud.list": {
      const page = await listCloudSkills(cmd.collection, cmd.page, cmd.query);
      services.send({ type: "skills.cloud.list", requestId: cmd.requestId, ...page });
      return true;
    }
    case "skills.builtin.set-enabled": {
      const skill = await setBuiltinSkillEnabled(cmd.skillId, cmd.enabled);
      if (cmd.skillId === "ponytail") {
        await Promise.all(services.workspaceRepo.list().map((workspace) => syncPonytailProject(workspace.path, cmd.enabled)));
      }
      await services.adapter.refreshSkills();
      services.skillRepo.upsert(skill);
      services.send({ type: "skills.builtin.changed", requestId: cmd.requestId, skill });
      return true;
    }
    case "skills.builtin.update": {
      const result = await updateBuiltinSkill(cmd.skillId);
      if (cmd.skillId === "ponytail") {
        await Promise.all(services.workspaceRepo.list().map((workspace) => syncPonytailProject(workspace.path, result.skill.enabled !== false)));
      }
      await services.adapter.refreshSkills();
      services.skillRepo.upsert(result.skill);
      services.send({ type: "skills.builtin.changed", requestId: cmd.requestId, ...result });
      return true;
    }
    case "skills.cloud.install": {
      const skill = await installCloudSkill(cmd.source, cmd.skillId);
      await services.adapter.refreshSkills();
      services.skillRepo.upsert(skill);
      services.send({ type: "skills.cloud.installed", requestId: cmd.requestId, skill: skill });
      return true;
    }
    case "skills.delete": {
      await deleteLocalSkill(cmd.skillId);
      services.skillRepo.delete(cmd.skillId);
      await services.adapter.refreshSkills();
      services.send({ type: "skills.deleted", requestId: cmd.requestId, skillId: cmd.skillId });
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

    case "agent.permission-mode.set": {
      services.adapter.setPermissionMode(cmd.sessionId, cmd.permissionMode);
      services.send({ type: "pong", requestId: cmd.requestId });
      return true;
    }

    case "browser.status": {
      await services.browserReady;
      const browser = services.browserSync;
      if (!browser) {
        services.send({ type: "error", requestId: cmd.requestId, message: "browser integration is unavailable" });
        return true;
      }
      services.send({ type: "browser.status", requestId: cmd.requestId, status: browser.status() });
      return true;
    }

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
        await services.browserReady;
        const browser = services.browserSync;
        if (!browser) throw new Error("browser integration is unavailable");
        const status = await browser.connect();
        services.send({ type: "browser.status", requestId: cmd.requestId, status: status });
      } catch {
        // Browser failures already update the integration status. Avoid showing
        // the same error a second time in the page-wide banner.
        const browser = services.browserSync;
        if (browser) services.send({ type: "browser.status", requestId: cmd.requestId, status: browser.status() });
        else services.send({ type: "error", requestId: cmd.requestId, message: "browser integration is unavailable" });
      }
      return true;

    case "browser.open":
      try {
        await services.browserReady;
        const browser = services.browserSync;
        if (!browser) throw new Error("browser integration is unavailable");
        await browser.openUrl(cmd.url);
        services.send({ type: "pong", requestId: cmd.requestId });
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return true;

    case "browser.current-url":
      try {
        await services.browserReady;
        const browser = services.browserSync;
        if (!browser) throw new Error("browser integration is unavailable");
        const url = await browser.currentUrl();
        services.send({ type: "browser.current-url", requestId: cmd.requestId, url });
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return true;

    case "douyin.bridge.response":
      services.douyinBridge.handleResponse(cmd);
      return true;

    case "apps.opencli.response":
      services.appOpenCliBridge.handleResponse(cmd);
      return true;

    case "mcp.list":
      resendMcpIcons();
      services.send({ type: "mcp.list", servers: mcpServerList(services) });
      return true;

    case "mcp.connect": {
      const config = { ...cmd.config, disabled: undefined };
      const subjectId = `mcp:${config.id}`;
      services.permissionRepo.ensure(subjectId, "mcp.connect", "ask");
      await services.authorizeCommand(subjectId, "mcp.connect", "mcp.connect", { id: config.id, name: config.name, command: config.command, url: config.url });
      services.mcpConnectionApprovals.set(config.id, config);
      services.mcpServerRepo.upsert(config);
      await connectMcp(config, services, cmd.requestId, cmd.reconnect);
      return true;
    }

    case "mcp.disconnect": {
      // Keeps the configuration, marked disabled so it neither starts with the app nor reconnects.
      const config = services.mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (config) services.mcpServerRepo.upsert({ ...config, disabled: true });
      services.pendingMcpAuthRequests.delete(cmd.serverId);
      services.mcpConnectionApprovals.delete(cmd.serverId);
      await services.mcp.disconnect(cmd.serverId);
      await services.refreshCustomTools();
      services.send({ type: "mcp.list", servers: mcpServerList(services) });
      return true;
    }

    case "mcp.delete": {
      const config = services.mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) {
        services.send({ type: "error", requestId: cmd.requestId, message: `unknown MCP server ${cmd.serverId}` });
        return true;
      }
      services.mcpConnectionApprovals.delete(cmd.serverId);
      await services.mcp.disconnect(cmd.serverId);
      services.mcp.clearCredentials(cmd.serverId);
      services.pendingMcpAuthRequests.delete(cmd.serverId);
      services.mcpServerRepo.delete(cmd.serverId);
      for (const key of mcpCredentialKeys(config)) services.runtimeSecrets.delete(key);
      await services.adapter.deleteSecret(config.oauth?.tokenSecretKey ?? `mcp.oauth:${cmd.serverId}`);
      await services.refreshCustomTools();
      services.send({ type: "mcp.list", servers: mcpServerList(services) });
      return true;
    }

    case "mcp.oauth.begin": {
      const config = services.mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) throw new Error(`unknown MCP server ${cmd.serverId}`);
      if (config.url && !config.oauth && !config.authMode) config.authMode = "oauth";
      return handleRuntimeCommand({ type: "mcp.connect", requestId: cmd.requestId, config }, services);
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
      if (cmd.permission === "mcp.connect") {
        services.mcpConnectionApprovals.delete(cmd.subjectId.slice("mcp:".length));
        await services.refreshCustomTools();
        services.send({ type: "mcp.list", servers: mcpServerList(services) });
      }
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
      await services.ensureModelsReady();
      const session = services.sessionRepo.get(cmd.sessionId);
      const cwd = session?.workspaceId ? services.workspaceRepo.get(session.workspaceId)?.path : undefined;
      if (!session || !cwd) {
        services.send({ type: "error", requestId: cmd.requestId, message: "session workspace not found" });
        return true;
      }
      if (sessionHasActiveRun(services, cmd.sessionId)) {
        services.send({ type: "error", requestId: cmd.requestId, message: "session already has an active run" });
        return true;
      }
      const history = services.messageRepo.listMetaBySession(cmd.sessionId);
      if (!history.length) {
        services.send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.there_is_no_session_content_to_compact") });
        return true;
      }
      try {
        const context = await services.adapter.compactSession(cmd.sessionId, cwd, cmd.model);
        try {
          const throughMessageId = history.at(-1)!.id;
          services.settingsRepo.set(`compaction:${cmd.sessionId}`, { throughMessageId, context: context } satisfies SessionCompactionCheckpoint);
          services.messageRepo.pruneCompactedRawMessages(cmd.sessionId, throughMessageId);
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
      await services.ensureModelsReady();
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
      // The list is the stored configuration; it never depends on network model
      // metadata. Reply at once and refresh the registry in the background:
      // every command that needs a configured registry awaits it itself.
      services.send({ type: "model.list", configs: services.modelConfigRepo.list() });
      void services.ensureModelsReady().catch((error) => services.log.warn("model configuration refresh failed", { err: String(error) }));
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
      services.send({ type: "model.updated", requestId: cmd.requestId, config });
      void services.memory.refresh();
      return true;
    }

    case "model.delete":
      services.modelConfigRepo.delete(cmd.id);
      await services.adapter.configureModels(services.modelConfigRepo.list());
      services.send({ type: "model.list", configs: services.modelConfigRepo.list() });
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
      if (cmd.key === "reach.groq.apiKey") {
        services.runtimeSecrets.set(cmd.key, cmd.value);
        services.send({ type: "secret.saved", requestId: cmd.requestId });
        services.sendReachChannels();
        return true;
      }
      const changed = services.runtimeSecrets.get(cmd.key) !== cmd.value;
      services.runtimeSecrets.set(cmd.key, cmd.value);
      const configs = services.mcpServerRepo.list().filter(server => mcpCredentialKeys(server).includes(cmd.key));
      for (const config of configs) {
        applyMcpCredential(config, cmd.key, cmd.value, services);
        if (changed) services.mcp.invalidateConnection(config.id);
      }
      if (!configs.length && !cmd.key.startsWith("mcp.env:")) {
        if (cmd.key === "mcp.oauth:mcp-github") services.mcp.setAccessToken("mcp-github", cmd.value);
        else await services.adapter.setSecret(cmd.key, cmd.value);
      }
      services.send({ type: "secret.saved", requestId: cmd.requestId });
      if (changed && cmd.key.startsWith("model.apiKey:")) {
        void services.memory.refresh();
        void services.executionAnalysis.check();
      }
      return true;
    }

    case "secret.delete": {
      services.runtimeSecrets.delete(cmd.key);
      for (const config of services.mcpServerRepo.list().filter(server => mcpCredentialKeys(server).includes(cmd.key))) {
        services.mcp.clearCredentials(config.id);
        services.mcp.invalidateConnection(config.id);
      }
      await services.refreshCustomTools();
      await services.adapter.deleteSecret(cmd.key);
      services.send({ type: "pong", requestId: cmd.requestId });
      if (cmd.key === "reach.groq.apiKey") services.sendReachChannels();
      return true;
    }

    case "background-shell.stop": {
      try {
        await services.backgroundShell.stop(cmd.jobId);
        services.send({ type: "pong", requestId: cmd.requestId });
      } catch (error) {
        services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return true;
    }

    case "agent.run": {
      await services.ensureModelsReady();
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
      const workspaceCwd = services.workspaceRepo.get(s.workspaceId)?.path;
      if (!workspaceCwd) {
        services.send({ type: "error", requestId: cmd.requestId, message: "session workspace no longer exists" });
        return true;
      }
      const goal = cmd.goal ? services.goalRepo.getBySession(cmd.sessionId) : undefined;
      if (cmd.goal && (!goal || goal.status !== "active")) {
        services.send({ type: "error", requestId: cmd.requestId, message: "goal is not active" });
        return true;
      }
      if (cmd.mcpServerId && (!services.mcp.isAvailable(cmd.mcpServerId) || services.mcp.toolCount(cmd.mcpServerId) === 0)) {
        services.send({ type: "error", requestId: cmd.requestId, message: "selected MCP server is not connected or has no tools" });
        return true;
      }
      if (sessionHasActiveRun(services, cmd.sessionId)) {
        services.send({ type: "error", requestId: cmd.requestId, message: "session already has an active run" });
        return true;
      }
      services.backgroundShell.noteRun(cmd.sessionId, { model: cmd.model, permissionMode: cmd.permissionMode, thinking: cmd.thinking, serverIds: cmd.serverIds });
      if (!cmd.continuation && !cmd.goalContinuation && !cmd.replaceFromMessageId) {
        cmd.replaceFromMessageId = repeatedUserMessageId(services.messageRepo.listMetaBySession(cmd.sessionId).map(message => ({
          ...message,
          attachments: message.attachments ? JSON.parse(message.attachments) as MessageAttachmentInfo[] : undefined,
        })), { content: cmd.message, attachments: cmd.attachments });
      }
      if (cmd.replaceFromMessageId) {
        services.startingRunSessions.add(cmd.sessionId);
        try {
          const history = services.messageRepo.listMetaBySession(cmd.sessionId);
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
          // Do not truncate until the retry queue can no longer restore deleted rows.
          services.flushEvents({ required: true });
          services.messageRepo.truncateFrom(cmd.sessionId, cmd.replaceFromMessageId);
          for (const child of childRuns) if (removedRunIds.has(child.runId)) {
            services.subagentPublisher.forget(child.runId);
            if (child.executionSessionId) services.subagentNotificationCoordinator?.dispose(child.executionSessionId);
          }
          await services.generatedArtifacts.removeRuns(cmd.sessionId, [...removedRunIds]);
          services.eventJournal.restore(services.eventRepo.list());
        } catch (error) {
          services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
          return true;
        } finally {
          services.startingRunSessions.delete(cmd.sessionId);
        }
      }
      const run = services.runRepo.create(cmd.sessionId, {
        origin: goal ? (cmd.goalContinuation ? "goal_continuation" : "goal_kickoff") : "manual",
        goalId: goal?.id,
        goalEpoch: goal?.epoch,
      });
      services.assistantPartsByRun.set(run.id, []);
      services.liveAssistantByRun.set(run.id, { content: "", parts: [], sequence: 0 });
      const turn = services.turnRepo.create(run.id);
      if (cmd.notice) {
        // The person sees the card; the native message replays the model input after a restart.
        services.messageRepo.add(cmd.sessionId, "user", cmd.notice.content, run.id, undefined, undefined, undefined, undefined, undefined, undefined,
          { role: "user", content: [{ type: "text", text: cmd.message }], timestamp: Date.now() }, cmd.notice.communication);
        services.sendMessages(cmd.sessionId);
      } else if (!cmd.goalContinuation) {
        const userMessage = services.messageRepo.add(cmd.sessionId, "user", cmd.message, run.id, undefined, cmd.messageId, cmd.attachments, undefined, goal?.id, cmd.quote);
        services.touchSession(cmd.sessionId, userMessage.createdAt);
      }
      if (cmd.queueItemId) {
        services.queueRepo.remove(cmd.sessionId, cmd.queueItemId);
        services.sendQueue(cmd.sessionId);
      }
      services.emit("agent.started", { runId: run.id }, cmd.sessionId, run.id);

      const mcpCommand = cmd.mcpServerId ? parseMcpCommand(cmd.message) : undefined;
      const routedMessage = mcpCommand && mcpCommand.serverId === cmd.mcpServerId ? mcpCommand.text : cmd.message;
      const notificationDelivery = services.subagentNotificationCoordinator?.pendingPrompt(cmd.sessionId) ?? { ids: [] as string[], prompt: undefined };
      const modelMessage = [notificationDelivery.prompt, routedMessage].filter(Boolean).join("\n\n");
      Promise.resolve()
        .then(() => {
          if (services.runRepo.get(run.id)?.status === "cancelled") return;
          services.subagentNotificationCoordinator?.markDelivered(notificationDelivery.ids);
          if (notificationDelivery.ids.length) services.sendSubagentNotifications(cmd.sessionId);
          return services.adapter.run(cmd.sessionId, modelMessage, { model: cmd.model, cwd: workspaceCwd, runId: run.id, eventSessionId: cmd.sessionId, permissionMode: cmd.permissionMode, thinking: cmd.thinking, serverIds: cmd.serverIds, attachments: cmd.attachments, mcpServerId: cmd.mcpServerId, goalId: goal?.id, goalEpoch: goal?.epoch,
            memoryUserMessage: cmd.notice || cmd.goalContinuation ? undefined : cmd.message }, (type, payload) =>
          services.emit(type, payload, cmd.sessionId, run.id)
        );
        })
        .then(async () => {
          if (services.runRepo.get(run.id)?.status === "cancelled") return;
          const cancelled = services.cancelledRuns.delete(run.id);
          if (cancelled) {
            await services.subagentController.stopChildren(cmd.sessionId, run.id);
            if (services.runRepo.get(run.id)?.status === "cancelled") return;
          }
          const parts = services.assistantPartsByRun.get(run.id) ?? [];
          const assistantMessage = services.persistPartialAssistant(cmd.sessionId, run.id, cmd.model);
          services.releaseUndeliveredSteers(cmd.sessionId, run.id);
          services.initialUserMessageSeen.delete(run.id);
          services.assistantBuffers.delete(run.id);
          services.assistantStreamBuffers.delete(run.id);
          services.assistantPartsByRun.delete(run.id);
          services.assistantMessageSequenceByRun.delete(run.id);
          services.assistantRawMessagesByRun.delete(run.id);
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
          if (services.runRepo.get(run.id)?.status === "cancelled") return;
          if (notificationDelivery.ids.length) {
            services.subagentNotificationCoordinator?.markPending(notificationDelivery.ids);
            services.sendSubagentNotifications(cmd.sessionId);
          }
          const cancelled = services.cancelledRuns.delete(run.id);
          if (cancelled) {
            await services.subagentController.stopChildren(cmd.sessionId, run.id);
            if (services.runRepo.get(run.id)?.status === "cancelled") return;
          }
          const parts = services.assistantPartsByRun.get(run.id) ?? [];
          const assistantMessage = services.persistPartialAssistant(cmd.sessionId, run.id, cmd.model);
          services.releaseUndeliveredSteers(cmd.sessionId, run.id);
          services.initialUserMessageSeen.delete(run.id);
          services.assistantBuffers.delete(run.id);
          services.assistantStreamBuffers.delete(run.id);
          services.assistantPartsByRun.delete(run.id);
          services.assistantMessageSequenceByRun.delete(run.id);
          services.assistantRawMessagesByRun.delete(run.id);
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
        }).catch((error) => {
          services.log.error("run finalization failed", { sessionId: cmd.sessionId, runId: run.id, err: String(error) });
          services.send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
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
      // A second press while stopping forces it: the run settles even if a tool ignores the abort.
      const accepted = cmd.force ? services.adapter.forceStop(cmd.runId) : services.adapter.stop(cmd.runId);
      const stale = !accepted && cmd.force && stoppedRun && ["created", "running", "waiting_approval", "paused"].includes(stoppedRun.status);
      if (!accepted && !stale) {
        services.send({ type: "error", requestId: cmd.requestId, message: `unknown active run ${cmd.runId}` });
        return true;
      }
      services.cancelledRuns.add(cmd.runId);
      // Pause goal continuation before awaiting child shutdown: the parent can settle immediately.
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
      if (stoppedRun) await services.subagentController.stopChildren(stoppedRun.sessionId, cmd.runId, cmd.force);
      if (stale && stoppedRun && services.runRepo.get(cmd.runId)?.status !== "cancelled") {
        const parts = services.assistantPartsByRun.get(cmd.runId) ?? [];
        const message = services.persistPartialAssistant(stoppedRun.sessionId, cmd.runId);
        services.releaseUndeliveredSteers(stoppedRun.sessionId, cmd.runId);
        for (const map of [services.assistantBuffers, services.assistantStreamBuffers, services.assistantPartsByRun, services.assistantMessageSequenceByRun, services.assistantRawMessagesByRun, services.liveAssistantByRun]) map.delete(cmd.runId);
        services.initialUserMessageSeen.delete(cmd.runId);
        for (const key of services.toolCallIds.keys()) if (key.startsWith(`${cmd.runId}:`)) services.toolCallIds.delete(key);
        for (const turn of services.turnRepo.listByRun(cmd.runId)) if (turn.status === "running") services.turnRepo.finish(turn.id, "cancelled");
        for (const [id, runId] of services.approvalRuns) if (runId === cmd.runId) {
          services.adapter.reject(id);
          services.commandApprovals.reject(id);
          services.approvalRuns.delete(id);
          services.approvalToolCalls.delete(id);
        }
        services.cancelledRuns.delete(cmd.runId);
        services.runRepo.finish(cmd.runId, "cancelled");
        services.emit("agent.cancelled", message ? { message: { ...message, parts } } : {}, stoppedRun.sessionId, cmd.runId);
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
