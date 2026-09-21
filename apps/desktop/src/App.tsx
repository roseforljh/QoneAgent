import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore, initBridge, type ToolCall } from "./store";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  useAuiState,
  CompositeAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  SimpleImageAttachmentAdapter,
  type AppendMessage,
  type ExternalStoreThreadData,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Thread } from "./components/assistant-ui/Thread";
import { ThreadListItems, ThreadListNew, ThreadListRoot } from "./components/assistant-ui/thread-list";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import { ApprovalCard, ToolCard } from "./components/tool-ui/ToolCard";
import TerminalView from "./TerminalView";
import { FolderPlus, Moon, PanelLeftIcon, PlusIcon, Settings, ShareIcon, Sun, Terminal, X } from "lucide-react";
import { cn } from "./lib/utils";
import qoneLogoUrl from "../src-tauri/icons/everytalk-logo.png";

type Theme = "light" | "dark";

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("qone-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => { document.documentElement.dataset.theme = theme; window.localStorage.setItem("qone-theme", theme); }, [theme]);
  return { theme, toggleTheme: () => setTheme((current) => current === "dark" ? "light" : "dark") };
}

function ThemeButton({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <TooltipIconButton
      tooltip={theme === "dark" ? "Light theme" : "Dark theme"}
      onClick={onToggle}
      className="size-8"
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </TooltipIconButton>
  );
}

const attachmentAdapter = new CompositeAttachmentAdapter([new SimpleTextAttachmentAdapter(), new SimpleImageAttachmentAdapter()]);

const extractText = (message: AppendMessage): string => {
  const partsText = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  const attachmentText = (message.attachments ?? [])
    .flatMap((attachment) => attachment.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  return [partsText, attachmentText].filter(Boolean).join("\n\n").trim();
};

function useQoneRuntime(pendingRun: { current: string | null }) {
  const messages = useStore((s) => s.messages);
  const streaming = useStore((s) => s.streaming);
  const running = useStore((s) => s.running);
  const sessions = useStore((s) => s.sessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const runAgent = useStore((s) => s.runAgent);
  const stopAgent = useStore((s) => s.stopAgent);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const send = useStore((s) => s.send);

  const runtimeMessages = streaming ? [...messages, { id: "streaming", role: "assistant", content: streaming }] : messages;

  const threads = useMemo<ExternalStoreThreadData<"regular">[]>(
    () => sessions.map((session) => ({
      id: session.id,
      title: session.title,
      status: "regular",
      // passed through to threadItems via the adapter's spread
      lastMessageAt: new Date(session.updatedAt),
    } as ExternalStoreThreadData<"regular">)),
    [sessions],
  );

  const threadList = useMemo<ExternalStoreThreadListAdapter>(() => ({
    threadId: currentSessionId,
    threads,
    onSwitchToNewThread: () => newSession(),
    onSwitchToThread: (threadId) => selectSession(threadId),
    onDelete: (threadId) => {
      send({ type: "session.delete", requestId: crypto.randomUUID(), sessionId: threadId });
      send({ type: "session.list", requestId: crypto.randomUUID() });
    },
  }), [threads, currentSessionId, newSession, selectSession, send]);

  return useExternalStoreRuntime({
    messages: runtimeMessages,
    isRunning: running,
    convertMessage: (message): ThreadMessageLike => ({
      id: message.id,
      role: message.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: message.content }],
    }),
    onNew: async (message) => {
      const text = extractText(message);
      if (!text) return;
      if (!useStore.getState().currentSessionId) {
        pendingRun.current = text;
        newSession();
        return;
      }
      runAgent(text);
    },
    onCancel: async () => stopAgent(),
    adapters: { threadList, attachments: attachmentAdapter },
  });
}

function Logo({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className={cn("flex items-center text-sm font-medium", collapsed ? "size-8 shrink-0 justify-center" : "min-w-0 gap-2 px-2")}>
      <img src={qoneLogoUrl} alt="logo" className="size-5 shrink-0 rounded dark:hue-rotate-180 dark:invert" />
      {!collapsed && <span className="text-foreground/90 truncate">Qone</span>}
    </div>
  );
}

function ThreadTitle() {
  const title = useAuiState((s) => s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId)?.title);
  return <span className="min-w-0 truncate text-sm font-medium">{title ?? "New Chat"}</span>;
}

function Header({ sidebarCollapsed, onToggleSidebar, theme, onToggleTheme }: { sidebarCollapsed: boolean; onToggleSidebar: () => void; theme: Theme; onToggleTheme: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-4">
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        side="bottom"
        onClick={onToggleSidebar}
        className="size-8"
      >
        <PanelLeftIcon className="size-4" />
      </TooltipIconButton>
      <ThreadTitle />
      <div className="ml-auto flex items-center gap-1">
        <TooltipIconButton variant="ghost" size="icon" tooltip="Share" side="bottom" disabled className="size-8">
          <ShareIcon className="size-4" />
        </TooltipIconButton>
        <ThemeButton theme={theme} onToggle={onToggleTheme} />
      </div>
    </header>
  );
}

function ToolCallList({ calls }: { calls: ToolCall[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: calls.length, getScrollElement: () => parentRef.current, estimateSize: () => 54, overscan: 5 });
  return <div ref={parentRef} className="tool-call-list"><div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>{virtualizer.getVirtualItems().map((item) => <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}><ToolCard call={calls[item.index]} /></div>)}</div></div>;
}

function ChatExtras() {
  const toolCalls = useStore((s) => s.toolCalls);
  const runs = useStore((s) => s.runs);
  const artifacts = useStore((s) => s.artifacts);
  const approvals = useStore((s) => s.approvals);
  const approve = useStore((s) => s.approve);
  const reject = useStore((s) => s.reject);
  return (
    <>
      {toolCalls.length > 0 && <ToolCallList calls={toolCalls} />}
      {runs.length > 0 && <details className="activity-section"><summary>运行记录 <span>{runs.length}</span></summary>{runs.map((run) => <div className="activity-row" key={run.id}><span>{run.status}</span>{run.error && <small> — {run.error}</small>}</div>)}</details>}
      {artifacts.length > 0 && <details className="activity-section"><summary>产物 <span>{artifacts.length}</span></summary>{artifacts.map((artifact) => <div className="activity-row" key={artifact.id}><span>{artifact.name}</span><small>{artifact.type}</small></div>)}</details>}
      {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onApprove={() => approve(approval.id)} onReject={() => reject(approval.id)} />)}
    </>
  );
}

function SidebarFooter() {
  const connected = useStore((s) => s.connected);
  const chooseWorkspace = useStore((s) => s.chooseWorkspace);
  const running = useStore((s) => s.running);
  const [showTerminal, setShowTerminal] = useState(false);
  const cwd = useStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId)?.path);
  return (
    <>
      <div className="mt-auto flex shrink-0 items-center gap-1 border-t border-border/50 px-2 py-2">
        <TooltipIconButton tooltip={connected ? "已连接" : "连接中…"} side="top" className="size-7 cursor-default hover:bg-transparent">
          <span className={cn("block size-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-muted-foreground")} />
        </TooltipIconButton>
        <TooltipIconButton tooltip="导入项目文件夹" side="top" onClick={chooseWorkspace} disabled={running} className="size-7">
          <FolderPlus className="size-4" />
        </TooltipIconButton>
        <TooltipIconButton tooltip="终端" side="top" onClick={() => setShowTerminal((v) => !v)} className="size-7">
          <Terminal className="size-4" />
        </TooltipIconButton>
        <Link to="/settings">
          <TooltipIconButton tooltip="设置" side="top" className="size-7">
            <Settings className="size-4" />
          </TooltipIconButton>
        </Link>
      </div>
      {showTerminal && (
        <div className="terminal-panel absolute bottom-10 left-0 z-20 w-full">
          <div className="terminal-panel-header"><span>终端</span><button className="icon-button" onClick={() => setShowTerminal(false)} aria-label="关闭终端"><X size={15} /></button></div>
          <TerminalView terminalId="main" cwd={cwd} />
        </div>
      )}
    </>
  );
}

function ChatPage({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const pendingRun = useRef<string | null>(null);
  const runtime = useQoneRuntime(pendingRun);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const lastError = useStore((s) => s.lastError);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const runAgent = useStore((s) => s.runAgent);

  useEffect(() => {
    if (currentSessionId && pendingRun.current) {
      const text = pendingRun.current;
      pendingRun.current = null;
      runAgent(text);
    }
  }, [currentSessionId, runAgent]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="relative flex h-full w-full overflow-hidden">
        <aside
          className={cn(
            "bg-muted/30 flex h-full shrink-0 flex-col overflow-hidden transition-[width] duration-200",
            sidebarCollapsed ? "w-12" : "w-65",
          )}
        >
          <div className="flex h-12 shrink-0 items-center overflow-hidden px-2">
            <Logo collapsed={sidebarCollapsed} />
          </div>
          <ThreadListRoot
            className={cn(
              "relative flex-1 transition-[padding,width] duration-200",
              sidebarCollapsed ? "w-12 overflow-hidden px-2 pt-1" : "w-65 overflow-y-auto p-3",
            )}
          >
            <ThreadListNew
              className={cn(
                "overflow-hidden transition-all duration-200",
                sidebarCollapsed ? "w-8 gap-0 px-2" : "w-full gap-2 px-2.5",
              )}
              labelClassName={cn("overflow-hidden transition-all duration-200", sidebarCollapsed ? "max-w-0 opacity-0" : "max-w-24 opacity-100")}
            />
            <ThreadListItems
              aria-hidden={sidebarCollapsed}
              inert={sidebarCollapsed}
              className={cn("transition-[opacity,transform] duration-150", sidebarCollapsed ? "pointer-events-none opacity-0" : "translate-x-0 opacity-100")}
            />
          </ThreadListRoot>
          {!sidebarCollapsed && <SidebarFooter />}
          {sidebarCollapsed && (
            <div className="mt-auto flex shrink-0 flex-col items-center gap-1 px-2 py-2">
              <Link to="/settings">
                <TooltipIconButton tooltip="设置" side="right" className="size-7">
                  <Settings className="size-4" />
                </TooltipIconButton>
              </Link>
            </div>
          )}
        </aside>

        <div className="bg-muted/30 flex h-full min-w-0 flex-1 flex-col overflow-hidden p-2 pl-0">
          <div className="bg-background flex flex-1 flex-col overflow-hidden rounded-lg">
            <Header sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)} theme={theme} onToggleTheme={onToggleTheme} />
            {lastError && (
              <div className="error-banner" role="alert">
                <span>{lastError}</span>
                <button className="icon-button" onClick={() => useStore.setState({ lastError: undefined })} aria-label="关闭错误"><X size={15} /></button>
              </div>
            )}
            <main className="flex-1 overflow-hidden flex flex-col">
              <div className="min-h-0 flex-1">
                <Thread />
              </div>
              <ChatExtras />
            </main>
          </div>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

function PageLayout({ title, theme, onToggleTheme, children }: { title: string; theme: Theme; onToggleTheme: () => void; children: ReactNode }) {
  return (
    <div className="page-shell">
      <header className="page-topbar">
        <Link className="brand-link" to="/"><img className="brand-mark" src={qoneLogoUrl} alt="" aria-hidden="true" /><span>Qone</span></Link>
        <div className="page-topbar-actions"><span className="page-title">{title}</span><ThemeButton theme={theme} onToggle={onToggleTheme} /></div>
      </header>
      <main className="page-content">{children}</main>
    </div>
  );
}

function SettingsPanel() {
  const { modelConfigs, send } = useStore();
  const [provider, setProvider] = useState(modelConfigs[0]?.provider ?? "openai");
  const [model, setModel] = useState(modelConfigs[0]?.model ?? "gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("");
  const [updateStatus, setUpdateStatus] = useState("");
  const { theme, toggleTheme } = useTheme();
  const checkForUpdates = async () => {
    setUpdateStatus("正在检查更新…");
    try {
      const update = await check({ timeout: 10_000 });
      if (!update) { setUpdateStatus("当前已是最新版本"); return; }
      setUpdateStatus(`发现 ${update.version}，正在下载并安装…`);
      await update.downloadAndInstall();
    } catch (error) { setUpdateStatus(`更新不可用：${String(error)}（请先配置签名公钥和 release endpoint）`); }
  };
  const save = async () => {
    if (!provider || !model) return;
    try {
      if (apiKey) {
        await invoke("secret_set", { key: `model.apiKey:${provider}`, value: apiKey });
        send({ type: "secret.set", requestId: crypto.randomUUID(), key: `model.apiKey:${provider}`, value: apiKey });
        setApiKey("");
      }
      send({ type: "model.upsert", requestId: crypto.randomUUID(), config: { id: `${provider}/${model}`, provider, model, config: {}, enabled: true, updatedAt: Date.now() } });
      setStatus("已保存到 Windows Credential Manager 与本地配置");
    } catch (error) { setStatus(`保存失败：${String(error)}`); }
  };
  return <PageLayout title="Settings" theme={theme} onToggleTheme={toggleTheme}>
    <div className="settings-panel"><div className="panel-intro"><span className="eyebrow">Configuration</span><h2>模型配置</h2><p>API Key 只写入 Windows Credential Manager；SQLite 只保存 Provider 和模型名称。</p></div><div className="form-grid"><label className="field">Provider<input value={provider} onChange={(e) => setProvider(e.target.value)} /></label><label className="field">Model<input value={model} onChange={(e) => setModel(e.target.value)} /></label><label className="field field-wide">API Key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="留空表示不修改" /></label></div><button className="primary-button" onClick={save}>保存模型配置</button>{status && <p className="inline-status">{status}</p>}</div>
    <div className="settings-panel settings-row-panel"><div><span className="eyebrow">Application</span><h2>应用更新</h2><p>检查 Qone 是否有新的桌面版本。</p></div><button className="secondary-button" onClick={checkForUpdates}><PlusIcon size={16} />检查更新</button>{updateStatus && <p className="inline-status">{updateStatus}</p>}</div>
    <div className="settings-panel"><span className="eyebrow">Models</span><h2>已配置模型</h2>{modelConfigs.length === 0 ? <p className="muted-copy">还没有配置模型。</p> : <div className="simple-list">{modelConfigs.map((config) => <div className="simple-list-row" key={config.id}><span>{config.provider}</span><strong>{config.model}</strong></div>)}</div>}</div>
  </PageLayout>;
}

function ManagementPanel({ kind }: { kind: "mcp" | "skills" | "plugins" | "permissions" }) {
  const { send, mcpServers, skills, plugins, workspaces, currentWorkspaceId, permissionRules, setPermission, oauthAuthorization, lastError } = useStore();
  const [name, setName] = useState(""); const [command, setCommand] = useState(""); const [url, setUrl] = useState(""); const [tokenEnv, setTokenEnv] = useState(""); const [args, setArgs] = useState("");
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState(""); const [oauthTokenUrl, setOauthTokenUrl] = useState(""); const [oauthClientId, setOauthClientId] = useState(""); const [oauthCode, setOauthCode] = useState("");
  const { theme, toggleTheme } = useTheme();
  useEffect(() => {
    if (kind === "mcp") send({ type: "mcp.list", requestId: crypto.randomUUID() });
    if (kind === "plugins") send({ type: "plugins.list", requestId: crypto.randomUUID() });
    if (kind === "skills") send({ type: "skills.list", requestId: crypto.randomUUID(), cwd: workspaces.find((w) => w.id === currentWorkspaceId)?.path });
    if (kind === "permissions") send({ type: "permission.list", requestId: crypto.randomUUID() });
  }, [kind, send, workspaces, currentWorkspaceId]);
  const connect = () => {
    if (!name || (!command && !url)) return;
    const id = name.toLowerCase().replace(/\s+/g, "-");
    send({ type: "mcp.connect", requestId: crypto.randomUUID(), config: { id, name, command: command || undefined, url: url || undefined, tokenEnv: tokenEnv || undefined, args: args.trim() ? args.trim().split(/\s+/) : [], oauth: oauthAuthorizationUrl && oauthTokenUrl && oauthClientId ? { authorizationUrl: oauthAuthorizationUrl, tokenUrl: oauthTokenUrl, clientId: oauthClientId, tokenSecretKey: `mcp.oauth:${id}` } : undefined } });
  };
  const titles = { mcp: "MCP Servers", skills: "Skills", plugins: "Plugins", permissions: "Permissions" };
  return <PageLayout title={titles[kind]} theme={theme} onToggleTheme={toggleTheme}>
    {lastError && <p className="error-banner" role="alert">{lastError}</p>}
    <div className="settings-panel">
      {kind === "mcp" && <><div className="panel-intro"><span className="eyebrow">Connections</span><h2>连接 MCP Server</h2><p>配置本地 stdio 或 Streamable HTTP 服务，启动 Qone 时会自动恢复。</p></div><div className="form-grid mcp-form"><label className="field">名称<input placeholder="我的工具" value={name} onChange={(e) => setName(e.target.value)} /></label><label className="field">命令<input placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} /></label><label className="field">参数<input placeholder="参数（空格分隔）" value={args} onChange={(e) => setArgs(e.target.value)} /></label><label className="field">HTTP URL<input placeholder="或 Streamable HTTP URL" value={url} onChange={(e) => setUrl(e.target.value)} /></label><label className="field">Token 环境变量<input placeholder="可选" value={tokenEnv} onChange={(e) => setTokenEnv(e.target.value)} /></label></div><div className="form-grid mcp-form"><label className="field">OAuth Authorization URL<input value={oauthAuthorizationUrl} onChange={(e) => setOauthAuthorizationUrl(e.target.value)} /></label><label className="field">OAuth Token URL<input value={oauthTokenUrl} onChange={(e) => setOauthTokenUrl(e.target.value)} /></label><label className="field">OAuth Client ID<input value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} /></label></div><button className="primary-button" onClick={connect}><PlusIcon size={16} />连接</button>{oauthAuthorization && <div className="oauth-banner">OAuth 已打开，请完成授权后粘贴 code：<input value={oauthCode} onChange={(e) => setOauthCode(e.target.value)} placeholder="authorization code" /><button className="secondary-button" onClick={() => send({ type: "mcp.oauth.complete", requestId: crypto.randomUUID(), serverId: oauthAuthorization.serverId, code: oauthCode, state: oauthAuthorization.state })}>完成 OAuth</button></div>}<div className="simple-list">{mcpServers.map((server) => <div className="simple-list-row" key={server.id}><div><strong>{server.name}</strong><small>{server.command ?? server.url}</small></div><span className="status-dot" /></div>)}</div></>}
      {kind === "skills" && <div className="simple-list">{skills.length === 0 ? <p className="muted-copy">没有发现 Skills。</p> : skills.map((skill) => <div className="simple-list-row stacked" key={skill.id}><strong>{skill.name}</strong><small>{skill.description}</small><code>{skill.path}</code></div>)}</div>}
      {kind === "plugins" && <><p className="muted-copy">插件代码只会在 Permissions 中明确允许 `plugin.load` 后加载。</p><div className="simple-list">{plugins.map((plugin) => <div className="simple-list-row stacked" key={plugin.id}><div><strong>{plugin.name}</strong><small>v{plugin.version} · {plugin.loaded ? `已加载 · ${plugin.toolCount} tools · ${plugin.skillCount} skills` : "未加载"}</small></div><span className="status-dot" /></div>)}</div></>}
      {kind === "permissions" && <div className="simple-list">{permissionRules.length === 0 ? <p className="muted-copy">暂无权限规则。</p> : permissionRules.map((rule) => <div className="simple-list-row" key={`${rule.subjectId}:${rule.permission}`}><div><strong>{rule.subjectId}</strong><small>{rule.permission}</small></div><select value={rule.decision} onChange={(e) => setPermission({ subjectId: rule.subjectId, permission: rule.permission, decision: e.target.value as "allow" | "ask" | "deny" })}><option value="allow">ALLOW</option><option value="ask">ASK</option><option value="deny">DENY</option></select></div>)}</div>}
    </div>
  </PageLayout>;
}

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const sessions = useStore((s) => s.sessions);
  const workspaces = useStore((s) => s.workspaces);
  const currentWorkspaceId = useStore((s) => s.currentWorkspaceId);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const running = useStore((s) => s.running);
  const selectSession = useStore((s) => s.selectSession);
  const refreshWorkspace = useStore((s) => s.refreshWorkspace);

  useEffect(() => { initBridge(); }, []);
  useEffect(() => {
    const sessionMatch = window.location.pathname.match(/^\/chat\/([^/]+)/); const workspaceMatch = window.location.pathname.match(/^\/workspaces\/([^/]+)/);
    if (sessionMatch) { const routeSessionId = decodeURIComponent(sessionMatch[1]); if (sessions.some((session) => session.id === routeSessionId) && currentSessionId !== routeSessionId) selectSession(routeSessionId); }
    if (workspaceMatch && !running) { const routeWorkspaceId = decodeURIComponent(workspaceMatch[1]); if (workspaces.some((workspace) => workspace.id === routeWorkspaceId) && currentWorkspaceId !== routeWorkspaceId) { useStore.setState({ currentWorkspaceId: routeWorkspaceId }); refreshWorkspace(routeWorkspaceId); } }
  }, [sessions, workspaces, currentSessionId, currentWorkspaceId, running, selectSession, refreshWorkspace]);

  if (window.location.pathname === "/settings") return <SettingsPanel />;
  if (["/mcp", "/skills", "/plugins", "/permissions"].includes(window.location.pathname)) return <ManagementPanel kind={window.location.pathname.slice(1) as "mcp" | "skills" | "plugins" | "permissions"} />;
  return <ChatPage theme={theme} onToggleTheme={toggleTheme} />;
}
