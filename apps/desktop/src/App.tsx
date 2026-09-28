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
import { type MessageAttachmentInfo, type PluginInfo } from "@qone/protocol";
import { assistantMessageContent } from "./lib/assistant-message-parts";
import { isImageModel } from "./lib/image-model-config";
import { appendSubagentImages, selectSubagentImages } from "./lib/subagent-images";
import { serializeMessageAttachments } from "./lib/message-attachments";
import { createQoneMessageQueue, getQoneMessageQueue, setQoneMessageQueue } from "./lib/qone-message-queue";
import { AnyFileAttachmentAdapter } from "./lib/file-attachment-adapter";
import { ThreadListItems, ThreadListNew, ThreadListRoot } from "./components/assistant-ui/thread-list";
import { WorkspaceDock } from "./components/assistant-ui/workspace-dock";
import { ThreadHeader } from "./components/assistant-ui/thread-header";
import { ProjectSection } from "./components/assistant-ui/project-section";
import { ConversationLoadingSkeleton, ComposerLoadingSkeleton, SidebarLoadingSkeleton } from "./components/assistant-ui/loading-skeleton";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { Link, useLocation } from "@tanstack/react-router";
import { ApprovalCard } from "./components/tool-ui/ToolCard";
import { ArrowLeft, Moon, PanelLeftIcon, PuzzleIcon, SearchIcon, Settings, Sun, X } from "lucide-react";
import { cn } from "./lib/utils";
import { ConfirmationDialogHost } from "./components/ui/ConfirmationDialog";
import { confirmDestructiveAction } from "./lib/confirm-action";
import { useLocale } from "./localization";
import { QoneSelect } from "./components/ui/Select";
import { sortSidebarSessions, useSidebarPreferences } from "./lib/sidebar-preferences";
import qonePenguinUrl from "./assets/qone-penguin.png";
import { BrowserIntegration } from "./components/browser/BrowserIntegration";
import { ReachChannels } from "./components/reach/ReachChannels";
import { ChatSearchDialog } from "./components/assistant-ui/chat-search-dialog";
import { AppChrome } from "./components/app-chrome/AppChrome";

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

const extractComposerPrompt = (message: AppendMessage): { text: string; goal: boolean } => {
  const raw = extractText(message);
  const directive = /:qone-tool\[[^\]\n]*\]\{name=qone-goal\}\s*/giu;
  const legacy = /^\s*@goal\b\s*/iu;
  if (directive.test(raw)) return { text: raw.replace(directive, "").trim(), goal: true };
  if (legacy.test(raw)) return { text: raw.replace(legacy, "").trim(), goal: true };
  return { text: raw, goal: false };
};

function useQoneRuntime(pendingRun: { current: { text: string; attachments: MessageAttachmentInfo[]; goal?: boolean } | null }) {
  const { t } = useLocale();
  const messages = useStore((s) => s.messages);
  const streaming = useStore((s) => s.streaming);
  const streamingParts = useStore((s) => s.streamingParts);
  const running = useStore((s) => s.running);
  const activeRunId = useStore((s) => s.activeRunId);
  const queueItems = useStore((s) => s.queueItems);
  const queueLoadedSessionId = useStore((s) => s.queueLoadedSessionId);
  const toolCalls = useStore((s) => s.toolCalls);
  const childImagesByRun = useStore(selectSubagentImages);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const modelConfigs = useStore((s) => s.modelConfigs);
  const chatRunError = useStore((s) => s.chatRunError);
  const sessions = useStore((s) => s.sessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const runAgent = useStore((s) => s.runAgent);
  const stopAgent = useStore((s) => s.stopAgent);
  const steerAgent = useStore((s) => s.steerAgent);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const send = useStore((s) => s.send);
  const sidebarPreferences = useSidebarPreferences();

  const queue = useMemo(() => currentSessionId ? createQoneMessageQueue({
    sessionId: currentSessionId,
    isRunning: () => useStore.getState().running,
    editPending: (message) => {
      const state = useStore.getState();
      if (!state.editingQueueItem || state.currentSessionId !== currentSessionId) return false;
      const activeQueue = getQoneMessageQueue(currentSessionId);
      const localId = activeQueue?.getLocalId(state.editingQueueItem.id);
      if (!activeQueue || !localId) return false;
      activeQueue.edit(localId, message, state.editingQueueItem.attachments);
      useStore.setState({ editingQueueItem: undefined });
      return true;
    },
    send: (message, queueItemId, attachments) => { const prompt = extractComposerPrompt(message); runAgent(prompt.text, undefined, attachments, queueItemId, prompt.goal); },
    steer: (message, queueItemId, attachments) => {
      const state = useStore.getState();
      if (!state.activeRunId) return Promise.resolve(false);
      return steerAgent({ sessionId: currentSessionId, runId: state.activeRunId, queueItemId, message: extractText(message), attachments });
    },
    sync: (items) => { void useStore.getState().send({ type: "queue.sync", requestId: crypto.randomUUID(), sessionId: currentSessionId, items }); },
    onError: (message) => useStore.setState({ lastError: message }),
  }) : null, [currentSessionId, runAgent, steerAgent]);

  const hydratedQueueSession = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!queue || !currentSessionId) return;
    if (queueLoadedSessionId !== currentSessionId) {
      if (queueLoadedSessionId === undefined && hydratedQueueSession.current === currentSessionId) {
        queue.restore([]);
        hydratedQueueSession.current = undefined;
      }
      return;
    }
    if (hydratedQueueSession.current === currentSessionId) return;
    queue.restore(queueItems);
    hydratedQueueSession.current = currentSessionId;
  }, [queue, currentSessionId, queueLoadedSessionId, queueItems]);
  useEffect(() => {
    if (!queue || !currentSessionId) return;
    setQoneMessageQueue(currentSessionId, queue);
    return () => setQoneMessageQueue(currentSessionId, undefined);
  }, [queue, currentSessionId]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!queue) return;
    if (running && !wasRunning.current) queue.controller.notifyBusy();
    if (!running && wasRunning.current) {
      queue.controller.notifyIdle();
      queue.releaseIdle();
    }
    wasRunning.current = running;
  }, [queue, running]);

  const hasStreamingAssistant = running;
  const selectedModel = modelConfigs.find((config) => config.id === selectedModelId);
  const imageGenerationError = !hasStreamingAssistant && chatRunError && chatRunError.sessionId === currentSessionId && chatRunError.userMessageId && isImageModel(selectedModel)
    ? messages.find((message) => message.id === chatRunError.userMessageId)
    : undefined;
  const runtimeMessages = useMemo(() => {
    if (hasStreamingAssistant) return [...messages, { id: "streaming", role: "assistant", content: streaming, parts: streamingParts.length ? streamingParts : undefined, runId: activeRunId, createdAt: messages.at(-1)?.createdAt ?? Date.now() }];
    if (!imageGenerationError) return messages;
    return [...messages, { id: `image-error:${imageGenerationError.id}`, role: "assistant", content: "", createdAt: Date.now() }];
  }, [messages, streaming, streamingParts, activeRunId, hasStreamingAssistant, imageGenerationError]);
  const imageWindows = useMemo(() => {
    const windows = new Map<string, { after?: number; through?: number }>();
    const lastAssistantByRun = new Map<string, number>();
    for (const message of runtimeMessages) {
      if (message.role !== "assistant" || !message.runId) continue;
      windows.set(message.id, {
        after: lastAssistantByRun.get(message.runId),
        through: message.id === "streaming" ? undefined : message.createdAt,
      });
      if (message.id !== "streaming" && message.createdAt !== undefined) lastAssistantByRun.set(message.runId, message.createdAt);
    }
    return windows;
  }, [runtimeMessages]);
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
      const converted = assistantMessageContent(message, calls, isStreamingMessage);
      // The child transcript stays in the dock, but its images also belong
      // to the parent answer. Derive them from persisted child runs so live
      // updates and reopened sessions use the same content.
      const imageWindow = imageWindows.get(message.id);
      const content = appendSubagentImages(converted, message.runId ? childImagesByRun.get(message.runId) : undefined, imageWindow?.after, imageWindow?.through);
      const imageGenerationPending = isStreamingMessage && running && isImageModel(selectedModel) && content.length === 0;
      const imageGenerationFailed = message.id.startsWith("image-error:") && imageGenerationError ? { prompt: imageGenerationError.content, error: chatRunError?.detail } : undefined;
      return {
        id: message.id,
        role,
        createdAt,
        content,
        metadata: imageGenerationPending || imageGenerationFailed ? { custom: { qoneImageGeneration: imageGenerationPending ? { prompt: message.content, generating: true } : imageGenerationFailed } } : undefined,
        status: isStreamingMessage && running ? { type: "running" } : { type: "complete", reason: "stop" },
      };
    },
    onNew: async (message) => {
      const prompt = extractComposerPrompt(message);
      const text = prompt.text;
      let attachments: MessageAttachmentInfo[];
      try { attachments = await serializeMessageAttachments(message); }
      catch (error) { useStore.setState({ lastError: String(error) }); throw error; }
       if (!text && attachments.length === 0) return;
       if (prompt.goal && !text.trim()) return;
      const state = useStore.getState();
      if (state.editingQueueItem && state.currentSessionId === currentSessionId && queue) {
        const localId = queue.getLocalId(state.editingQueueItem.id);
        if (localId) {
          queue.edit(localId, message, state.editingQueueItem.attachments);
          useStore.setState({ editingQueueItem: undefined });
          return;
        }
      }
      if (!state.currentSessionId && state.draftWorkspaceId) {
        runAgent(text, undefined, attachments, undefined, prompt.goal);
        return;
      }
      if (!state.currentSessionId) {
        if (!state.currentWorkspaceId || !state.workspaces.some((workspace) => workspace.id === state.currentWorkspaceId)) {
          useStore.setState({ lastError: "请先导入项目，再发送消息。" });
          return;
        }
        pendingRun.current = { text, attachments, goal: prompt.goal };
        newSession();
        return;
      }
      runAgent(text, undefined, attachments, undefined, prompt.goal);
    },
    onReload: async (parentId) => {
      if (!parentId) return;
      const source = useStore.getState().messages.find((message) => message.id === parentId && message.role === "user");
      if (source) runAgent(source.content, source.id, source.attachments, undefined, Boolean(source.goalId));
    },
    onCancel: async () => stopAgent(),
    queue: queue?.adapter,
    adapters: { threadList, attachments: attachmentAdapter },
  });
}

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <Link
      to="/"
      aria-label="返回主页面"
      className={cn(
        "ml-2 flex min-w-0 items-center gap-2 truncate text-[15px] font-semibold transition-[opacity,max-width] duration-200 hover:opacity-80",
        collapsed ? "max-w-0 opacity-0" : "max-w-32 opacity-100",
      )}
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
    <div className="mt-auto shrink-0 p-2">
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
  const { t } = useLocale();
  const pendingRun = useRef<{ text: string; attachments: MessageAttachmentInfo[]; goal?: boolean } | null>(null);
  const runtime = useQoneRuntime(pendingRun);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dockView, setDockView] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener("qone-open-settings", openSettings);
    return () => window.removeEventListener("qone-open-settings", openSettings);
  }, []);
  useEffect(() => {
    const toggleSidebar = () => setSidebarCollapsed((collapsed) => !collapsed);
    const openSearch = () => setSearchOpen(true);
    window.addEventListener("qone-toggle-sidebar", toggleSidebar);
    window.addEventListener("qone-open-search", openSearch);
    return () => {
      window.removeEventListener("qone-toggle-sidebar", toggleSidebar);
      window.removeEventListener("qone-open-search", openSearch);
    };
  }, []);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);
  const lastError = useStore((s) => s.lastError);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const runAgent = useStore((s) => s.runAgent);
  const sidebarLayout = useSidebarPreferences((s) => s.layout);
  const sessionsLoaded = useStore((s) => s.sessionsLoaded);
  const workspacesLoaded = useStore((s) => s.workspacesLoaded);

  useEffect(() => {
    if (currentSessionId && pendingRun.current) {
      const { text, attachments, goal } = pendingRun.current;
      pendingRun.current = null;
      runAgent(text, undefined, attachments, undefined, goal);
    }
  }, [currentSessionId, runAgent]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="relative flex h-full w-full overflow-hidden">
        <aside
          className={cn(
            "q-sidebar bg-muted/30 flex h-full shrink-0 flex-col overflow-hidden border-r border-border/50 transition-[width] duration-200",
            sidebarCollapsed ? "w-12" : "w-[var(--q-sidebar-width)]",
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
            <Logo collapsed={sidebarCollapsed} />
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip={t("sidebar.searchChats")}
              side="right"
              onClick={() => setSearchOpen(true)}
              className="q-sidebar-search-trigger ml-auto size-8 shrink-0"
            >
              <SearchIcon className="size-4" />
            </TooltipIconButton>
          </div>
          <ThreadListRoot className="relative min-h-0 w-full flex-1 gap-0 overflow-hidden">
            <div className="flex shrink-0 flex-col gap-0.5 px-2 pb-2">
              <ThreadListNew
                className={cn(
                  "h-[30px] overflow-hidden transition-all duration-200",
                  sidebarCollapsed ? "w-8 gap-0 px-2" : "w-full gap-2 px-2.5",
                )}
                labelClassName={cn("overflow-hidden whitespace-nowrap transition-[max-width] duration-200", sidebarCollapsed ? "max-w-0" : "max-w-24")}
              />
              <Link
                to="/plugins"
                aria-label="应用"
                className={cn(
                  "hover:bg-muted text-foreground/95 hover:text-foreground flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                  sidebarCollapsed ? "w-8 justify-center gap-0 px-2" : "w-full",
                )}
              >
                <PuzzleIcon className="size-4 shrink-0" />
                <span className={cn("overflow-hidden whitespace-nowrap transition-[max-width] duration-200", sidebarCollapsed ? "max-w-0" : "max-w-24")}>应用</span>
              </Link>
            </div>
            <div className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-2 pt-1 pb-2", sidebarCollapsed && "overflow-hidden")}>
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
            </div>
          </ThreadListRoot>
          <SidebarFooter collapsed={sidebarCollapsed} onOpenSettings={() => setSettingsOpen(true)} />
        </aside>

        <div className="q-chat-shell relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <ThreadHeader dockView={dockView} />
          {lastError && (
            <div className="error-banner q-chat-error-banner absolute inset-x-4 z-50" role="alert">
              <span>{lastError}</span>
              <button className="icon-button" onClick={() => useStore.setState({ lastError: undefined })} aria-label="关闭错误"><X size={15} /></button>
            </div>
          )}
          <div className="q-chat-content relative min-h-0 flex-1 overflow-hidden">
            <Suspense fallback={<ThreadLoadingFallback />}>
              <Thread><PendingApprovals /></Thread>
            </Suspense>
          </div>
        </div>
        <WorkspaceDock onViewChange={setDockView} />
        {settingsOpen && <Suspense fallback={null}>
          <SettingsDialog open={settingsOpen} onClose={closeSettings} theme={theme} onToggleTheme={onToggleTheme} />
        </Suspense>}
        <ChatSearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
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

  return <AppChrome path={pathname}>
    {["/skills", "/plugins", "/permissions"].includes(pathname)
      ? <ManagementPanel kind={pathname.slice(1) as "skills" | "plugins" | "permissions"} />
      : <ChatPage theme={theme} onToggleTheme={toggleTheme} initialSettingsOpen={pathname === "/settings"} />}
  </AppChrome>;
}
