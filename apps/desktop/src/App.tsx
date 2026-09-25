import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore, initBridge, type ToolCall } from "./store";
import { reportStartup } from "./lib/startup-diagnostic";
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
import type { MessageAttachmentInfo, PluginInfo } from "@qone/protocol";
import { assistantMessageContent } from "./lib/assistant-message-parts";
import { serializeMessageAttachments } from "./lib/message-attachments";
import { AnyFileAttachmentAdapter } from "./lib/file-attachment-adapter";
import { ThreadListItems, ThreadListNew, ThreadListRoot } from "./components/assistant-ui/thread-list";
import { WorkspaceDock } from "./components/assistant-ui/workspace-dock";
import { ProjectSection } from "./components/assistant-ui/project-section";
import { ConversationLoadingSkeleton, ComposerLoadingSkeleton, SidebarLoadingSkeleton } from "./components/assistant-ui/loading-skeleton";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { Link, useLocation } from "@tanstack/react-router";
import { ApprovalCard } from "./components/tool-ui/ToolCard";
import { ArrowLeft, Moon, PanelLeftIcon, PuzzleIcon, Settings, Sun, X } from "lucide-react";
import { cn } from "./lib/utils";
import { ConfirmationDialogHost } from "./components/ui/ConfirmationDialog";
import { confirmDestructiveAction } from "./lib/confirm-action";
import { useLocale } from "./localization";
import { QoneSelect } from "./components/ui/Select";
import { sortSidebarSessions, useSidebarPreferences } from "./lib/sidebar-preferences";
import qonePenguinUrl from "./assets/qone-penguin.png";
import { BrowserIntegration } from "./components/browser/BrowserIntegration";
import { ReachChannels } from "./components/reach/ReachChannels";

type Theme = "light" | "dark";

const Thread = lazy(async () => ({ default: (await import("./components/assistant-ui/Thread")).Thread }));
const SettingsDialog = lazy(async () => ({ default: (await import("./components/settings/SettingsDialog")).SettingsDialog }));

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

const attachmentAdapter = new CompositeAttachmentAdapter([
  new SimpleTextAttachmentAdapter(),
  new SimpleImageAttachmentAdapter(),
  new AnyFileAttachmentAdapter(),
]);

const extractText = (message: AppendMessage): string => {
  const partsText = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  return partsText.trim();
};

function useQoneRuntime(pendingRun: { current: { text: string; attachments: MessageAttachmentInfo[] } | null }) {
  const { t } = useLocale();
  const messages = useStore((s) => s.messages);
  const streaming = useStore((s) => s.streaming);
  const streamingParts = useStore((s) => s.streamingParts);
  const running = useStore((s) => s.running);
  const activeRunId = useStore((s) => s.activeRunId);
  const toolCalls = useStore((s) => s.toolCalls);
  const sessions = useStore((s) => s.sessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const runAgent = useStore((s) => s.runAgent);
  const stopAgent = useStore((s) => s.stopAgent);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const send = useStore((s) => s.send);
  const sidebarPreferences = useSidebarPreferences();

  const hasStreamingAssistant = running;
  const runtimeMessages = useMemo(
    () => hasStreamingAssistant
      ? [...messages, { id: "streaming", role: "assistant", content: streaming, parts: streamingParts.length ? streamingParts : undefined, runId: activeRunId, createdAt: messages.at(-1)?.createdAt ?? Date.now() }]
      : messages,
    [messages, streaming, streamingParts, activeRunId, hasStreamingAssistant],
  );
  const toolCallsByRun = useMemo(() => {
    const grouped = new Map<string, ToolCall[]>();
    for (const call of toolCalls) {
      const current = grouped.get(call.runId) ?? [];
      current.push(call);
      grouped.set(call.runId, current);
    }
    return grouped;
  }, [toolCalls]);

  const threads = useMemo<ExternalStoreThreadData<"regular">[]>(
    () => sortSidebarSessions(sessions, {
      ...sidebarPreferences,
      priorityIds: sidebarPreferences.priorityIds.length ? sidebarPreferences.priorityIds : currentSessionId ? [currentSessionId] : [],
    }).map((session) => ({
      id: session.id,
      title: session.title,
      status: "regular",
      // passed through to threadItems via the adapter's spread
      lastMessageAt: new Date(session.updatedAt),
    } as ExternalStoreThreadData<"regular">)),
    [sessions, sidebarPreferences, currentSessionId],
  );

  const threadList = useMemo<ExternalStoreThreadListAdapter>(() => ({
    threadId: currentSessionId,
    threads,
    onSwitchToNewThread: () => newSession(),
    onSwitchToThread: (threadId) => selectSession(threadId),
    onDelete: async (threadId) => {
      const title = sessions.find((session) => session.id === threadId)?.title ?? t("sidebar.newChat");
      if (!await confirmDestructiveAction(t("session.deleteConfirm", { title }))) return;
      send({ type: "session.delete", requestId: crypto.randomUUID(), sessionId: threadId });
      send({ type: "session.list", requestId: crypto.randomUUID() });
    },
  }), [threads, currentSessionId, newSession, selectSession, send, sessions, t]);

  return useExternalStoreRuntime({
    messages: runtimeMessages,
    isRunning: running,
    convertMessage: (message): ThreadMessageLike => {
      const role = message.role === "assistant" ? "assistant" : "user";
      const createdAt = new Date(message.createdAt ?? Date.now());
      if (role === "user") return {
        id: message.id,
        role,
        createdAt,
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...(message.attachments ?? []).map((attachment) => attachment.type === "image"
            ? { type: "image" as const, image: attachment.data, filename: attachment.name }
            : { type: "file" as const, filename: attachment.name, mimeType: attachment.mimeType, data: attachment.data }),
        ],
      };

      const isStreamingMessage = message.id === "streaming";
      const calls = !message.parts && message.runId ? (toolCallsByRun.get(message.runId) ?? []) : [];
      const content = assistantMessageContent(message, calls, isStreamingMessage);
      return {
        id: message.id,
        role,
        createdAt,
        content,
        status: isStreamingMessage && running ? { type: "running" } : { type: "complete", reason: "stop" },
      };
    },
    onNew: async (message) => {
      const text = extractText(message);
      let attachments: MessageAttachmentInfo[];
      try { attachments = await serializeMessageAttachments(message); }
      catch (error) { useStore.setState({ lastError: String(error) }); throw error; }
      if (!text && attachments.length === 0) return;
      const state = useStore.getState();
      if (!state.currentSessionId && state.draftWorkspaceId) {
        runAgent(text, undefined, attachments);
        return;
      }
      if (!state.currentSessionId) {
        if (!state.currentWorkspaceId || !state.workspaces.some((workspace) => workspace.id === state.currentWorkspaceId)) {
          useStore.setState({ lastError: "请先导入项目，再发送消息。" });
          return;
        }
        pendingRun.current = { text, attachments };
        newSession();
        return;
      }
      runAgent(text, undefined, attachments);
    },
    onReload: async (parentId) => {
      if (!parentId) return;
      const source = useStore.getState().messages.find((message) => message.id === parentId && message.role === "user");
      if (source) runAgent(source.content, source.id, source.attachments);
    },
    onCancel: async () => stopAgent(),
    adapters: { threadList, attachments: attachmentAdapter },
  });
}

function Logo() {
  return (
    <Link
      to="/"
      aria-label="返回主页面"
      className="ml-2 flex min-w-0 items-center gap-2 truncate text-[15px] font-semibold transition-opacity hover:opacity-80"
    >
      <img src={qonePenguinUrl} alt="" aria-hidden="true" className="qone-logo size-5 shrink-0" />
      <span className="text-foreground truncate">Qone</span>
    </Link>
  );
}

function ThreadLoadingFallback() {
  return (
    <div className="flex h-full flex-col bg-background" aria-busy="true" aria-label="正在加载聊天界面">
      <ConversationLoadingSkeleton />
      <div className="mx-auto w-full max-w-2xl px-4 pb-2">
        <ComposerLoadingSkeleton />
      </div>
    </div>
  );
}

function PendingApprovals() {
  const approvals = useStore((s) => s.approvals);
  const approve = useStore((s) => s.approve);
  const reject = useStore((s) => s.reject);
  return (
    <>
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
  const pendingRun = useRef<{ text: string; attachments: MessageAttachmentInfo[] } | null>(null);
  const runtime = useQoneRuntime(pendingRun);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener("qone-open-settings", openSettings);
    return () => window.removeEventListener("qone-open-settings", openSettings);
  }, []);
  const lastError = useStore((s) => s.lastError);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const runAgent = useStore((s) => s.runAgent);
  const sidebarLayout = useSidebarPreferences((s) => s.layout);
  const sessionsLoaded = useStore((s) => s.sessionsLoaded);
  const workspacesLoaded = useStore((s) => s.workspacesLoaded);

  useEffect(() => {
    if (currentSessionId && pendingRun.current) {
      const { text, attachments } = pendingRun.current;
      pendingRun.current = null;
      runAgent(text, undefined, attachments);
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
              sidebarCollapsed ? "w-12 overflow-hidden px-2 pt-1" : "w-65 overflow-y-auto [scrollbar-gutter:stable] p-3",
            )}
          >
            <ThreadListNew
              className={cn(
                "overflow-hidden transition-all duration-200",
                sidebarCollapsed ? "w-8 gap-0 px-2" : "w-full gap-2 px-2.5",
              )}
              labelClassName={cn("overflow-hidden whitespace-nowrap transition-[max-width] duration-200", sidebarCollapsed ? "max-w-0" : "max-w-24")}
            />
            <Link
              to="/plugins"
              aria-label="应用"
              className={cn(
                "hover:bg-muted text-foreground/95 hover:text-foreground flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors",
                sidebarCollapsed ? "w-8 justify-center gap-0 px-2" : "w-full",
              )}
            >
              <PuzzleIcon className="size-4 shrink-0" />
              <span className={cn("overflow-hidden whitespace-nowrap transition-[max-width] duration-200", sidebarCollapsed ? "max-w-0" : "max-w-24")}>应用</span>
            </Link>
            {sidebarLayout === "project" && (!workspacesLoaded || !sessionsLoaded) && !sidebarCollapsed && <SidebarLoadingSkeleton layout="project" />}
            {sidebarLayout === "project" && workspacesLoaded && sessionsLoaded && <div
              aria-hidden={sidebarCollapsed}
              inert={sidebarCollapsed}
              className={cn("transition-opacity duration-150", sidebarCollapsed && "pointer-events-none opacity-0")}
            >
              <ProjectSection />
            </div>}
            {sidebarLayout === "list" && !sessionsLoaded && !sidebarCollapsed && <SidebarLoadingSkeleton layout="list" />}
            {sidebarLayout === "list" && sessionsLoaded && <ThreadListItems
                aria-hidden={sidebarCollapsed}
                inert={sidebarCollapsed}
                className={cn("transition-opacity duration-150", sidebarCollapsed && "pointer-events-none opacity-0")}
              />}
          </ThreadListRoot>
          <SidebarFooter collapsed={sidebarCollapsed} onOpenSettings={() => setSettingsOpen(true)} />
        </aside>

        <div className="relative min-w-0 flex-1 overflow-hidden bg-background">
          {lastError && (
            <div className="error-banner absolute inset-x-4 top-3 z-50" role="alert">
              <span>{lastError}</span>
              <button className="icon-button" onClick={() => useStore.setState({ lastError: undefined })} aria-label="关闭错误"><X size={15} /></button>
            </div>
          )}
          <Suspense fallback={<ThreadLoadingFallback />}>
            <Thread><PendingApprovals /></Thread>
          </Suspense>
        </div>
        <WorkspaceDock />
        {settingsOpen && <Suspense fallback={null}>
          <SettingsDialog open={settingsOpen} onClose={closeSettings} theme={theme} onToggleTheme={onToggleTheme} />
        </Suspense>}
        <ConfirmationDialogHost />
      </div>
    </AssistantRuntimeProvider>
  );
}

function PageLayout({ title, theme, onToggleTheme, children }: { title: string; theme: Theme; onToggleTheme: () => void; children: ReactNode }) {
  return (
    <div className="page-shell">
      <header className="page-topbar">
        <Link className="brand-link" to="/"><img className="qone-logo brand-mark" src={qonePenguinUrl} alt="" aria-hidden="true" /><span>Qone</span></Link>
        <div className="page-topbar-actions">
          <Link to="/" className="page-back-link">
            <ArrowLeft size={16} aria-hidden="true" />
            <span>返回主页面</span>
          </Link>
          <span className="page-title">{title}</span>
          <ThemeButton theme={theme} onToggle={onToggleTheme} />
        </div>
      </header>
      <main className="page-content">{children}</main>
    </div>
  );
}

function AppsPanel({ plugins }: { plugins: PluginInfo[] }) {
  return <>
    <div className="apps-grid">
      <BrowserIntegration />
    </div>
    <ReachChannels />
    {plugins.length > 0 && <div className="simple-list">{plugins.map((plugin) => <div className="simple-list-row stacked" key={plugin.id}><div><strong>{plugin.name}</strong><small>v{plugin.version} · {plugin.loaded ? `已加载 · ${plugin.toolCount} tools · ${plugin.skillCount} skills` : "未加载"}</small></div><span className="status-dot" /></div>)}</div>}
  </>;
}

function ManagementPanel({ kind }: { kind: "skills" | "plugins" | "permissions" }) {
  const { send, skills, plugins, workspaces, currentWorkspaceId, permissionRules, setPermission, lastError } = useStore();
  const { theme, toggleTheme } = useTheme();
  useEffect(() => {
    if (kind === "plugins") send({ type: "plugins.list", requestId: crypto.randomUUID() });
    if (kind === "skills") send({ type: "skills.list", requestId: crypto.randomUUID(), cwd: workspaces.find((w) => w.id === currentWorkspaceId)?.path });
    if (kind === "permissions") send({ type: "permission.list", requestId: crypto.randomUUID() });
  }, [kind, send, workspaces, currentWorkspaceId]);
  const titles = { skills: "Skills", plugins: "应用", permissions: "Permissions" };
  return <PageLayout title={titles[kind]} theme={theme} onToggleTheme={toggleTheme}>
    {lastError && <p className="error-banner" role="alert">{lastError}</p>}
    {kind === "plugins" ? <AppsPanel plugins={plugins} /> : <div className="settings-panel">
      {kind === "skills" && <div className="simple-list">{skills.length === 0 ? <p className="muted-copy">没有发现 Skills。</p> : skills.map((skill) => <div className="simple-list-row stacked" key={skill.id}><strong>{skill.name}</strong><small>{skill.description}</small><code>{skill.path}</code></div>)}</div>}
      {kind === "permissions" && <div className="simple-list">{permissionRules.length === 0 ? <p className="muted-copy">暂无权限规则。</p> : permissionRules.map((rule) => <div className="simple-list-row" key={`${rule.subjectId}:${rule.permission}`}><div><strong>{rule.subjectId}</strong><small>{rule.permission}</small></div><QoneSelect value={rule.decision} onChange={(value) => setPermission({ subjectId: rule.subjectId, permission: rule.permission, decision: value as "allow" | "ask" | "deny" })} options={[{ value: "allow", label: "ALLOW" }, { value: "ask", label: "ASK" }, { value: "deny", label: "DENY" }]} ariaLabel={`${rule.subjectId} 权限`} triggerClassName="qone-select-trigger-compact" /></div>)}</div>}
    </div>}
  </PageLayout>;
}

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const { pathname } = useLocation();
  const sessions = useStore((s) => s.sessions);
  const workspaces = useStore((s) => s.workspaces);
  const currentWorkspaceId = useStore((s) => s.currentWorkspaceId);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const running = useStore((s) => s.running);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const selectSession = useStore((s) => s.selectSession);

  useEffect(() => {
    reportStartup("Application route mounted");
    initBridge();
  }, []);
  useEffect(() => {
    const sessionMatch = pathname.match(/^\/chat\/([^/]+)/); const workspaceMatch = pathname.match(/^\/workspaces\/([^/]+)/);
    if (sessionMatch) { const routeSessionId = decodeURIComponent(sessionMatch[1]); if (sessions.some((session) => session.id === routeSessionId) && currentSessionId !== routeSessionId) selectSession(routeSessionId); }
    if (workspaceMatch && !running) { const routeWorkspaceId = decodeURIComponent(workspaceMatch[1]); if (workspaces.some((workspace) => workspace.id === routeWorkspaceId) && currentWorkspaceId !== routeWorkspaceId) selectWorkspace(routeWorkspaceId); }
  }, [pathname, sessions, workspaces, currentSessionId, currentWorkspaceId, running, selectSession, selectWorkspace]);

  if (["/skills", "/plugins", "/permissions"].includes(pathname)) return <ManagementPanel kind={pathname.slice(1) as "skills" | "plugins" | "permissions"} />;
  return <ChatPage theme={theme} onToggleTheme={toggleTheme} initialSettingsOpen={pathname === "/settings"} />;
}
