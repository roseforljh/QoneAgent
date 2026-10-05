import { useConversationMessages } from "./lib/use-conversation-messages";
import { PendingApprovals } from "./components/assistant-ui/pending-approvals";
import { bindSessionQueue, hydrateSessionQueue } from "./lib/session-queue-lifecycle";
import { sessionStore } from "./lib/session-execution-state";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore, initBridge, type ToolCall } from "./store";
import { reportStartup } from "./lib/startup-diagnostic";
import { localizeError } from "./lib/error-localization";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreThreadData,
  type ExternalStoreThreadListAdapter,
} from "@assistant-ui/react";
import { sameUserInput, type MessageAttachmentInfo, type MessageQuoteInfo, type PluginInfo } from "@qone/protocol";
import { convertedMessage } from "./lib/runtime-message-converter";
import { createSubagentImagesSelector } from "./lib/subagent-images";
import { createSidebarSessionsSelector } from "./lib/sidebar-sessions";
import { serializeMessageAttachments } from "./lib/message-attachments";
import { extractComposerPrompt } from "./lib/composer-prompt";
import { addComposerHistory } from "./lib/composer-history";
import { sessionActivityAt } from "./lib/session-recency";
import { useComposerDrafts } from "./lib/use-composer-drafts";
import { composerDrafts } from "./lib/composer-drafts";
import { queueMessageDraft } from "./lib/queue-composer-edit";
import { createQoneMessageQueue, getQoneMessageQueue } from "./lib/qone-message-queue";
import { useSteeringMessages } from "./lib/use-steering-messages";
import { useMessageQueueAdapter } from "./lib/use-message-queue-adapter";
import { QoneAttachmentAdapter } from "./lib/file-attachment-adapter";
import { ThreadListItems, ThreadListNew, ThreadListRoot } from "./components/assistant-ui/thread-list";
import { ScopedWorkspaceDocks } from "./components/assistant-ui/scoped-workspace-docks";
import { ThreadHeader } from "./components/assistant-ui/thread-header";
import { ProjectSection } from "./components/assistant-ui/project-section";
import { ConversationLoadingSkeleton, ComposerLoadingSkeleton, SidebarLoadingSkeleton } from "./components/assistant-ui/loading-skeleton";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { Link, useLocation } from "@tanstack/react-router";
import { ArrowLeft, Moon, Sun, X } from "lucide-react";
import { CodexIcon } from "./components/ui/CodexIcon";
import sidebarIcon from "./assets/codex-icons/sidebar-light-16.svg";
import gearIcon from "./assets/codex-icons/gear-light-16.svg";
import { cn } from "./lib/utils";
import { ConfirmationDialogHost } from "./components/ui/ConfirmationDialog";
import { confirmDestructiveAction } from "./lib/confirm-action";
import { AnimatedSidebarIcon } from "./components/ui/AnimatedSidebarIcon";
import { useLocale } from "./localization";
import { QoneSelect } from "./components/ui/Select";
import { sortSidebarSessions, useSidebarPreferences } from "./lib/sidebar-preferences";
import qonePenguinUrl from "./assets/qone-penguin.png";
import { BrowserIntegration } from "./components/browser/BrowserIntegration";
import { ChatSearchDialog } from "./components/assistant-ui/chat-search-dialog";
import { AppChrome } from "./components/app-chrome/AppChrome";
import { ResizableSidebar } from "./components/assistant-ui/resizable-sidebar";
import { CollapsedSidebar } from "./components/assistant-ui/collapsed-sidebar";
import { useTheme } from "./lib/appearance";

type Theme = "light" | "dark";
type PendingRun = { text: string; attachments: MessageAttachmentInfo[]; goal?: boolean; quote?: MessageQuoteInfo };

const Thread = lazy(async () => ({ default: (await import("./components/assistant-ui/Thread")).Thread }));
const SettingsDialog = lazy(async () => ({ default: (await import("./components/settings/SettingsDialog")).SettingsDialog }));

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

const attachmentAdapter = new QoneAttachmentAdapter();

function useQoneRuntime(pendingRun: { current: PendingRun | null }) {
  const { t } = useLocale();
  const messages = useStore((s) => s.messages);
  const streaming = useStore((s) => s.streaming);
  const streamingParts = useStore((s) => s.streamingParts);
  const running = useStore((s) => s.running);
  const connected = useStore((s) => s.connected);
  const activeRunId = useStore((s) => s.activeRunId);
  const queueItems = useStore((s) => s.queueItems);
  const queueLoadedSessionId = useStore((s) => s.queueLoadedSessionId);
  const toolCalls = useStore((s) => s.toolCalls);
  const selectChildImages = useMemo(createSubagentImagesSelector, []);
  const childImagesByRun = useStore(selectChildImages);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const modelConfigs = useStore((s) => s.modelConfigs);
  const chatRunError = useStore((s) => s.chatRunError);
  const selectSidebarSessions = useMemo(createSidebarSessionsSelector, []);
  const sessions = useStore((s) => selectSidebarSessions(s.sessions));
  const currentSessionId = useStore((s) => s.currentSessionId);
  const runAgent = useStore((s) => s.runAgent);
  const stopAgent = useStore((s) => s.stopAgent);
  const steerAgent = useStore((s) => s.steerAgent);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const send = useStore((s) => s.send);
  const sidebarPreferences = useSidebarPreferences();
  const queueReady = Boolean(currentSessionId && connected &&
    (getQoneMessageQueue(currentSessionId) || queueLoadedSessionId === currentSessionId));

  const queue = useMemo(() => currentSessionId && queueReady ? getQoneMessageQueue(currentSessionId) ?? createQoneMessageQueue({
    sessionId: currentSessionId,
    isRunning: () => sessionStore(useStore, currentSessionId).getState().running || Boolean(useStore.getState().compactionStatuses[currentSessionId]),
    getActiveRunId: () => sessionStore(useStore, currentSessionId).getState().activeRunId,
    isDuplicate: (message, attachments) => {
      const state = sessionStore(useStore, currentSessionId).getState();
      const previous = [...state.messages].reverse().find((item) => item.role === "user");
      return state.running && Boolean(previous && sameUserInput(previous, { content: extractComposerPrompt(message).text, attachments }));
    },
    editPending: (message) => {
      const state = useStore.getState();
      if (!state.editingQueueItem || state.currentSessionId !== currentSessionId) return false;
      const activeQueue = getQoneMessageQueue(currentSessionId);
      const localId = activeQueue?.getLocalId(state.editingQueueItem.id);
      if (!activeQueue || !localId) { useStore.setState({ editingQueueItem: undefined }); return false; }
      void activeQueue.edit(localId, message).then((saved) => {
        if (!saved) return;
        const owner = sessionStore(useStore, currentSessionId);
        if (owner.getState().editingQueueItem?.id === state.editingQueueItem?.id) owner.setState({ editingQueueItem: undefined });
      }).catch((error) => {
        // Restore by conversation, including after its composer unmounts.
        if (!composerDrafts.get(currentSessionId)) composerDrafts.set(currentSessionId, queueMessageDraft(message));
        useStore.setState({ lastError: localizeError(error) });
      });
      return true;
    },
    send: (message, queueItemId, attachments) => { const prompt = extractComposerPrompt(message); if (prompt.text.trim()) addComposerHistory(currentSessionId, prompt.text); runAgent(prompt.text, undefined, attachments, queueItemId, prompt.goal, currentSessionId, prompt.quote); },
    steer: (message, queueItemId, attachments, targetRunId) => {
      const state = sessionStore(useStore, currentSessionId).getState();
      if (!targetRunId || state.activeRunId !== targetRunId || !state.running) return Promise.resolve(false);
      const prompt = extractComposerPrompt(message);
      if (prompt.text.trim()) addComposerHistory(currentSessionId, prompt.text);
      return steerAgent({ sessionId: currentSessionId, runId: targetRunId, queueItemId, message: prompt.text, attachments, quote: prompt.quote });
    },
    sync: (items) => { void useStore.getState().send({ type: "queue.sync", requestId: crypto.randomUUID(), sessionId: currentSessionId, items }); },
    onError: (message) => useStore.setState({ lastError: message }),
  }) : null, [currentSessionId, queueReady, runAgent, steerAgent]);

  const queueAdapter = useMessageQueueAdapter(queue);
  const submittedSteers = useSteeringMessages(queue, queueAdapter, queueItems, activeRunId);

  useEffect(() => {
    if (queue && currentSessionId && queueLoadedSessionId === currentSessionId) {
      hydrateSessionQueue(queue, queueItems, sessionStore(useStore, currentSessionId).getState().editingQueueItem?.id);
    }
  }, [queue, currentSessionId, queueLoadedSessionId, queueItems]);
  useEffect(() => {
    if (queue && currentSessionId) bindSessionQueue(currentSessionId, queue);
  }, [queue, currentSessionId]);

  const convertedMessages = useConversationMessages({
    messages, streaming, streamingParts, running, activeRunId, currentSessionId,
    selectedModel: modelConfigs.find((config) => config.id === selectedModelId),
    chatRunError, toolCalls, childImagesByRun,
  }, submittedSteers);

  const threads = useMemo<ExternalStoreThreadData<"regular">[]>(
    () => sortSidebarSessions(sessions, {
      ...sidebarPreferences,
      priorityIds: sidebarPreferences.priorityIds.length ? sidebarPreferences.priorityIds : currentSessionId ? [currentSessionId] : [],
    }).map((session) => ({
      id: session.id,
      title: session.title,
      status: "regular",
      // passed through to threadItems via the adapter's spread
      lastMessageAt: new Date(sessionActivityAt(session)),
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

  const runtime = useExternalStoreRuntime({
    messages: convertedMessages,
    isRunning: running,
    // Do not bypass the queue through onNew while its initial snapshot is
    // still loading after selection or reconnect.
    isSendDisabled: Boolean(currentSessionId && !queueReady),
    convertMessage: convertedMessage,
    onNew: async (message) => {
      const prompt = extractComposerPrompt(message);
      const text = prompt.text;
      if (currentSessionId && text.trim()) addComposerHistory(currentSessionId, text);
      let attachments: MessageAttachmentInfo[];
      try { attachments = await serializeMessageAttachments(message); }
      catch (error) { useStore.setState({ lastError: String(error) }); throw error; }
       if (!text && attachments.length === 0) return;
       if (prompt.goal && !text.trim()) return;
      const state = useStore.getState();
      if (state.editingQueueItem && state.currentSessionId === currentSessionId && queue) {
        const localId = queue.getLocalId(state.editingQueueItem.id);
        if (localId) {
          if (await queue.edit(localId, message)) sessionStore(useStore, currentSessionId).setState({ editingQueueItem: undefined });
          return;
        }
      }
      if (!state.currentSessionId && state.draftWorkspaceId) {
        runAgent(text, undefined, attachments, undefined, prompt.goal, undefined, prompt.quote);
        return;
      }
      if (!state.currentSessionId) {
        if (!state.currentWorkspaceId || !state.workspaces.some((workspace) => workspace.id === state.currentWorkspaceId)) {
          useStore.setState({ lastError: t("error.projectBeforeMessage") });
          return;
        }
        pendingRun.current = { text, attachments, goal: prompt.goal, quote: prompt.quote };
        newSession();
        return;
      }
      runAgent(text, undefined, attachments, undefined, prompt.goal, undefined, prompt.quote);
    },
    onReload: async (parentId) => {
      if (!parentId) return;
      const source = useStore.getState().messages.find((message) => message.id === parentId && message.role === "user");
      if (source) runAgent(source.content, source.id, source.attachments, undefined, Boolean(source.goalId), undefined, source.quote);
    },
    onEdit: async (message) => {
      const sourceId = message.sourceId;
      const state = useStore.getState();
      if (!sourceId || !state.currentSessionId || state.running) return;
      const source = state.messages.find((item) => item.id === sourceId && item.role === "user");
      const prompt = extractComposerPrompt(message);
      let attachments: MessageAttachmentInfo[];
      try { attachments = await serializeMessageAttachments(message); }
      catch (error) { useStore.setState({ lastError: String(error) }); throw error; }
      if (!prompt.text.trim() && attachments.length === 0) return;
      if (prompt.goal && !prompt.text.trim()) return;
      if (prompt.text.trim()) addComposerHistory(state.currentSessionId, prompt.text);
      runAgent(prompt.text, sourceId, attachments, undefined, prompt.goal || Boolean(source?.goalId), state.currentSessionId, prompt.quote ?? source?.quote);
    },
    onCancel: async () => stopAgent(),
    queue: queueAdapter,
    adapters: { threadList, attachments: attachmentAdapter },
  });

  useComposerDrafts(runtime);
  return runtime;
}

function Logo({ collapsed }: { collapsed: boolean }) {
  const { t } = useLocale();
  return (
    <Link
      to="/"
      aria-label={t("app.backHome")}
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
  const { t } = useLocale();
  return (
    <div className="aui-root aui-thread-root relative flex h-full min-h-0 flex-col items-stretch bg-background px-4" aria-busy="true" aria-label={t("app.loadingChat")}>
      <ConversationLoadingSkeleton />
      <div className="mx-auto w-full shrink-0 q-composer-content pb-2">
        <ComposerLoadingSkeleton />
      </div>
    </div>
  );
}

function SidebarFooter({ collapsed, onOpenSettings }: { collapsed: boolean; onOpenSettings: () => void }) {
  const { t } = useLocale();
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
        <CodexIcon src={gearIcon} className="size-3.5 shrink-0" />
        <span className={cn("overflow-hidden whitespace-nowrap transition-[max-width] duration-200", collapsed ? "max-w-0" : "max-w-24")}>{t("common.settings")}</span>
      </button>
    </div>
  );
}

function ChatPageContent({ theme, onToggleTheme, initialSettingsOpen = false, pendingRun }: { theme: Theme; onToggleTheme: () => void; initialSettingsOpen?: boolean; pendingRun: React.MutableRefObject<PendingRun | null> }) {
  const { t } = useLocale();
  const sidebarCollapsed = useSidebarPreferences((state) => state.collapsed);
  const setSidebarCollapsed = useSidebarPreferences((state) => state.setCollapsed);
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
  }, [setSidebarCollapsed]);
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
  const currentWorkspaceId = useStore((s) => s.currentWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);

  const runAgent = useStore((s) => s.runAgent);
  const sidebarLayout = useSidebarPreferences((s) => s.layout);
  const sessionsLoaded = useStore((s) => s.sessionsLoaded);
  const workspacesLoaded = useStore((s) => s.workspacesLoaded);

  useEffect(() => {
    if (currentSessionId && pendingRun.current) {
      const { text, attachments, goal, quote } = pendingRun.current;
      pendingRun.current = null;
      runAgent(text, undefined, attachments, undefined, goal, undefined, quote);
    }
  }, [currentSessionId, runAgent]);

  return (
      <div className="q-chat-layout relative flex h-full w-full overflow-hidden">
        <ResizableSidebar collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed}
          collapsedContent={<CollapsedSidebar collapsed={sidebarCollapsed} onOpenSidebar={() => setSidebarCollapsed(false)}
            onOpenSettings={() => setSettingsOpen(true)} />}>
        <aside
          className={cn(
            "q-sidebar bg-background flex h-full w-full flex-col overflow-hidden border-r border-border/50",
          )}
        >
          <div className="flex h-12 shrink-0 items-center overflow-hidden px-2">
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip={t("sidebar.collapse")}
              side="right"
              onClick={() => setSidebarCollapsed(true)}
              className="size-8 shrink-0"
            >
              <CodexIcon src={sidebarIcon} className="size-4" />
            </TooltipIconButton>
            <Logo collapsed={false} />
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip={t("sidebar.searchChats")}
              side="right"
              onClick={() => setSearchOpen(true)}
              className="q-sidebar-search-trigger ml-auto size-8 shrink-0 p-2"
            >
              <AnimatedSidebarIcon kind="search" />
            </TooltipIconButton>
          </div>
          <ThreadListRoot className="relative min-h-0 w-full flex-1 gap-0 overflow-hidden">
            <div className="flex shrink-0 flex-col gap-0.5 px-2 pb-2">
              <ThreadListNew
                disabled={!currentWorkspaceId || !workspaces.some((workspace) => workspace.id === currentWorkspaceId)}
                className={cn(
                  "group h-[30px] overflow-hidden transition-all duration-200",
                  "w-full gap-2 px-2.5",
                )}
                labelClassName="overflow-hidden whitespace-nowrap"
              />
              <Link
                to="/plugins"
                aria-label={t("app.apps")}
                data-slot="q-sidebar-app-link"
                className={cn(
                  "group hover:bg-muted text-foreground/95 hover:text-foreground flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                  "w-full",
                )}
              >
                <AnimatedSidebarIcon kind="plugins" />
                <span className="overflow-hidden whitespace-nowrap">{t("app.apps")}</span>
              </Link>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-2 pt-1 pb-2">
              {sidebarLayout === "project" && (!workspacesLoaded || !sessionsLoaded) && <SidebarLoadingSkeleton layout="project" />}
              {sidebarLayout === "project" && workspacesLoaded && sessionsLoaded && <div>
                <ProjectSection />
              </div>}
              {sidebarLayout === "list" && !sessionsLoaded && <SidebarLoadingSkeleton layout="list" />}
              {sidebarLayout === "list" && sessionsLoaded && <ThreadListItems />}
            </div>
          </ThreadListRoot>
          <SidebarFooter collapsed={false} onOpenSettings={() => setSettingsOpen(true)} />
        </aside>
        </ResizableSidebar>

        <ChatRuntimeHost dockView={dockView} lastError={lastError} dismissError={() => useStore.setState({ lastError: undefined })} />
        <ScopedWorkspaceDocks onViewChange={setDockView} />
        {settingsOpen && <Suspense fallback={null}>
          <SettingsDialog open={settingsOpen} onClose={closeSettings} />
        </Suspense>}
        <ChatSearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
        <ConfirmationDialogHost />
      </div>
  );
}

const ChatRuntimeHost = memo(function ChatRuntimeHost({ dockView, lastError, dismissError }: { dockView?: string; lastError?: string; dismissError: () => void }) {
  const { t } = useLocale();
  return <>
    <div className="q-chat-shell relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <ThreadHeader dockView={dockView} />
      {lastError && <div className="error-banner q-chat-error-banner absolute inset-x-4 z-50" role="alert">
        <span>{lastError}</span>
        <button className="icon-button" onClick={dismissError} aria-label={t("common.dismissError")}><X size={15} /></button>
      </div>}
      <div className="q-chat-content relative min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<ThreadLoadingFallback />}><Thread><PendingApprovals /></Thread></Suspense>
      </div>
    </div>
  </>;
});

function ChatPageRuntime({ pendingRun, ...props }: Omit<React.ComponentProps<typeof ChatPageContent>, "pendingRun"> & { pendingRun: React.MutableRefObject<PendingRun | null> }) {
  const runtime = useQoneRuntime(pendingRun);
  return <AssistantRuntimeProvider runtime={runtime}><StableChatPageContent pendingRun={pendingRun} {...props} /></AssistantRuntimeProvider>;
}

const StableChatPageContent = memo(ChatPageContent);

function ChatPage({ theme, onToggleTheme, initialSettingsOpen = false }: { theme: Theme; onToggleTheme: () => void; initialSettingsOpen?: boolean }) {
  const pendingRun = useRef<PendingRun | null>(null);
  return <ChatPageRuntime pendingRun={pendingRun} theme={theme} onToggleTheme={onToggleTheme} initialSettingsOpen={initialSettingsOpen} />;
}

function PageLayout({ title, theme, onToggleTheme, children }: { title: string; theme: Theme; onToggleTheme: () => void; children: ReactNode }) {
  const { t } = useLocale();
  return (
    <div className="page-shell">
      <header className="page-topbar">
        <Link className="brand-link" to="/"><img className="qone-logo brand-mark" src={qonePenguinUrl} alt="" aria-hidden="true" /><span>Qone</span></Link>
        <div className="page-topbar-actions">
          <Link to="/" className="page-back-link">
            <ArrowLeft size={16} aria-hidden="true" />
            <span>{t("app.backHome")}</span>
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
  const { t } = useLocale();
  return <>
    <div className="apps-grid">
      <BrowserIntegration />
    </div>
    {plugins.length > 0 && <div className="simple-list">{plugins.map((plugin) => <div className="simple-list-row stacked" key={plugin.id}><div><strong>{plugin.name}</strong><small>v{plugin.version} · {plugin.loaded ? t("app.pluginLoaded", { tools: plugin.toolCount, skills: plugin.skillCount }) : t("app.pluginUnloaded")}</small></div><span className="status-dot" /></div>)}</div>}
  </>;
}

function ManagementPanel({ kind }: { kind: "skills" | "plugins" | "permissions" }) {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const skills = useStore((state) => state.skills);
  const plugins = useStore((state) => state.plugins);
  const workspaces = useStore((state) => state.workspaces);
  const currentWorkspaceId = useStore((state) => state.currentWorkspaceId);
  const permissionRules = useStore((state) => state.permissionRules);
  const setPermission = useStore((state) => state.setPermission);
  const lastError = useStore((state) => state.lastError);
  const { theme, toggleTheme } = useTheme();
  useEffect(() => {
    if (kind === "plugins") send({ type: "plugins.list", requestId: crypto.randomUUID() });
    if (kind === "skills") send({ type: "skills.list", requestId: crypto.randomUUID(), cwd: workspaces.find((w) => w.id === currentWorkspaceId)?.path });
    if (kind === "permissions") send({ type: "permission.list", requestId: crypto.randomUUID() });
  }, [kind, send, workspaces, currentWorkspaceId]);
  const titles = { skills: t("nav.skills"), plugins: t("app.apps"), permissions: t("composer.permissions") };
  return <PageLayout title={titles[kind]} theme={theme} onToggleTheme={toggleTheme}>
    {lastError && <p className="error-banner" role="alert">{lastError}</p>}
    {kind === "plugins" ? <AppsPanel plugins={plugins} /> : <div className="settings-panel">
      {kind === "skills" && <div className="simple-list">{skills.length === 0 ? <p className="muted-copy">{t("app.noSkills")}</p> : skills.map((skill) => <div className="simple-list-row stacked" key={skill.id}><strong>{skill.name}</strong><small>{skill.description}</small><code>{skill.path}</code></div>)}</div>}
      {kind === "permissions" && <div className="simple-list">{permissionRules.length === 0 ? <p className="muted-copy">{t("app.noPermissions")}</p> : permissionRules.map((rule) => <div className="simple-list-row" key={`${rule.subjectId}:${rule.permission}`}><div><strong>{rule.subjectId}</strong><small>{rule.permission}</small></div><QoneSelect value={rule.decision} onChange={(value) => setPermission({ subjectId: rule.subjectId, permission: rule.permission, decision: value as "allow" | "ask" | "deny" })} options={[{ value: "allow", label: t("app.allow") }, { value: "ask", label: t("app.ask") }, { value: "deny", label: t("app.deny") }]} ariaLabel={t("app.subjectPermissions", { subject: rule.subjectId })} triggerClassName="qone-select-trigger-compact" /></div>)}</div>}
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
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const selectSession = useStore((s) => s.selectSession);

  useEffect(() => {
    reportStartup("Application route mounted");
    initBridge();
  }, []);
  useEffect(() => {
    const sessionMatch = pathname.match(/^\/chat\/([^/]+)/); const workspaceMatch = pathname.match(/^\/workspaces\/([^/]+)/);
    if (sessionMatch) { const routeSessionId = decodeURIComponent(sessionMatch[1]); if (sessions.some((session) => session.id === routeSessionId) && currentSessionId !== routeSessionId) selectSession(routeSessionId); }
    if (workspaceMatch) { const routeWorkspaceId = decodeURIComponent(workspaceMatch[1]); if (workspaces.some((workspace) => workspace.id === routeWorkspaceId) && currentWorkspaceId !== routeWorkspaceId) selectWorkspace(routeWorkspaceId); }
  }, [pathname, sessions, workspaces, currentSessionId, currentWorkspaceId, selectSession, selectWorkspace]);

  return <AppChrome path={pathname}>
    {["/skills", "/plugins", "/permissions"].includes(pathname)
      ? <ManagementPanel kind={pathname.slice(1) as "skills" | "plugins" | "permissions"} />
      : <ChatPage theme={theme} onToggleTheme={toggleTheme} initialSettingsOpen={pathname === "/settings"} />}
  </AppChrome>;
}
