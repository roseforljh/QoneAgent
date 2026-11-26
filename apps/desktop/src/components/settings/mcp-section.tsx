import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Plus, Search, X } from "lucide-react";
import { mcpAvailable, mcpServerIdentity, mcpValueSecretKeys, type McpServerInfo } from "@qone/protocol";
import { ClaudeCodeSyncButton } from "./ClaudeCodeSyncButton";
import { useStore } from "../../store";
import { useLocale, type MessageKey } from "../../localization";
import { invoke } from "../../lib/desktop-bridge";
import { openUrl } from "../../lib/desktop-bridge";
import { hasDesktopBridge } from "../../store";
import { localizeError } from "../../lib/error-localization";
import { cn } from "../../lib/utils";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import { SectionHeader, SettingsPageHeader } from "./settings-chrome";
import { EMAIL_PRESETS, KEY_PRESETS, MCP_PRESETS, configuredGithubClientId, mcpLogo, presetServer } from "./mcp-presets";
import { useMcpIcons } from "../../lib/mcp-icons";
import { McpQuickAdd } from "./mcp-quick-add";
import { defaultMcpName, type ParsedMcp } from "../../lib/mcp-command";

function deriveUrlName(rawUrl: string): string {
  try {
    return defaultMcpName({ url: rawUrl });
  } catch {
    return rawUrl.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0] || "mcp";
  }
}

export function McpSection() {
  const { t } = useLocale();
  const { isCopied: isDeviceCodeCopied, copyToClipboard } = useCopyToClipboard();
  const send = useStore((state) => state.send);
  const servers = useStore((state) => state.mcpServers);
  const lastError = useStore((state) => state.lastError);
  const connectingIds = useStore((state) => state.mcpConnectingIds);
  const oauthAuthorization = useStore((state) => state.oauthAuthorization);
  const githubDeviceAuthorization = useStore((state) => state.githubDeviceAuthorization);
  const [mode, setMode] = useState<"url" | "stdio">("url");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [prefillId, setPrefillId] = useState<string>();
  const [editing, setEditing] = useState<McpServerInfo>();
  const [addOpen, setAddOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [pendingOn, setPendingOn] = useState<ReadonlySet<string>>(new Set());
  // 卡片操作对话框：点卡片（开关以外区域）弹出，按钮按服务类型区分。
  const presetName = (preset: { name: string; nameKey?: MessageKey }) => preset.nameKey ? t(preset.nameKey) : preset.name;
  const icons = useMcpIcons();
  // Custom services show their official icon once resolved, otherwise the MCP mark.
  const serverIcon = (server: McpServerInfo) => <span className="settings-provider-icon">
    {icons[server.id] ? <img className="settings-mcp-avatar" src={icons[server.id]} alt="" aria-hidden="true" draggable={false} /> : <span className="settings-mcp-logo settings-mcp-logo-mono" aria-hidden="true" style={{ maskImage: `url("${mcpLogo}")`, WebkitMaskImage: `url("${mcpLogo}")` }} />}
  </span>;
  const [actionCard, setActionCard] = useState<{ server?: McpServerInfo; name: string; icon: ReactNode; status: string; statusError?: boolean; actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] } | null>(null);
  const [githubLoginOpen, setGithubLoginOpen] = useState(false);
  const [githubClientId, setGithubClientId] = useState(configuredGithubClientId);
  const [githubSaving, setGithubSaving] = useState(false);
  const [query, setQuery] = useState("");
  // 填 key 即用的小对话框：只留 key 输入框，粘贴后直连。
  const [keyDialog, setKeyDialog] = useState<{ preset: (typeof KEY_PRESETS)[number]; fields: { key: string; value: string }[] } | null>(null);
  const [keySaving, setKeySaving] = useState(false);

  useEffect(() => {
    send({ type: "mcp.list", requestId: crypto.randomUUID() });
  }, [send]);

  // connect 是异步的（npx 首次还要下包），开关先乐观亮起，服务进列表后清掉 pending。
  useEffect(() => {
    setPendingOn((current) => {
      if (!current.size) return current;
      const next = new Set(current);
      for (const server of servers) next.delete(server.id);
      return next.size === current.size ? current : next;
    });
  }, [servers]);

  // 用户在设置页主动操作 = 已授权，先下发 allow 跳过聊天页审批卡。
  const connectAsUser = async (config: McpServerInfo, reconnect = false) => {
    // 等待权限命令写入 sidecar 后再下发 connect，避免两次 IPC 调用乱序。
    const allowed = await send({ type: "permission.set", requestId: crypto.randomUUID(), subjectId: `mcp:${config.id}`, permission: "mcp.connect", decision: "allow" });
    const sent = allowed && await send({ type: "mcp.connect", requestId: crypto.randomUUID(), config, ...(reconnect ? { reconnect } : {}) });
    setPendingOn((current) => { const next = new Set(current); next.delete(config.id); return next; });
    return Boolean(sent);
  };

  const deleteServer = async (server: McpServerInfo) => {
    try {
      if (hasDesktopBridge()) {
        const oauthKeys = [server.oauth?.tokenSecretKey ?? `mcp.oauth:${server.id}`, `mcp.oauth:${server.id}.client`, `mcp.oauth:${server.id}.tokens`];
        await Promise.all(oauthKeys.map((key) => invoke("secret_delete", { key }).catch(() => undefined)));
        const envKeys = mcpValueSecretKeys(server);
        for (const key of envKeys) {
          if (await invoke<string | null>("secret_get", { key }) !== null) await invoke("secret_delete", { key });
        }
      }
      await send({ type: "mcp.delete", requestId: crypto.randomUUID(), serverId: server.id });
    } catch (error) {
      useStore.setState({ lastError: localizeError(error) });
    }
  };

  const connectGitHub = async () => {
    const clientId = githubClientId.trim() || configuredGithubClientId;
    if (!clientId) return;
    setGithubSaving(true);
    try {
      setGithubLoginOpen(false);
      setPendingOn((current) => new Set(current).add("mcp-github"));
      await connectAsUser({ id: "mcp-github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authMode: "github-device", oauthClientId: clientId });
    } catch (error) {
      useStore.setState({ lastError: localizeError(error) });
    } finally {
      setGithubSaving(false);
    }
  };

  const togglePreset = (preset: (typeof MCP_PRESETS)[number], enabled: boolean) => {
    const server = presetServer(servers, preset);
    if (enabled) {
      if (server) void send({ type: "mcp.disconnect", requestId: crypto.randomUUID(), serverId: server.id });
      return;
    }
    if (preset.id === "mcp-github" && !server) { setGithubLoginOpen(true); return; }
    const config = server ?? { id: preset.id, name: presetName(preset), ...preset.config };
    setPendingOn((current) => new Set(current).add(config.id));
    void connectAsUser(config);
  };

  const openAdd = (preset?: { id: string; name: string; prefill: { command: string; args: string; env: string } }) => {
    setEditing(undefined);
    setPrefillId(preset?.id);
    setMode(preset ? "stdio" : "url");
    setName(preset?.name ?? "");
    setCommand(preset?.prefill.command ?? "");
    setUrl("");
    setApiKey("");
    setArgs(preset?.prefill.args ?? "");
    setEnvText(preset?.prefill.env ?? "");
    setAddOpen(true);
  };

  const openEdit = (server: (typeof servers)[number]) => {
    setEditing(server);
    setPrefillId(server.id);
    setMode(server.command && !server.url ? "stdio" : "url");
    setName(server.name);
    setCommand(server.command ?? "");
    setUrl(server.url ?? "");
    setApiKey("");
    setArgs((server.args ?? []).join(" "));
    setEnvText(Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"));
    setAddOpen(true);
  };

  // Saved account configurations reconnect without asking for credentials again.
  const toggleEmailPreset = (preset: { id: string; name: string; prefill: { command: string; args: string; env: string } }, enabled: boolean) => {
    const server = servers.find(item => item.id === preset.id);
    if (server) { toggleCustom(server, enabled); return; }
    openAdd(preset);
  };

  // Synced services Qone already ships as presets are switched on right away; other imports wait for the user.
  const enableSyncedPresets = () => {
    const { mcpServers: current, mcpConnectingIds } = useStore.getState();
    for (const preset of [...MCP_PRESETS, ...KEY_PRESETS]) {
      const server = presetServer(current, preset);
      if (server && !server.disabled && !server.connecting && !mcpAvailable(server) && !mcpConnectingIds.includes(server.id)) void connectAsUser(server);
    }
  };

  const customServers = servers.filter((server) => !MCP_PRESETS.some((preset) => presetServer(servers, preset)?.id === server.id) && !EMAIL_PRESETS.some((preset) => preset.id === server.id) && !KEY_PRESETS.some((preset) => presetServer(servers, preset)?.id === server.id));

  // Encrypted on disk and handed to the runtime; configurations keep only the `$mcp.env:` reference.
  const storeSecret = async (key: string, value: string) => {
    await invoke("secret_set", { key, value });
    if (!await send({ type: "secret.set", requestId: crypto.randomUUID(), key, value })) throw new Error(t("error.mcpKeySendFailed"));
  };

  // One pasted line: same services land on their preset or existing server, everything else becomes a custom service.
  // Resolves once the service is connected (or waits on a login), with the failure text otherwise.
  const settleConnection = (id: string) => new Promise<string | undefined>((resolve) => {
    const outcome = (state: ReturnType<typeof useStore.getState>) => {
      if (state.oauthAuthorization?.serverId === id || state.githubDeviceAuthorization?.serverId === id) return "";
      if (state.mcpConnectingIds.includes(id)) return undefined;
      return "settled";
    };
    // The store clears the connecting flag before it records the connection or its error; judge on the next tick.
    const finish = (result: string) => result === "settled"
      ? setTimeout(() => {
        const state = useStore.getState();
        resolve(mcpAvailable(state.mcpServers.find((server) => server.id === id)) ? undefined : state.lastError || t("mcp.quickAdd.failed"));
      }, 0)
      : resolve(undefined);
    const initial = outcome(useStore.getState());
    if (initial !== undefined) { finish(initial); return; }
    const unsubscribe = useStore.subscribe((state) => {
      const result = outcome(state);
      if (result === undefined) return;
      unsubscribe(); finish(result);
    });
  });

  const addParsed = async (items: ParsedMcp[]): Promise<string | undefined> => {
    try {
      const taken = new Set(servers.map((server) => server.id));
      for (const item of items) {
        const candidate: McpServerInfo = { id: "", name: item.name, command: item.command, args: item.args, url: item.url, ...(item.url ? { transport: item.transport } : {}) };
        const preset = [...MCP_PRESETS, ...KEY_PRESETS].find((entry) => presetServer([candidate], entry));
        const existing = servers.find((server) => mcpServerIdentity(server) === mcpServerIdentity(candidate)) ?? (preset && presetServer(servers, preset));
        const slug = item.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || "mcp";
        let id = existing?.id ?? preset?.id ?? slug;
        for (let suffix = 2; !existing && taken.has(id); suffix++) id = `${slug}-${suffix}`;
        taken.add(id);
        const reference = async (key: string, value: string) => { if (value.startsWith("$")) return value; await storeSecret(key, value); return `$${key}`; };
        const env = { ...existing?.env };
        for (const [key, value] of Object.entries(item.env)) env[key] = await reference(`mcp.env:${id}/${key}`, value);
        const headers = { ...existing?.headers };
        for (const [key, value] of Object.entries(item.headers)) headers[key] = await reference(`mcp.env:${id}/header-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, value);
        const config: McpServerInfo = { ...(preset && "config" in preset ? preset.config : {}), ...existing, ...candidate, id, name: existing?.name ?? (preset ? presetName(preset) : item.name),
          ...(Object.keys(env).length ? { env } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
        setPendingOn((current) => new Set(current).add(id));
        useStore.setState({ lastError: undefined });
        if (!await connectAsUser(config)) return t("error.runtimeUnavailable");
        const failure = await settleConnection(id);
        if (failure) { useStore.setState({ lastError: undefined }); return `${config.name}：${failure}`; }
      }
      return undefined;
    } catch (error) {
      return localizeError(error);
    }
  };

  // 填 key 即用：开关点开只有 key 输入框的小窗，保存凭据后立即连接。
  const openKeyDialog = (preset: (typeof KEY_PRESETS)[number]) => {
    setKeyDialog({
      preset,
      fields: preset.prefill.env.split("\n").map((line) => {
        const i = line.indexOf("=");
        return { key: (i >= 0 ? line.slice(0, i) : line).trim(), value: i >= 0 ? line.slice(i + 1).trim() : "" };
      }).filter((field) => field.key),
    });
  };

  const submitKeyDialog = async () => {
    if (!keyDialog || keySaving || keyDialog.fields.some((field) => !field.value.trim())) return;
    const { preset } = keyDialog;
    const server = presetServer(servers, preset);
    const id = server?.id ?? preset.id;
    setKeySaving(true);
    try {
      const env = { ...server?.env, ...Object.fromEntries(keyDialog.fields.map((field) => [field.key, `$mcp.env:${id}/${field.key}`])) };
      for (const field of keyDialog.fields) await storeSecret(`mcp.env:${id}/${field.key}`, field.value.trim());
      setPendingOn((current) => new Set(current).add(id));
      if (await connectAsUser({ ...server, id, name: server?.name ?? presetName(preset), command: server?.command ?? preset.prefill.command, args: server?.args ?? preset.prefill.args.trim().split(/\s+/), env })) setKeyDialog(null);
    } catch (error) {
      useStore.setState({ lastError: localizeError(error) });
    } finally {
      setKeySaving(false);
    }
  };

  const toggleKeyPreset = (preset: (typeof KEY_PRESETS)[number], enabled: boolean) => {
    const server = presetServer(servers, preset);
    if (server) { toggleCustom(server, enabled); return; }
    openKeyDialog(preset);
  };

  const openKeyActions = (preset: (typeof KEY_PRESETS)[number], icon: ReactNode, status: string, statusError: boolean) => {
    const server = presetServer(servers, preset);
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = server
      ? [
          { label: t("mcp.reconnect"), primary: true, onClick: () => { setActionCard(null); setPendingOn((current) => new Set(current).add(server.id)); void connectAsUser(server, true); } },
          { label: t("mcp.editKey"), onClick: () => { setActionCard(null); openKeyDialog(preset); } },
          { label: t("mcp.remove"), danger: true, onClick: () => { setActionCard(null); void deleteServer(server); } },
        ]
      : [{ label: t("mcp.fillKey"), primary: true, onClick: () => { setActionCard(null); openKeyDialog(preset); } }];
    setActionCard({ server, name: presetName(preset), icon, status, statusError, actions });
  };

  // 预设卡操作框：OAuth/GitHub 类出登录/退出登录，stdio 类出重连/移除。
  const openPresetActions = (preset: (typeof MCP_PRESETS)[number], icon: ReactNode, status: string, statusError: boolean) => {
    const server = presetServer(servers, preset);
    const isGithub = preset.id === "mcp-github";
    const isAccount = preset.config.authMode === "oauth" || isGithub;
    const startConnect = () => {
      setActionCard(null);
      if (isGithub && !server) { setGithubLoginOpen(true); return; }
      const config = server ?? { id: preset.id, name: presetName(preset), ...preset.config };
      setPendingOn((current) => new Set(current).add(config.id));
      void connectAsUser(config, Boolean(server));
    };
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = [{ label: server ? t("mcp.reconnect") : t(isAccount ? "mcp.signIn" : "mcp.connect"), primary: true, onClick: startConnect }];
    if (server) actions.push({ label: isAccount ? t("mcp.logout") : t("mcp.remove"), danger: true, onClick: () => { setActionCard(null); void deleteServer(server); } });
    setActionCard({ server, name: presetName(preset), icon, status, statusError, actions });
  };

  // 凭证类卡操作框：凭证即配置，所以给"修改账号配置"入口；已添加的再给重连和移除。
  const openEmailActions = (preset: { id: string; name: string; prefill: { command: string; args: string; env: string } }, icon: ReactNode, status: string, statusError: boolean) => {
    const server = servers.find((item) => item.id === preset.id);
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = server
      ? [
          { label: t("mcp.reconnect"), primary: true, onClick: () => { setActionCard(null); setPendingOn((current) => new Set(current).add(preset.id)); void connectAsUser(server, true); } },
          { label: t("mcp.editAccount"), onClick: () => { setActionCard(null); openAdd(preset); } },
          { label: t("mcp.remove"), danger: true, onClick: () => { setActionCard(null); void deleteServer(server); } },
        ]
      : [{ label: t("mcp.configureAccount"), primary: true, onClick: () => { setActionCard(null); openAdd(preset); } }];
    setActionCard({ server, name: presetName(preset), icon, status, statusError, actions });
  };

  // Custom services keep their configuration when switched off; only removal deletes them.
  const toggleCustom = (server: McpServerInfo, enabled: boolean) => {
    if (enabled) { void send({ type: "mcp.disconnect", requestId: crypto.randomUUID(), serverId: server.id }); return; }
    setPendingOn((current) => new Set(current).add(server.id));
    void connectAsUser(server);
  };

  // 卡片状态胶囊：开关旁统一显示运行/待命/连接中/未连接，卡片副标题只留工具数或说明。
  const statusBadge = (server: McpServerInfo | undefined, connecting: boolean, failed: boolean) => {
    if (connecting) return { label: t("mcp.connectingStatus"), tone: "is-connecting", spin: true };
    if (mcpAvailable(server)) return server?.connected ? { label: t("mcp.connectedStatus"), tone: "is-connected", spin: false } : { label: t("mcp.standbyStatus"), tone: "is-standby", spin: false };
    if (server) return { label: t("mcp.disconnectedStatus"), tone: failed ? "is-error" : "is-disconnected", spin: false };
    return null;
  };
  const renderBadge = (badge: ReturnType<typeof statusBadge>) => badge && (
    <span className={cn("settings-mcp-badge", badge.tone)} role="status">
      {badge.spin && <LoaderCircle size={11} className="settings-spin" aria-hidden="true" />}
      <span>{badge.label}</span>
    </span>
  );

  // 自定义服务操作框：重连、OAuth 授权（如有）、删除。
  const openCustomActions = (server: (typeof servers)[number]) => {
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = [
      { label: t("mcp.reconnect"), primary: true, onClick: () => { setActionCard(null); void connectAsUser(server, true); } },
      { label: t("mcp.editService"), onClick: () => { setActionCard(null); openEdit(server); } },
      ...(server.url && server.authMode !== "github-device" ? [{ label: t("mcp.authorize"), onClick: () => { setActionCard(null); void send({ type: "mcp.oauth.begin", requestId: crypto.randomUUID(), serverId: server.id }); } }] : []),
      { label: t("mcp.remove"), danger: true, onClick: async () => { if (!await confirmDestructiveAction(t("mcp.deleteConfirm", { name: server.name }))) return; setActionCard(null); await deleteServer(server); } },
    ];
    const connecting = connectingIds.includes(server.id);
    setActionCard({ server, name: server.name, icon: serverIcon(server), status: connecting ? t("mcp.connectingStatus") : mcpAvailable(server) ? t(server.connected ? "mcp.connectedStatus" : "mcp.standbyStatus") : t("mcp.disconnectedStatus"), statusError: !server.disabled && !connecting && !mcpAvailable(server), actions });
  };

  const canSubmitManual = mode === "url" ? Boolean(url.trim()) : Boolean(name.trim() && command.trim());

  useEffect(() => {
    if (!addOpen && !githubLoginOpen && !keyDialog && !actionCard) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (addOpen && !addSaving) setAddOpen(false);
      else if (githubLoginOpen && !githubSaving) setGithubLoginOpen(false);
      else if (keyDialog && !keySaving) setKeyDialog(null);
      else if (actionCard) setActionCard(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [addOpen, addSaving, githubLoginOpen, githubSaving, keyDialog, keySaving, actionCard]);

  const connect = async () => {
    if (!canSubmitManual || addSaving) return;
    const resolvedName = mode === "url" ? (name.trim() || deriveUrlName(url.trim())) : name.trim();
    const slug = resolvedName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || `mcp-${Date.now()}`;
    const id = prefillId ?? slug;
    setAddSaving(true);
    try {
      let headers = editing?.headers;
      if (mode === "url" && apiKey.trim()) {
        const trimmedKey = apiKey.trim();
        const headerValue = /^Bearer\s+/i.test(trimmedKey) ? trimmedKey : `Bearer ${trimmedKey}`;
        const secretKey = `mcp.env:${id}/header-authorization`;
        await storeSecret(secretKey, headerValue);
        headers = { ...editing?.headers, Authorization: `$${secretKey}` };
      }
      const env = mode === "stdio" && envText.trim()
        ? Object.fromEntries(envText.split("\n").map((line) => line.trim()).filter((line) => line && line.includes("=")).map((line) => { const i = line.indexOf("="); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }))
        : undefined;
      await connectAsUser({
        ...(editing ? { transport: editing.transport, authMode: editing.authMode, oauthClientId: editing.oauthClientId, oauth: editing.oauth, tokenEnv: editing.tokenEnv } : {}),
        id,
        name: resolvedName,
        ...(mode === "url"
          ? { url: url.trim(), ...(headers ? { headers } : {}) }
          : {
              command: command.trim(),
              args: editing && args === (editing.args ?? []).join(" ") ? editing.args : args.trim() ? args.trim().split(/\s+/) : [],
              ...(env ? { env } : {}),
            }),
      });
      setAddOpen(false);
      setName(""); setCommand(""); setUrl(""); setApiKey(""); setArgs(""); setEnvText(""); setPrefillId(undefined); setEditing(undefined);
    } catch (error) {
      useStore.setState({ lastError: localizeError(error) });
    } finally {
      setAddSaving(false);
    }
  };

  return (
    <>
      <SettingsPageHeader>
        <div className="settings-section-toolbar flex-wrap"><SectionHeader eyebrow={t("mcp.eyebrow")} title={t("mcp.title")} /><ClaudeCodeSyncButton target="mcp" onSynced={enableSyncedPresets} /></div>
        {lastError === t("mcp.nodeRequired") && <div className="error-banner" role="alert">
        <span>{lastError}</span>
        <div className="settings-toolbar-actions">
          <button type="button" className="settings-secondary-action" onClick={() => void openUrl("https://nodejs.org/en/download")}>{t("mcp.downloadNode")}</button>
          <button type="button" className="icon-button" aria-label={t("common.close")} onClick={() => useStore.setState({ lastError: undefined })}><X size={15} /></button>
        </div>
        </div>}
        <div className="settings-mcp-toolbar">
          <label className="settings-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label={t("mcp.search")} placeholder={t("mcp.search")} value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" className="settings-search-clear" aria-label={t("common.clear")} onClick={() => setQuery("")}><X size={13} /></button>}</label>
          <McpQuickAdd onAdd={addParsed} onManual={() => openAdd()} />
        </div>
      </SettingsPageHeader>
      <div className="settings-mcp-list">{MCP_PRESETS.filter((preset) => { const q = query.trim().toLowerCase(); return !q || presetName(preset).toLowerCase().includes(q) || t(preset.descKey).toLowerCase().includes(q); }).map((preset) => {
        const server = presetServer(servers, preset);
        const serverId = server?.id ?? preset.id;
        const connecting = pendingOn.has(serverId) || connectingIds.includes(serverId);
        // 已配置但掉线（登录态丢失/连接失败）：开关回落为关 + 卡片爆红提示，点开=重连。
        const failed = Boolean(server && !server.disabled && !mcpAvailable(server) && !connecting);
        const enabled = connecting || mcpAvailable(server);
        const authorization = oauthAuthorization?.serverId === serverId ? oauthAuthorization : undefined;
        const device = githubDeviceAuthorization?.serverId === serverId ? githubDeviceAuthorization : undefined;
        const badge = statusBadge(server, connecting, failed);
        const subtitle = connecting
          ? authorization ? t("mcp.waitingForLogin") : device ? t("mcp.githubCode", { code: device.userCode }) : t(preset.descKey)
          : mcpAvailable(server)
            ? `${server?.toolCount ?? 0} ${t("mcp.tools")}`
            : t(preset.descKey);
        const icon = <span className="settings-provider-icon" style={preset.lightBadge ? { background: "#fff", color: "#0f0f0f" } : undefined}>
          {preset.mono ? <span className="settings-mcp-logo settings-mcp-logo-mono" aria-hidden="true" style={{ maskImage: `url("${preset.logo}")`, WebkitMaskImage: `url("${preset.logo}")` }} /> : <img className="settings-mcp-logo" src={preset.logo} alt="" aria-hidden="true" draggable={false} />}
        </span>;
        return <div className={cn("settings-mcp-card", "is-actionable", failed && "is-error")} key={preset.id} role="button" tabIndex={0} onClick={() => openPresetActions(preset, icon, badge?.label ?? subtitle, failed)} onKeyDown={(event) => { if (event.key === "Enter") openPresetActions(preset, icon, badge?.label ?? subtitle, failed); }}>
          {icon}
          <div><strong>{presetName(preset)}</strong><small className="settings-mcp-status"><span>{subtitle}</span></small>{device && <button type="button" className="settings-mcp-device-code" title={t("mcp.copyDeviceCode")} aria-label={t("mcp.copyDeviceCode")} onClick={(event) => { event.stopPropagation(); copyToClipboard(device.userCode); }}>{isDeviceCodeCopied ? t("mcp.deviceCodeCopied") : device.userCode}</button>}{authorization && <button type="button" className="settings-mcp-auth-link" onClick={(event) => { event.stopPropagation(); void openUrl(authorization.url); }}>{t("mcp.openLogin")}</button>}{device && <button type="button" className="settings-mcp-auth-link" onClick={(event) => { event.stopPropagation(); void openUrl(device.verificationUri); }}>{t("mcp.openLogin")}</button>}</div>
          {renderBadge(badge)}
          <button type="button" role="switch" aria-checked={enabled} aria-busy={connecting} aria-label={presetName(preset)} disabled={connecting && !server} className={cn("settings-switch", enabled && "is-on")} onClick={(event) => { event.stopPropagation(); togglePreset(preset, enabled); }}>
            <span />
          </button>
        </div>;
      })}</div>
      <div className="settings-mcp-list">{[...KEY_PRESETS, ...EMAIL_PRESETS].filter((preset) => { const q = query.trim().toLowerCase(); return !q || presetName(preset).toLowerCase().includes(q) || t(preset.descKey).toLowerCase().includes(q); }).map((preset) => {
        const isKeyPreset = KEY_PRESETS.some((item) => item.id === preset.id);
        // Email presets share one package, so only key presets may adopt a same-service server.
        const server = isKeyPreset ? presetServer(servers, preset) : servers.find((item) => item.id === preset.id);
        const connecting = connectingIds.includes(server?.id ?? preset.id) || pendingOn.has(server?.id ?? preset.id);
        const failed = Boolean(server && !server.disabled && !mcpAvailable(server) && !connecting);
        const enabled = connecting || mcpAvailable(server);
        const badge = statusBadge(server, connecting, failed);
        const subtitle = mcpAvailable(server) ? `${server?.toolCount ?? 0} ${t("mcp.tools")}` : t(preset.descKey);
        const LucideIcon = preset.lucide;
        const icon = <span className="settings-provider-icon" style={preset.badgeStyle}>
          {LucideIcon ? <LucideIcon size={16} /> : preset.mono ? <span className="settings-mcp-logo settings-mcp-logo-mono" aria-hidden="true" style={{ maskImage: `url("${preset.logo}")`, WebkitMaskImage: `url("${preset.logo}")` }} /> : <img className="settings-mcp-logo" src={preset.logo} alt="" aria-hidden="true" draggable={false} />}
        </span>;
        return <div className={cn("settings-mcp-card", "is-actionable", failed && "is-error")} key={preset.id} role="button" tabIndex={0} onClick={() => isKeyPreset ? openKeyActions(preset, icon, badge?.label ?? subtitle, failed) : openEmailActions(preset, icon, badge?.label ?? subtitle, failed)} onKeyDown={(event) => { if (event.key === "Enter") isKeyPreset ? openKeyActions(preset, icon, badge?.label ?? subtitle, failed) : openEmailActions(preset, icon, badge?.label ?? subtitle, failed); }}>
          {icon}
          <div><strong>{presetName(preset)}</strong><small className="settings-mcp-status"><span>{subtitle}</span></small></div>
          {renderBadge(badge)}
          <button type="button" role="switch" aria-checked={enabled} aria-busy={connecting} aria-label={presetName(preset)} disabled={connecting && !server} className={cn("settings-switch", enabled && "is-on")} onClick={(event) => { event.stopPropagation(); isKeyPreset ? toggleKeyPreset(preset, enabled) : toggleEmailPreset(preset, enabled); }}>
            <span />
          </button>
        </div>;
      })}</div>
      {customServers.length > 0 && <div className="settings-mcp-list">{customServers.filter((server) => { const q = query.trim().toLowerCase(); return !q || server.name.toLowerCase().includes(q) || (server.command ?? server.url ?? "").toLowerCase().includes(q); }).map((server) => {
        const connecting = connectingIds.includes(server.id) || pendingOn.has(server.id);
        const failed = Boolean(!server.disabled && !mcpAvailable(server) && !connecting);
        const enabled = connecting || mcpAvailable(server);
        const badge = statusBadge(server, connecting, failed);
        const target = [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") || server.url || "";
        const subtitle = mcpAvailable(server) ? `${server.toolCount ?? 0} ${t("mcp.tools")}` : target;
        return <div className={cn("settings-mcp-card", "is-actionable", failed && "is-error")} key={server.id} role="button" tabIndex={0} onClick={() => openCustomActions(server)} onKeyDown={(event) => { if (event.key === "Enter") openCustomActions(server); }}>
          {serverIcon(server)}
          <div><strong>{server.name}</strong><small className="settings-mcp-status"><span>{subtitle}</span></small></div>
          {renderBadge(badge)}
          <button type="button" role="switch" aria-checked={enabled} aria-busy={connecting} aria-label={server.name} disabled={connecting && !server} className={cn("settings-switch", enabled && "is-on")} onClick={(event) => { event.stopPropagation(); toggleCustom(server, enabled); }}>
            <span />
          </button>
        </div>;
      })}</div>}
      {addOpen && createPortal(
        <div className="settings-subdialog-layer" onClick={(event) => { if (!addSaving && event.target === event.currentTarget) setAddOpen(false); }}>
          <div className="settings-subdialog" role="dialog" aria-modal="true" aria-label={editing ? t("mcp.editService") : t("mcp.addService")}>
            <div className="settings-subdialog-header"><div><span>MCP</span><h3>{editing ? t("mcp.editService") : t("mcp.addService")}</h3></div><button type="button" className="settings-dialog-close" disabled={addSaving} onClick={() => setAddOpen(false)} aria-label={t("common.close")}><X size={17} /></button></div>
            {(!prefillId || editing) && (
              <div className="settings-theme-switch" role="tablist" style={{ marginBottom: 14 }}>
                <button type="button" role="tab" aria-selected={mode === "url"} className={cn(mode === "url" && "is-selected")} onClick={() => setMode("url")}>{t("mcp.modeRemote")}</button>
                <button type="button" role="tab" aria-selected={mode === "stdio"} className={cn(mode === "stdio" && "is-selected")} onClick={() => setMode("stdio")}>{t("mcp.modeCommand")}</button>
              </div>
            )}
            {mode === "url" ? (
              <div className="settings-form-grid">
                <label className="is-wide">{t("mcp.url")}<input autoFocus spellCheck={false} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label>
                <label className="is-wide">{t("mcp.apiKey")}<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editing?.headers && Object.keys(editing.headers).some((key) => key.toLowerCase() === "authorization") ? t("mcp.apiKeyKeep") : t("mcp.optional")} /></label>
                <label className="is-wide">{t("mcp.name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("mcp.nameAutoPlaceholder")} /></label>
              </div>
            ) : (
              <div className="settings-form-grid">
                <label className="is-wide">{t("mcp.name")}<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("mcp.namePlaceholder")} /></label>
                <label>{t("mcp.command")}<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></label>
                <label>{t("mcp.arguments")}<input value={args} onChange={(event) => setArgs(event.target.value)} placeholder={t("mcp.argumentsPlaceholder")} /></label>
                <label className="is-wide">{t("mcp.envVars")}<textarea rows={4} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={t("mcp.envVarsPlaceholder")} /></label>
              </div>
            )}
            <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" disabled={addSaving} onClick={() => setAddOpen(false)}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={!canSubmitManual || addSaving} onClick={() => void connect()}>{addSaving ? <LoaderCircle size={15} className="settings-spin" /> : <Plus size={15} />}{t("mcp.connect")}</button></div>
          </div>
        </div>,
        document.body,
      )}
      {githubLoginOpen && createPortal(
        <div className="settings-subdialog-layer" onClick={(event) => { if (!githubSaving && event.target === event.currentTarget) setGithubLoginOpen(false); }}><div className="settings-subdialog" role="dialog" aria-modal="true" aria-label={t("mcp.githubLoginTitle")}>
          <div className="settings-subdialog-header"><div><span>GitHub MCP</span><h3>{t("mcp.githubLoginTitle")}</h3></div><button type="button" className="settings-dialog-close" disabled={githubSaving} onClick={() => setGithubLoginOpen(false)} aria-label={t("common.close")}><X size={17} /></button></div>
          <p>{configuredGithubClientId ? t("mcp.githubOAuthConfigured") : t("mcp.githubLoginHelp")}</p>
          {!configuredGithubClientId && <div className="settings-form-grid"><label className="is-wide">{t("mcp.githubClientId")}<input value={githubClientId} onChange={(event) => setGithubClientId(event.target.value)} placeholder={t("mcp.required")} /></label></div>}
          <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" disabled={githubSaving} onClick={() => setGithubLoginOpen(false)}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={githubSaving || !githubClientId.trim()} onClick={() => void connectGitHub()}>{githubSaving && <LoaderCircle size={15} className="settings-spin" />}{t("mcp.githubSignIn")}</button></div>
        </div></div>,
        document.body,
      )}
      {keyDialog && createPortal(
        <div className="settings-subdialog-layer" onClick={(event) => { if (!keySaving && event.target === event.currentTarget) setKeyDialog(null); }}>
          <div className="settings-subdialog settings-mcp-action-dialog" role="dialog" aria-modal="true" aria-label={presetName(keyDialog.preset)}>
            <div className="settings-subdialog-header"><div><span>MCP</span><h3>{presetName(keyDialog.preset)}</h3></div><button type="button" className="settings-dialog-close" disabled={keySaving} onClick={() => setKeyDialog(null)} aria-label={t("common.close")}><X size={17} /></button></div>
            <div className="settings-form-grid">{keyDialog.fields.map((field, index) => <label key={field.key} className="is-wide">{field.key}<input type="password" autoComplete="off" autoFocus={index === 0} disabled={keySaving} value={field.value} onChange={(event) => setKeyDialog({ ...keyDialog, fields: keyDialog.fields.map((item, i) => i === index ? { ...item, value: event.target.value } : item) })} placeholder={t("mcp.pasteKey")} /></label>)}</div>
            <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" disabled={keySaving} onClick={() => setKeyDialog(null)}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={keySaving || keyDialog.fields.some((field) => !field.value.trim())} onClick={() => void submitKeyDialog()}>{keySaving && <LoaderCircle size={15} className="settings-spin" />}{t("mcp.connect")}</button></div>
          </div>
        </div>,
        document.body,
      )}
      {actionCard && createPortal(
        <div className="settings-subdialog-layer" onClick={(event) => { if (event.target === event.currentTarget) setActionCard(null); }}>
          <div className="settings-subdialog settings-mcp-action-dialog" role="dialog" aria-modal="true" aria-label={actionCard.name}>
            <div className="settings-subdialog-header"><div><span>MCP</span><h3>{actionCard.name}</h3></div><button type="button" className="settings-dialog-close" onClick={() => setActionCard(null)} aria-label={t("common.close")}><X size={17} /></button></div>
            <div className="settings-mcp-action-hero">{actionCard.icon}<div><strong>{actionCard.name}</strong><small className={cn("settings-mcp-status", actionCard.statusError && "is-error")} role="status"><span>{actionCard.status}</span></small></div></div>
            <div className="settings-mcp-actions">{actionCard.actions.map((action) => <button key={action.label} type="button" className={action.danger ? "settings-mcp-action-danger" : action.primary ? "settings-primary-action" : "settings-secondary-action"} onClick={() => void action.onClick()}>{action.label}</button>)}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}


