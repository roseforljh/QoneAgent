import { useEffect, useState, type ReactNode } from "react";
import { Command, LoaderCircle, Plus, Search, X } from "lucide-react";
import type { McpServerInfo } from "@qone/protocol";
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
import { EMAIL_PRESETS, KEY_PRESETS, MCP_PRESETS, configuredGithubClientId } from "./mcp-presets";

export function McpSection() {
  const { t } = useLocale();
  const { isCopied: isDeviceCodeCopied, copyToClipboard } = useCopyToClipboard();
  const send = useStore((state) => state.send);
  const servers = useStore((state) => state.mcpServers);
  const lastError = useStore((state) => state.lastError);
  const connectingIds = useStore((state) => state.mcpConnectingIds);
  const oauthAuthorization = useStore((state) => state.oauthAuthorization);
  const githubDeviceAuthorization = useStore((state) => state.githubDeviceAuthorization);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [args, setArgs] = useState("");
  const [tokenEnv, setTokenEnv] = useState("");
  const [envText, setEnvText] = useState("");
  const [prefillId, setPrefillId] = useState<string>();
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState("");
  const [oauthTokenUrl, setOauthTokenUrl] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [pendingOn, setPendingOn] = useState<ReadonlySet<string>>(new Set());
  // 卡片操作对话框：点卡片（开关以外区域）弹出，按钮按服务类型区分。
  const presetName = (preset: { name: string; nameKey?: MessageKey }) => preset.nameKey ? t(preset.nameKey) : preset.name;
  const [actionCard, setActionCard] = useState<{ name: string; icon: ReactNode; status: string; statusError?: boolean; actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] } | null>(null);
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
  const connectAsUser = async (config: { id: string; name: string; command?: string; url?: string; args?: string[]; tokenEnv?: string; env?: Record<string, string>; authMode?: "oauth" | "github-device"; oauthClientId?: string; oauth?: { authorizationUrl: string; tokenUrl: string; clientId: string; tokenSecretKey?: string } }) => {
    // Wait until the permission command has been written to the sidecar before
    // dispatching connect; otherwise the two Tauri invokes can arrive out of order.
    const allowed = await send({ type: "permission.set", requestId: crypto.randomUUID(), subjectId: `mcp:${config.id}`, permission: "mcp.connect", decision: "allow" });
    const sent = allowed && await send({ type: "mcp.connect", requestId: crypto.randomUUID(), config });
    if (!sent) setPendingOn((current) => { const next = new Set(current); next.delete(config.id); return next; });
    return Boolean(sent);
  };

  const deleteServer = async (server: { id: string; oauth?: { tokenSecretKey?: string }; env?: Record<string, string> }) => {
    try {
      if (hasDesktopBridge()) {
        const oauthKeys = [server.oauth?.tokenSecretKey ?? `mcp.oauth:${server.id}`, `mcp.oauth:${server.id}.client`, `mcp.oauth:${server.id}.tokens`];
        await Promise.all(oauthKeys.map((key) => invoke("secret_delete", { key }).catch(() => undefined)));
        const envKeys = Object.values(server.env ?? {}).filter((value) => value.startsWith("$mcp.env:")).map((value) => value.slice(1));
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
    if (pendingOn.has(preset.id) && !servers.some((server) => server.id === preset.id)) return;
    if (enabled) {
      const server = servers.find((item) => item.id === preset.id);
      if (server) void deleteServer(server);
      return;
    }
    if (preset.id === "mcp-github") { setGithubLoginOpen(true); return; }
    setPendingOn((current) => new Set(current).add(preset.id));
    void connectAsUser({ id: preset.id, name: presetName(preset), ...preset.config });
  };

  const openAdd = (preset?: { id: string; name: string; prefill: { command: string; args: string; env: string } }) => {
    setPrefillId(preset?.id);
    setName(preset?.name ?? "");
    setCommand(preset?.prefill.command ?? "");
    setUrl("");
    setArgs(preset?.prefill.args ?? "");
    setTokenEnv("");
    setEnvText(preset?.prefill.env ?? "");
    setOauthAuthorizationUrl(""); setOauthTokenUrl(""); setOauthClientId("");
    setAddOpen(true);
  };

  const openEdit = (server: (typeof servers)[number]) => {
    setPrefillId(server.id);
    setName(server.name);
    setCommand(server.command ?? "");
    setUrl(server.url ?? "");
    setArgs((server.args ?? []).join(" "));
    setTokenEnv(server.tokenEnv ?? "");
    setEnvText(Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"));
    setOauthAuthorizationUrl(server.oauth?.authorizationUrl ?? "");
    setOauthTokenUrl(server.oauth?.tokenUrl ?? "");
    setOauthClientId(server.oauth?.clientId ?? "");
    setAddOpen(true);
  };

  // 邮箱项需要凭证，开关 = 打开预填好的添加对话框；已添加的服务按预设 id 显示为开启。
  const toggleEmailPreset = (preset: { id: string; name: string; prefill: { command: string; args: string; env: string } }, enabled: boolean) => {
    if (enabled) {
      send({ type: "mcp.delete", requestId: crypto.randomUUID(), serverId: preset.id });
      return;
    }
    openAdd(preset);
  };

  const customServers = servers.filter((server) => !MCP_PRESETS.some((preset) => preset.id === server.id) && !EMAIL_PRESETS.some((preset) => preset.id === server.id) && !KEY_PRESETS.some((preset) => preset.id === server.id));

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
    setKeySaving(true);
    try {
      const env = Object.fromEntries(keyDialog.fields.map((field) => [field.key, `$mcp.env:${preset.id}/${field.key}`]));
      for (const field of keyDialog.fields) {
        const key = `mcp.env:${preset.id}/${field.key}`;
        await invoke("secret_set", { key, value: field.value.trim() });
        const sent = await send({ type: "secret.set", requestId: crypto.randomUUID(), key, value: field.value.trim() });
        if (!sent) throw new Error(t("error.mcpKeySendFailed"));
      }
      setPendingOn((current) => new Set(current).add(preset.id));
      if (await connectAsUser({ id: preset.id, name: presetName(preset), command: preset.prefill.command, args: preset.prefill.args.trim().split(/\s+/), env })) setKeyDialog(null);
    } catch (error) {
      useStore.setState({ lastError: localizeError(error) });
    } finally {
      setKeySaving(false);
    }
  };

  const toggleKeyPreset = (preset: (typeof KEY_PRESETS)[number], enabled: boolean) => {
    if (enabled) {
      const server = servers.find((item) => item.id === preset.id);
      if (server) void deleteServer(server);
      return;
    }
    openKeyDialog(preset);
  };

  const openKeyActions = (preset: (typeof KEY_PRESETS)[number], icon: ReactNode, status: string, statusError: boolean) => {
    const server = servers.find((item) => item.id === preset.id);
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = server
      ? [
          { label: t("mcp.reconnect"), primary: true, onClick: () => { setActionCard(null); setPendingOn((current) => new Set(current).add(preset.id)); void connectAsUser(server); } },
          { label: t("mcp.editKey"), onClick: () => { setActionCard(null); openKeyDialog(preset); } },
          { label: t("mcp.remove"), danger: true, onClick: () => { setActionCard(null); void deleteServer(server); } },
        ]
      : [{ label: t("mcp.fillKey"), primary: true, onClick: () => { setActionCard(null); openKeyDialog(preset); } }];
    setActionCard({ name: presetName(preset), icon, status, statusError, actions });
  };

  // 预设卡操作框：OAuth/GitHub 类出登录/退出登录，stdio 类出重连/移除。
  const openPresetActions = (preset: (typeof MCP_PRESETS)[number], icon: ReactNode, status: string, statusError: boolean) => {
    const server = servers.find((item) => item.id === preset.id);
    const isGithub = preset.id === "mcp-github";
    const isAccount = preset.config.authMode === "oauth" || isGithub;
    const needsUpgrade = Boolean(server && ((preset.config.authMode === "oauth" && (server.authMode !== "oauth" || server.url !== preset.config.url)) || (isGithub && server.tokenEnv === "GITHUB_TOKEN")));
    const startConnect = () => {
      setActionCard(null);
      if (isGithub) { setGithubLoginOpen(true); return; }
      setPendingOn((current) => new Set(current).add(preset.id));
      void connectAsUser({ id: preset.id, name: presetName(preset), ...preset.config });
    };
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = [{ label: needsUpgrade ? t("mcp.upgradeAccount") : server ? (isAccount ? t("mcp.relogin") : t("mcp.reconnect")) : (isAccount ? t("mcp.signIn") : t("mcp.connect")), primary: true, onClick: startConnect }];
    if (server) actions.push({ label: isAccount ? t("mcp.logout") : t("mcp.remove"), danger: true, onClick: () => { setActionCard(null); void deleteServer(server); } });
    setActionCard({ name: presetName(preset), icon, status, statusError, actions });
  };

  // 凭证类卡操作框：凭证即配置，所以给"修改账号配置"入口；已添加的再给重连和移除。
  const openEmailActions = (preset: { id: string; name: string; prefill: { command: string; args: string; env: string } }, icon: ReactNode, status: string, statusError: boolean) => {
    const server = servers.find((item) => item.id === preset.id);
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = server
      ? [
          { label: t("mcp.reconnect"), primary: true, onClick: () => { setActionCard(null); setPendingOn((current) => new Set(current).add(preset.id)); void connectAsUser(server); } },
          { label: t("mcp.editAccount"), onClick: () => { setActionCard(null); openAdd(preset); } },
          { label: t("mcp.remove"), danger: true, onClick: () => { setActionCard(null); void deleteServer(server); } },
        ]
      : [{ label: t("mcp.configureAccount"), primary: true, onClick: () => { setActionCard(null); openAdd(preset); } }];
    setActionCard({ name: presetName(preset), icon, status, statusError, actions });
  };

  // 自定义服务操作框：重连、OAuth 授权（如有）、删除。
  const openCustomActions = (server: (typeof servers)[number]) => {
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = [
      { label: t("mcp.reconnect"), primary: true, onClick: () => { setActionCard(null); void connectAsUser(server); } },
      { label: t("mcp.editService"), onClick: () => { setActionCard(null); openEdit(server); } },
      ...(server.oauth ? [{ label: t("mcp.authorize"), onClick: () => { setActionCard(null); void send({ type: "mcp.oauth.begin", requestId: crypto.randomUUID(), serverId: server.id }); } }] : []),
      { label: t("mcp.remove"), danger: true, onClick: async () => { if (!await confirmDestructiveAction(t("mcp.deleteConfirm", { name: server.name }))) return; setActionCard(null); await deleteServer(server); } },
    ];
    const connecting = connectingIds.includes(server.id);
    setActionCard({ name: server.name, icon: <span className="settings-provider-icon"><Command size={16} /></span>, status: connecting ? t("mcp.connectingStatus") : server.connected ? t("mcp.connectedStatus") : t("mcp.disconnectedStatus"), statusError: !connecting && !server.connected, actions });
  };

  const connect = () => {
    if (!name.trim() || (!command.trim() && !url.trim())) return;
    if (command.trim() && url.trim()) return;
    const id = name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || `mcp-${Date.now()}`;
    void connectAsUser({
      id: prefillId ?? id,
      name: name.trim(),
      command: command.trim() || undefined,
      url: url.trim() || undefined,
      tokenEnv: tokenEnv.trim() || undefined,
      args: args.trim() ? args.trim().split(/\s+/) : [],
      env: envText.trim() ? Object.fromEntries(envText.split("\n").map((line) => line.trim()).filter((line) => line && line.includes("=")).map((line) => { const i = line.indexOf("="); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; })) : undefined,
      oauth: oauthAuthorizationUrl.trim() && oauthTokenUrl.trim() && oauthClientId.trim() ? { authorizationUrl: oauthAuthorizationUrl.trim(), tokenUrl: oauthTokenUrl.trim(), clientId: oauthClientId.trim(), tokenSecretKey: `mcp.oauth:${id}` } : undefined,
    });
    setName(""); setCommand(""); setUrl(""); setArgs(""); setTokenEnv(""); setEnvText(""); setPrefillId(undefined); setOauthAuthorizationUrl(""); setOauthTokenUrl(""); setOauthClientId("");
  };

  return (
    <>
      <SettingsPageHeader>
        <SectionHeader eyebrow={t("mcp.eyebrow")} title={t("mcp.title")} />
        {lastError === t("mcp.nodeRequired") && <div className="error-banner" role="alert">
        <span>{lastError}</span>
        <div className="settings-toolbar-actions">
          <button type="button" className="settings-secondary-action" onClick={() => void openUrl("https://nodejs.org/en/download")}>{t("mcp.downloadNode")}</button>
          <button type="button" className="icon-button" aria-label={t("common.close")} onClick={() => useStore.setState({ lastError: undefined })}><X size={15} /></button>
        </div>
        </div>}
        <div className="settings-section-toolbar"><div><strong>{t("mcp.addService")}</strong><span>{t("mcp.addDescription")}</span></div><div className="settings-toolbar-actions"><label className="settings-search"><Search size={13} /><input type="search" placeholder={t("common.search")} value={query} onChange={(event) => setQuery(event.target.value)} /></label><button type="button" className="settings-primary-action" onClick={() => openAdd()}><Plus size={15} />{t("mcp.add")}</button></div></div>
      </SettingsPageHeader>
      <div className="settings-mcp-list">{MCP_PRESETS.filter((preset) => { const q = query.trim().toLowerCase(); return !q || presetName(preset).toLowerCase().includes(q) || t(preset.descKey).toLowerCase().includes(q); }).map((preset) => {
        const server = servers.find((item) => item.id === preset.id);
        const connecting = pendingOn.has(preset.id) || connectingIds.includes(preset.id);
        // 已配置但掉线（登录态丢失/连接失败）：开关回落为关 + 卡片爆红提示，点开=重连。
        const failed = Boolean(server && !server.connected && !connecting);
        const enabled = connecting || Boolean(server?.connected);
        const authorization = oauthAuthorization?.serverId === preset.id ? oauthAuthorization : undefined;
        const device = githubDeviceAuthorization?.serverId === preset.id ? githubDeviceAuthorization : undefined;
        const detail = connecting
          ? authorization ? t("mcp.waitingForLogin") : device ? t("mcp.githubCode", { code: device.userCode }) : t("mcp.connectingStatus")
          : server?.connected
            ? `${server.toolCount ?? 0} ${t("mcp.tools")} · ${t("mcp.connectedStatus")}`
            : server ? t("mcp.disconnectedStatus") : t(preset.descKey);
        const icon = <span className="settings-provider-icon" style={preset.lightBadge ? { background: "#fff", color: "#0f0f0f" } : undefined}>
          {preset.mono ? <span className="settings-mcp-logo settings-mcp-logo-mono" aria-hidden="true" style={{ maskImage: `url("${preset.logo}")`, WebkitMaskImage: `url("${preset.logo}")` }} /> : <img className="settings-mcp-logo" src={preset.logo} alt="" aria-hidden="true" draggable={false} />}
        </span>;
        return <div className={cn("settings-mcp-card", "is-actionable", failed && "is-error")} key={preset.id} role="button" tabIndex={0} onClick={() => openPresetActions(preset, icon, detail, failed)} onKeyDown={(event) => { if (event.key === "Enter") openPresetActions(preset, icon, detail, failed); }}>
          {icon}
          <div><strong>{presetName(preset)}</strong><small className="settings-mcp-status" role="status">{connecting && <LoaderCircle size={13} className="settings-spin" aria-hidden="true" />}<span>{detail}</span></small>{device && <button type="button" className="settings-mcp-device-code" title={t("mcp.copyDeviceCode")} aria-label={t("mcp.copyDeviceCode")} onClick={(event) => { event.stopPropagation(); copyToClipboard(device.userCode); }}>{isDeviceCodeCopied ? t("mcp.deviceCodeCopied") : device.userCode}</button>}{authorization && <button type="button" className="settings-mcp-auth-link" onClick={(event) => { event.stopPropagation(); void openUrl(authorization.url); }}>{t("mcp.openLogin")}</button>}{device && <button type="button" className="settings-mcp-auth-link" onClick={(event) => { event.stopPropagation(); void openUrl(device.verificationUri); }}>{t("mcp.openLogin")}</button>}</div>
          <button type="button" role="switch" aria-checked={enabled} aria-busy={connecting} aria-label={presetName(preset)} disabled={connecting && !authorization && !device} className={cn("settings-switch", enabled && "is-on")} onClick={(event) => { event.stopPropagation(); togglePreset(preset, enabled); }}>
            <span />
          </button>
        </div>;
      })}</div>
      <div className="settings-mcp-list">{[...KEY_PRESETS, ...EMAIL_PRESETS].filter((preset) => { const q = query.trim().toLowerCase(); return !q || presetName(preset).toLowerCase().includes(q) || t(preset.descKey).toLowerCase().includes(q); }).map((preset) => {
        const server = servers.find((item) => item.id === preset.id);
        const connecting = connectingIds.includes(preset.id) || pendingOn.has(preset.id);
        const failed = Boolean(server && !server.connected && !connecting);
        const enabled = connecting || Boolean(server?.connected);
        const detail = connecting
          ? t("mcp.connectingStatus")
          : server?.connected
            ? `${server.toolCount ?? 0} ${t("mcp.tools")} · ${t("mcp.connectedStatus")}`
            : server ? t("mcp.disconnectedStatus") : t(preset.descKey);
        const LucideIcon = preset.lucide;
        const icon = <span className="settings-provider-icon" style={preset.badgeStyle}>
          {LucideIcon ? <LucideIcon size={16} /> : preset.mono ? <span className="settings-mcp-logo settings-mcp-logo-mono" aria-hidden="true" style={{ maskImage: `url("${preset.logo}")`, WebkitMaskImage: `url("${preset.logo}")` }} /> : <img className="settings-mcp-logo" src={preset.logo} alt="" aria-hidden="true" draggable={false} />}
        </span>;
        const isKeyPreset = KEY_PRESETS.some((item) => item.id === preset.id);
        return <div className={cn("settings-mcp-card", "is-actionable", failed && "is-error")} key={preset.id} role="button" tabIndex={0} onClick={() => isKeyPreset ? openKeyActions(preset, icon, detail, failed) : openEmailActions(preset, icon, detail, failed)} onKeyDown={(event) => { if (event.key === "Enter") isKeyPreset ? openKeyActions(preset, icon, detail, failed) : openEmailActions(preset, icon, detail, failed); }}>
          {icon}
          <div><strong>{presetName(preset)}</strong><small className="settings-mcp-status" role="status">{connecting && <LoaderCircle size={13} className="settings-spin" aria-hidden="true" />}<span>{detail}</span></small></div>
          <button type="button" role="switch" aria-checked={enabled} aria-busy={connecting} aria-label={presetName(preset)} disabled={connecting} className={cn("settings-switch", enabled && "is-on")} onClick={(event) => { event.stopPropagation(); isKeyPreset ? toggleKeyPreset(preset, enabled) : toggleEmailPreset(preset, enabled); }}>
            <span />
          </button>
        </div>;
      })}</div>
      {customServers.length > 0 && <div className="settings-mcp-list">{customServers.filter((server) => { const q = query.trim().toLowerCase(); return !q || server.name.toLowerCase().includes(q) || (server.command ?? server.url ?? "").toLowerCase().includes(q); }).map((server) => {
        const connecting = connectingIds.includes(server.id);
        const status = connecting ? t("mcp.connectingStatus") : server.connected ? `${server.toolCount ?? 0} ${t("mcp.tools")}` : t("mcp.disconnectedStatus");
        return <div className="settings-mcp-card is-actionable" key={server.id} role="button" tabIndex={0} onClick={() => openCustomActions(server)} onKeyDown={(event) => { if (event.key === "Enter") openCustomActions(server); }}>
          <span className="settings-provider-icon"><Command size={16} /></span>
          <div><strong>{server.name}</strong><small className="settings-mcp-status" role="status">{connecting && <LoaderCircle size={13} className="settings-spin" aria-hidden="true" />}<span>{server.command ?? server.url} · {status}</span></small></div>
          <em className={server.connected ? "is-connected" : "is-disconnected"}>{connecting ? t("mcp.connectingStatus") : server.connected ? t("mcp.connectedStatus") : t("mcp.disconnectedStatus")}</em>
        </div>;
      })}</div>}
      {addOpen && (
        <div className="settings-subdialog-layer">
          <div className="settings-subdialog" role="dialog" aria-modal="true" aria-label={t("mcp.addService")}>
            <div className="settings-subdialog-header"><div><span>MCP</span><h3>{t("mcp.addService")}</h3></div><button type="button" className="settings-dialog-close" onClick={() => setAddOpen(false)} aria-label={t("common.close")}><X size={17} /></button></div>
            <div className="settings-form-grid"><label className="is-wide">{t("mcp.name")}<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("mcp.namePlaceholder")} /></label><label>{t("mcp.command")}<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></label><label>{t("mcp.arguments")}<input value={args} onChange={(event) => setArgs(event.target.value)} placeholder={t("mcp.argumentsPlaceholder")} /></label><label className="is-wide">{t("mcp.httpUrl")}<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label><label>{t("mcp.tokenEnv")}<input value={tokenEnv} onChange={(event) => setTokenEnv(event.target.value)} placeholder={t("mcp.optional")} /></label><label className="is-wide">{t("mcp.envVars")}<textarea rows={4} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={t("mcp.envVarsPlaceholder")} /></label></div>
            <div className="settings-form-grid"><label>{t("mcp.oauthAuthorization")}<input value={oauthAuthorizationUrl} onChange={(event) => setOauthAuthorizationUrl(event.target.value)} placeholder={t("mcp.optional")} /></label><label>{t("mcp.oauthToken")}<input value={oauthTokenUrl} onChange={(event) => setOauthTokenUrl(event.target.value)} placeholder={t("mcp.optional")} /></label><label>{t("mcp.oauthClient")}<input value={oauthClientId} onChange={(event) => setOauthClientId(event.target.value)} placeholder={t("mcp.optional")} /></label></div>
            <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" onClick={() => setAddOpen(false)}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={!name.trim() || (!command.trim() && !url.trim()) || Boolean(command.trim() && url.trim())} onClick={() => { connect(); setAddOpen(false); }}><Plus size={15} />{t("mcp.connect")}</button></div>
          </div>
        </div>
      )}
      {githubLoginOpen && <div className="settings-subdialog-layer"><div className="settings-subdialog" role="dialog" aria-modal="true" aria-label={t("mcp.githubLoginTitle")}>
        <div className="settings-subdialog-header"><div><span>GitHub MCP</span><h3>{t("mcp.githubLoginTitle")}</h3></div><button type="button" className="settings-dialog-close" onClick={() => setGithubLoginOpen(false)} aria-label={t("common.close")}><X size={17} /></button></div>
        <p>{configuredGithubClientId ? t("mcp.githubOAuthConfigured") : t("mcp.githubLoginHelp")}</p>
        {!configuredGithubClientId && <div className="settings-form-grid"><label className="is-wide">{t("mcp.githubClientId")}<input value={githubClientId} onChange={(event) => setGithubClientId(event.target.value)} placeholder={t("mcp.required")} /></label></div>}
        <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" disabled={githubSaving} onClick={() => setGithubLoginOpen(false)}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={githubSaving || !githubClientId.trim()} onClick={() => void connectGitHub()}>{githubSaving && <LoaderCircle size={15} className="settings-spin" />}{t("mcp.githubSignIn")}</button></div>
      </div></div>}
      {keyDialog && (
        <div className="settings-subdialog-layer" onClick={(event) => { if (!keySaving && event.target === event.currentTarget) setKeyDialog(null); }}>
          <div className="settings-subdialog settings-mcp-action-dialog" role="dialog" aria-modal="true" aria-label={presetName(keyDialog.preset)}>
            <div className="settings-subdialog-header"><div><span>MCP</span><h3>{presetName(keyDialog.preset)}</h3></div><button type="button" className="settings-dialog-close" disabled={keySaving} onClick={() => setKeyDialog(null)} aria-label={t("common.close")}><X size={17} /></button></div>
            <div className="settings-form-grid">{keyDialog.fields.map((field, index) => <label key={field.key} className="is-wide">{field.key}<input type="password" autoComplete="off" autoFocus={index === 0} disabled={keySaving} value={field.value} onChange={(event) => setKeyDialog({ ...keyDialog, fields: keyDialog.fields.map((item, i) => i === index ? { ...item, value: event.target.value } : item) })} placeholder={t("mcp.pasteKey")} /></label>)}</div>
            <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" disabled={keySaving} onClick={() => setKeyDialog(null)}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={keySaving || keyDialog.fields.some((field) => !field.value.trim())} onClick={() => void submitKeyDialog()}>{keySaving && <LoaderCircle size={15} className="settings-spin" />}{t("mcp.connect")}</button></div>
          </div>
        </div>
      )}
      {actionCard && (
        <div className="settings-subdialog-layer" onClick={(event) => { if (event.target === event.currentTarget) setActionCard(null); }}>
          <div className="settings-subdialog settings-mcp-action-dialog" role="dialog" aria-modal="true" aria-label={actionCard.name}>
            <div className="settings-subdialog-header"><div><span>MCP</span><h3>{actionCard.name}</h3></div><button type="button" className="settings-dialog-close" onClick={() => setActionCard(null)} aria-label={t("common.close")}><X size={17} /></button></div>
            <div className="settings-mcp-action-hero">{actionCard.icon}<div><strong>{actionCard.name}</strong><small className={cn("settings-mcp-status", actionCard.statusError && "is-error")} role="status"><span>{actionCard.status}</span></small></div></div>
            <div className="settings-mcp-actions">{actionCard.actions.map((action) => <button key={action.label} type="button" className={action.danger ? "settings-mcp-action-danger" : action.primary ? "settings-primary-action" : "settings-secondary-action"} onClick={() => void action.onClick()}>{action.label}</button>)}</div>
          </div>
        </div>
      )}
    </>
  );
}


