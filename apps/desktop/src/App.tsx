import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore, initBridge, type ToolCall } from "./store";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
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
import { ProjectSection } from "./components/assistant-ui/project-section";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import { ApprovalCard, ToolCard } from "./components/tool-ui/ToolCard";
import { Moon, PanelLeftIcon, PlusIcon, Settings, Sun, X } from "lucide-react";
import { cn } from "./lib/utils";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { QoneSelect } from "./components/ui/Select";
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

function Logo() {
  return (
    <span className="ml-2 flex min-w-0 items-center gap-2 truncate text-[15px] font-semibold">
      <img src={qoneLogoUrl} alt="logo" className="size-5 shrink-0 rounded dark:hue-rotate-180 dark:invert" />
      <span className="text-foreground truncate">Qone</span>
    </span>
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

function SidebarFooter({ collapsed, onOpenSettings }: { collapsed: boolean; onOpenSettings: () => void }) {
  return (
    <div className="mt-auto shrink-0 border-t border-border/50 p-2">
      <button
        type="button"
        onClick={onOpenSettings}
        className={cn(
          "q-sidebar-settings hover:bg-muted text-foreground/90 hover:text-foreground flex h-8 cursor-pointer items-center gap-2 rounded-md transition-colors",
          collapsed ? "w-8 justify-center px-0" : "w-full px-2",
        )}
      >
        <Settings className="size-3.5 shrink-0" />
        <span className={cn("overflow-hidden whitespace-nowrap transition-[max-width] duration-200", collapsed ? "max-w-0" : "max-w-24")}>设置</span>
      </button>
    </div>
  );
}

function ChatPage({ theme, onToggleTheme, initialSettingsOpen = false }: { theme: Theme; onToggleTheme: () => void; initialSettingsOpen?: boolean }) {
  const pendingRun = useRef<string | null>(null);
  const runtime = useQoneRuntime(pendingRun);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
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
            "q-sidebar bg-muted/30 flex h-full shrink-0 flex-col overflow-hidden border-r border-border/50 transition-[width] duration-200",
            sidebarCollapsed ? "w-12" : "w-65",
          )}
        >
          <div className="flex h-12 shrink-0 items-center overflow-hidden px-2">
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              side="right"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="size-8 shrink-0"
            >
              <PanelLeftIcon className="size-4" />
            </TooltipIconButton>
            {!sidebarCollapsed && <Logo />}
          </div>
          <ThreadListRoot
            className={cn(
              "relative flex-1 overflow-x-hidden transition-[padding,width] duration-200",
              sidebarCollapsed ? "w-12 overflow-hidden px-2 pt-1" : "w-65 overflow-y-auto p-3",
            )}
          >
            <ThreadListNew
              className={cn(
                "overflow-hidden transition-all duration-200",
                sidebarCollapsed ? "w-8 gap-0 px-2" : "w-full gap-2 px-2.5",
              )}
              labelClassName={cn("overflow-hidden whitespace-nowrap transition-[max-width] duration-200", sidebarCollapsed ? "max-w-0" : "max-w-24")}
            />
            <div
              aria-hidden={sidebarCollapsed}
              inert={sidebarCollapsed}
              className={cn("transition-opacity duration-150", sidebarCollapsed && "pointer-events-none opacity-0")}
            >
              <ProjectSection />
            </div>
            <ThreadListItems
              aria-hidden={sidebarCollapsed}
              inert={sidebarCollapsed}
              className={cn("transition-opacity duration-150", sidebarCollapsed && "pointer-events-none opacity-0")}
            />
          </ThreadListRoot>
          <SidebarFooter collapsed={sidebarCollapsed} onOpenSettings={() => setSettingsOpen(true)} />
        </aside>

        <div className="relative min-w-0 flex-1 overflow-hidden bg-white dark:bg-black">
          {lastError && (
            <div className="error-banner absolute inset-x-4 top-3 z-20" role="alert">
              <span>{lastError}</span>
              <button className="icon-button" onClick={() => useStore.setState({ lastError: undefined })} aria-label="关闭错误"><X size={15} /></button>
            </div>
          )}
          <Thread />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center px-4 pb-3">
            <div className="pointer-events-auto w-full max-w-3xl">
              <ChatExtras />
            </div>
          </div>
        </div>
        <SettingsDialog open={settingsOpen} onClose={closeSettings} theme={theme} onToggleTheme={onToggleTheme} />
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
      {kind === "permissions" && <div className="simple-list">{permissionRules.length === 0 ? <p className="muted-copy">暂无权限规则。</p> : permissionRules.map((rule) => <div className="simple-list-row" key={`${rule.subjectId}:${rule.permission}`}><div><strong>{rule.subjectId}</strong><small>{rule.permission}</small></div><QoneSelect value={rule.decision} onChange={(value) => setPermission({ subjectId: rule.subjectId, permission: rule.permission, decision: value as "allow" | "ask" | "deny" })} options={[{ value: "allow", label: "ALLOW" }, { value: "ask", label: "ASK" }, { value: "deny", label: "DENY" }]} ariaLabel={`${rule.subjectId} 权限`} triggerClassName="qone-select-trigger-compact" /></div>)}</div>}
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

  if (["/mcp", "/skills", "/plugins", "/permissions"].includes(window.location.pathname)) return <ManagementPanel kind={window.location.pathname.slice(1) as "mcp" | "skills" | "plugins" | "permissions"} />;
  return <ChatPage theme={theme} onToggleTheme={toggleTheme} initialSettingsOpen={window.location.pathname === "/settings"} />;
}
