"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from "react";
import { Popover } from "radix-ui";
import { openPath } from "../../lib/desktop-bridge";
import { motion, useMotionValueEvent, useReducedMotion } from "motion/react";
import {
  ArrowLeftIcon,
  BotMessageSquareIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GlobeIcon,
  ListTodoIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightCloseIcon,
  PlugIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  WandSparklesIcon,
  type LucideIcon,
} from "lucide-react";
import type { WorkspaceFileInfo, WorkspaceGitEntry } from "@qone/protocol";
import { useStore } from "../../store";
import { TooltipIconButton } from "./tooltip-icon-button";
import { attachmentFileIcon } from "../../lib/attachment-file-kind";
import { DiffViewer } from "./elements/diff-viewer";
import { WorkspaceFileContent } from "./workspace-file-content";
import { DockBrowserView, DockMcpView, DockSkillsView } from "./dock-extra-views";
import { FadeScroll, mono } from "./elements/surfaces";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { onOpenBrowserInDock, type BrowserDockRequest } from "../../lib/browser-dock";
import { SubagentPanel } from "./subagent-view";
import { OPEN_SUBAGENT_EVENT } from "./subagent-navigation";
import { OPEN_WORKSPACE_FILE_EVENT, resolveFileReferencePath, type WorkspaceFileTarget } from "../../lib/workspace-file-navigation";
import { OPEN_RUN_CHANGES_EVENT, runChangesTab, type RunChangesTarget } from "../../lib/run-changes-navigation";
import { RunChangesPanel } from "./run-changes-panel";
import FileReader from "./file-reader";
import { InlineFileReader } from "./inline-file-reader";
import { clampDockWidth, defaultDockWidth, dockWidthBounds, dockResizeState } from "../../lib/dock-layout";
import { usePaneSizes } from "../../lib/pane-size-preferences";
import { usePaneResize } from "../../lib/use-pane-resize";
import { usePaneMotion } from "../../lib/use-pane-motion";
import { DOCK_VISIBILITY_TRANSITION } from "../../lib/pane-motion";
import { NARROW_SCREEN_WIDTH } from "../../lib/sidebar-layout";
import TerminalView, { type TerminalApi } from "./dock-terminal-view";
import { closeDockTerminalResource } from "../../lib/dock-terminal-resource";
import { DockTerminalActions } from "./dock-terminal-actions";
import { CodexIcon } from "../ui/CodexIcon";
import terminalIcon from "../../assets/codex-icons/terminal-light-16.svg";
import plusIcon from "../../assets/codex-icons/plus-md-light-16.svg";
import closeIcon from "../../assets/codex-icons/xmark-md-light-16.svg";
import { closeDockTabsExcept, closeDockTabsToRight, filePreviewTab, useDockState, type DockTab, type DockView } from "../../lib/dock-state";
import {
  initWorkspaceView, removeWorkspaceView, requestWorkspaceFiles, requestWorkspaceFileRead,
  requestWorkspaceGit, requestWorkspaceGitDiff, useWorkspaceViewState, useWorkspaceViewStore,
} from "../../lib/workspace-view-state";
import "./workspace-dock.css";
import { SideConversationPanel } from "./side-conversation-panel";
import { closeSideConversation } from "../../lib/side-conversation";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { localizeError } from "../../lib/error-localization";
import sideChatIcon from "../../assets/codex-icons/plus-chat-bubble-right-light-16.svg";
import { useSelectedTextSideChat } from "../../hooks/use-selected-text-side-chat";
import { CodeContextMenu, DockTabContextMenu, WorkspacePathContextMenu } from "./dock-context-menu";
import { FilesView, GitView, SessionDetails } from "./workspace-dock-views";

const DOCK_VIEWS: readonly DockView[] = ["session", "terminal", "files", "git", "browser", "mcp", "skills", "subagents"];
const isDockView = (value: unknown): value is DockView =>
  typeof value === "string" && DOCK_VIEWS.some((view) => view === value);

const rid = () => crypto.randomUUID();

export function WorkspaceDock({ scopeKey, scopeActive, sessionId, workspaceId, onViewChange, onTabsChange }: {
  scopeKey: string;
  scopeActive: boolean;
  sessionId?: string;
  workspaceId?: string;
  onViewChange?: (view: DockView | undefined) => void;
  onTabsChange?: (hasTabs: boolean) => void;
}) {
  const { t } = useLocale();
  const workspaces = useStore((state) => state.workspaces);
  const sideChats = useStore((state) => state.sideChats);
  const storedScope = useDockState((state) => state.scopes[scopeKey]);
  const updateDock = useDockState((state) => state.update);
  const [openTabs, setOpenTabs] = useState<DockTab[]>(() => storedScope?.openTabs ?? []);
  const [activeTabId, setActiveTabId] = useState<string | undefined>(() => storedScope?.activeTabId);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string>();
  const [collapsed, setCollapsed] = useState(() => storedScope?.collapsed ?? true);
  const activeTab = openTabs.find((tab) => tab.id === activeTabId);
  const view = scopeActive && !collapsed ? activeTab?.view : undefined;
  const [paneMounted, setPaneMounted] = useState(false);
  const reduceMotion = useReducedMotion();
  useEffect(() => { if (view) setPaneMounted(true); }, [view]);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = scopeActive && !collapsed ? activeTab : undefined;
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  useEffect(() => onViewChange?.(view), [view, onViewChange]);
  useEffect(() => onTabsChange?.(openTabs.length > 0), [openTabs.length, onTabsChange]);
  useEffect(() => () => {
    for (const tab of openTabsRef.current) if (tab.view === "terminal") closeDockTerminalResource(tab.id);
  }, []);
  const [launcherOpen, setLauncherOpen] = useState(false);
  useSelectedTextSideChat(sessionId, openTabs, activeTabId, (id) => { setActiveTabId(id); setLauncherOpen(false); setCollapsed(false); });
  useEffect(() => {
    const sessions = Object.values(sideChats).filter((session) => session.sideChat?.parentSessionId === sessionId);
    const known = new Set(openTabsRef.current.filter((tab) => tab.view === "sideChat").map((tab) => tab.id));
    const added = sessions.filter((session) => !known.has(session.id));
    setOpenTabs((tabs) => [
      ...tabs.filter((tab) => tab.view !== "sideChat" || Boolean(sideChats[tab.id])),
      ...added.map((session) => ({ id: session.id, view: "sideChat" as const, workspaceId: session.workspaceId })),
    ]);
    if (added.length) {
      setActiveTabId(added.at(-1)!.id); setLauncherOpen(false); setCollapsed(false);
    } else {
      setActiveTabId((selected) => {
        const index = openTabsRef.current.findIndex((tab) => tab.id === selected && tab.view === "sideChat" && !sideChats[tab.id]);
        if (index < 0) return selected;
        const remaining = openTabsRef.current.filter((tab) => tab.view !== "sideChat" || Boolean(sideChats[tab.id]));
        return remaining[Math.max(0, index - 1)]?.id;
      });
    }
  }, [sideChats, sessionId]);
  useEffect(() => { if (!scopeActive) setLauncherOpen(false); }, [scopeActive]);
  useEffect(() => setSelectedSubagentId(undefined), [sessionId]);
  const [terminalStatus, setTerminalStatus] = useState<Record<string, { status: "starting" | "ready" | "exited" | "error"; detail?: string }>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(() => typeof window === "undefined" ? 0 : window.innerWidth);
  const [availableHeight, setAvailableHeight] = useState(() => typeof window === "undefined" ? 0 : window.innerHeight);
  const preferredWidth = usePaneSizes((state) => state.dockWidth);
  const saveWidth = usePaneSizes((state) => state.setDockWidth);
  const migrateDockWidth = usePaneSizes((state) => state.migrateDockWidth);
  const [dragWidth, setDragWidth] = useState<number>();
  const [maximized, setMaximized] = useState(() => storedScope?.maximized ?? false);
  const [isNarrowScreen, setIsNarrowScreen] = useState(() => typeof window !== "undefined" && window.innerWidth <= NARROW_SCREEN_WIDTH);
  const panelW = clampDockWidth(dragWidth ?? preferredWidth ?? defaultDockWidth(availableWidth, availableHeight, isNarrowScreen), availableWidth, isNarrowScreen);
  const { minimum: minPanelW, maximum: maxPanelW } = dockWidthBounds(availableWidth, isNarrowScreen);

  useEffect(() => {
    updateDock(scopeKey, { sessionId, workspaceId }, (scope) => ({ ...scope, openTabs }));
  }, [scopeKey, sessionId, workspaceId, openTabs, updateDock]);
  useEffect(() => {
    updateDock(scopeKey, { sessionId, workspaceId }, (scope) => ({ ...scope, activeTabId }));
  }, [scopeKey, sessionId, workspaceId, activeTabId, updateDock]);
  useEffect(() => {
    updateDock(scopeKey, { sessionId, workspaceId }, (scope) => ({ ...scope, collapsed }));
  }, [scopeKey, sessionId, workspaceId, collapsed, updateDock]);
  useEffect(() => {
    updateDock(scopeKey, { sessionId, workspaceId }, (scope) => ({ ...scope, maximized }));
  }, [scopeKey, sessionId, workspaceId, maximized, updateDock]);

  useEffect(() => {
    if (!scopeActive) return;
    const container = panelRef.current?.parentElement;
    if (!container) return undefined;
    const measure = () => {
      const fullWidth = container.clientWidth;
      const sidebarWidth = window.innerWidth <= NARROW_SCREEN_WIDTH
        ? 0
        : container.querySelector<HTMLElement>(".q-sidebar-pane")?.offsetWidth ?? 0;
      setAvailableWidth(Math.max(0, fullWidth - sidebarWidth));
      setAvailableHeight(container.clientHeight);
      setIsNarrowScreen(window.innerWidth <= NARROW_SCREEN_WIDTH);
      migrateDockWidth(Math.max(0, fullWidth - sidebarWidth), container.clientHeight, window.innerWidth <= NARROW_SCREEN_WIDTH);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    const sidebar = container.querySelector<HTMLElement>(".q-sidebar-pane");
    if (sidebar) observer.observe(sidebar);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [scopeActive, migrateDockWidth]);
  const terminalApiRefs = useRef(new Map<string, MutableRefObject<TerminalApi | undefined>>());
  const getTerminalApiRef = (tabId: string) => {
    let ref = terminalApiRefs.current.get(tabId);
    if (!ref) {
      ref = { current: undefined };
      terminalApiRefs.current.set(tabId, ref);
    }
    return ref;
  };
  const onTerminalStatus = useCallback((tabId: string, status: "starting" | "ready" | "exited" | "error", detail?: string) => {
    if (!openTabsRef.current.some((tab) => tab.id === tabId)) return;
    setTerminalStatus((current) => ({ ...current, [tabId]: { status, detail } }));
  }, []);

  useEffect(() => onOpenBrowserInDock((target) => {
    if (target.sessionId ? target.sessionId !== sessionId : !scopeActive) return;
    setLauncherOpen(false);
    if (target.requestId && activeTabRef.current?.view === "browser" && activeTabRef.current.browserTarget?.requestId === target.requestId) {
      setCollapsed(true);
      return;
    }
    const tab = { id: rid(), view: "browser" as const, browserTarget: target };
    setOpenTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    setCollapsed(false);
  }), [scopeActive, sessionId]);

  useEffect(() => {
    if (!scopeActive) return;
    const showSubagents = (event: Event) => {
      const target = (event as CustomEvent<{ runId?: string; sessionId?: string }>).detail;
      if (target?.sessionId && target.sessionId !== sessionId) return;
      setLauncherOpen(false);
      setSelectedSubagentId(target?.runId);

      const existingTab = openTabsRef.current.find((tab) => tab.view === "subagents");
      if (existingTab) {
        setActiveTabId(existingTab.id);
        setCollapsed(false);
        return;
      }

      const tab = { id: rid(), view: "subagents" as const };
      setOpenTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
      setCollapsed(false);
    };
    window.addEventListener(OPEN_SUBAGENT_EVENT, showSubagents);
    return () => window.removeEventListener(OPEN_SUBAGENT_EVENT, showSubagents);
  }, [scopeActive, sessionId]);

  useEffect(() => {
    if (!scopeActive) return;
    const showFile = (event: Event) => {
      const target = (event as CustomEvent<WorkspaceFileTarget>).detail;
      if (!target || (target.sessionId && target.sessionId !== sessionId) || (target.workspaceId && target.workspaceId !== workspaceId)) return;
      const tab = filePreviewTab(openTabsRef.current, { ...target, workspaceId: target.workspaceId ?? workspaceId }, rid);
      setLauncherOpen(false);
      setOpenTabs((tabs) => tabs.some((item) => item.id === tab.id) ? tabs.map((item) => item.id === tab.id ? tab : item) : [...tabs, tab]);
      setActiveTabId(tab.id);
      setCollapsed(false);
    };
    window.addEventListener(OPEN_WORKSPACE_FILE_EVENT, showFile);
    return () => window.removeEventListener(OPEN_WORKSPACE_FILE_EVENT, showFile);
  }, [scopeActive, sessionId, workspaceId]);

  useEffect(() => {
    if (!scopeActive) return;
    const showChanges = (event: Event) => {
      const target = (event as CustomEvent<RunChangesTarget>).detail;
      if (!target || target.sessionId !== sessionId) return;
      const tab = runChangesTab(openTabsRef.current, target, rid);
      setOpenTabs((tabs) => tabs.some((item) => item.id === tab.id) ? tabs.map((item) => item.id === tab.id ? tab : item) : [...tabs, tab]);
      setActiveTabId(tab.id);
      setLauncherOpen(false);
      setCollapsed(false);
    };
    window.addEventListener(OPEN_RUN_CHANGES_EVENT, showChanges);
    return () => window.removeEventListener(OPEN_RUN_CHANGES_EVENT, showChanges);
  }, [scopeActive, sessionId]);

  const { dragging, startResize, cancelResize } = usePaneResize({
    direction: -1,
    getSize: () => maximized ? availableWidth : panelW,
    onSize: (rawWidth) => {
      const next = dockResizeState(rawWidth, availableWidth, isNarrowScreen);
      setCollapsed(!next.open);
      setMaximized(next.fullWidth);
      if (next.open && !next.fullWidth) setDragWidth(next.width);
    },
    onEnd: (rawWidth) => {
      const next = dockResizeState(rawWidth, availableWidth, isNarrowScreen);
      if (next.open && !next.fullWidth) saveWidth(next.width);
    },
    onFinish: () => setDragWidth(undefined),
  });
  const animatedWidth = usePaneMotion({
    open: Boolean(view), size: maximized ? availableWidth : panelW,
    transition: DOCK_VISIBILITY_TRANSITION, immediate: !scopeActive || Boolean(reduceMotion),
    animateSize: !dragging || maximized,
  });
  useMotionValueEvent(animatedWidth, "change", (width) => {
    if (width === 0 && !view) setPaneMounted(false);
  });
  useEffect(() => { if (!scopeActive) cancelResize(); }, [scopeActive]);
  useLayoutEffect(() => {
    if (!scopeActive) return;
    const container = panelRef.current?.parentElement;
    const chat = container?.querySelector<HTMLElement>(".q-chat-shell");
    if (!container || !chat) return;
    const fullWidth = Boolean(view && maximized && !isNarrowScreen);
    if (fullWidth) container.dataset.dockMaximized = "true";
    else delete container.dataset.dockMaximized;
    chat.inert = fullWidth;
    return () => { delete container.dataset.dockMaximized; chat.inert = false; };
  }, [scopeActive, view, maximized, isNarrowScreen]);

  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let width: number;
    switch (event.key) {
      case "ArrowLeft": width = panelW + 10; break;
      case "ArrowRight": width = panelW - 10; break;
      case "Home": width = minPanelW; break;
      case "End": width = maxPanelW; break;
      default: return;
    }
    event.preventDefault();
    saveWidth(clampDockWidth(width, availableWidth, isNarrowScreen));
  };

  useEffect(() => {
    if (view) return;
    setLauncherOpen(false);
  }, [view]);

  const activateTab = (tabId: string) => {
    setLauncherOpen(false);
    setActiveTabId(tabId);
    setCollapsed(false);
  };

  const openTab = (next: DockView, browserTarget?: BrowserDockRequest) => {
    setLauncherOpen(false);
    const tab: DockTab = { id: rid(), view: next, workspaceId, browserTarget: next === "browser" ? browserTarget ?? { url: "https://www.bing.com" } : undefined };
    setOpenTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    setCollapsed(false);
  };

  const closingSideChats = useRef(new Set<string>());
  const closeTab = async (closingId: string): Promise<boolean> => {
    const session = useStore.getState().sideChats[closingId];
    if (session) {
      if (closingSideChats.current.has(closingId)) return false;
      closingSideChats.current.add(closingId);
      try {
        if (!await confirmDestructiveAction(t("chat.sideChatCloseConfirm"))) return false;
        if (!await closeSideConversation(session)) return false;
      } catch (error) { useStore.setState({ lastError: localizeError(error) }); return false; }
      finally { closingSideChats.current.delete(closingId); }
    }
    const tabs = openTabsRef.current;
    const closingIndex = tabs.findIndex((tab) => tab.id === closingId);
    if (closingIndex < 0) return true;
    const remaining = tabs.filter((tab) => tab.id !== closingId);
    setLauncherOpen(false);
    openTabsRef.current = remaining;
    setOpenTabs((current) => current.filter((tab) => tab.id !== closingId));
    if (tabs[closingIndex]?.view === "terminal") closeDockTerminalResource(closingId);
    terminalApiRefs.current.delete(closingId);
    setTerminalStatus((current) => {
      const next = { ...current };
      delete next[closingId];
      return next;
    });
    setActiveTabId((selected) => selected === closingId ? remaining[Math.max(0, closingIndex - 1)]?.id : selected);
    return true;
  };

  const closingBatch = useRef(false);
  const closeTabs = async (anchorId: string, mode: "other" | "right") => {
    if (closingBatch.current || !openTabsRef.current.some((tab) => tab.id === anchorId)) return;
    closingBatch.current = true;
    try {
      if (mode === "other") activateTab(anchorId);
      await (mode === "other" ? closeDockTabsExcept : closeDockTabsToRight)(openTabsRef.current, anchorId, closeTab);
    } finally { closingBatch.current = false; }
  };

  const closePanel = () => {
    setLauncherOpen(false);
    setCollapsed(true);
    setMaximized(false);
  };

  useEffect(() => {
    if (!scopeActive) return;
    const toggleDockView = (event: Event) => {
      const requestedView = (event as CustomEvent<unknown>).detail;
      if (!isDockView(requestedView)) return;
      openTab(requestedView);
    };
    const toggleDockPanel = () => {
      setLauncherOpen(false);
      if (activeTabId) {
        if (!collapsed) setMaximized(false);
        setCollapsed((current) => !current);
        return;
      }
      const fallbackTab = openTabs.at(-1);
      if (fallbackTab) {
        setActiveTabId(fallbackTab.id);
        setCollapsed(false);
        return;
      }
      const tab = { id: rid(), view: "session" as const, workspaceId };
      setOpenTabs([tab]);
      setActiveTabId(tab.id);
      setCollapsed(false);
    };
    window.addEventListener("qone-toggle-dock-view", toggleDockView);
    window.addEventListener("qone-toggle-dock-panel", toggleDockPanel);
    return () => {
      window.removeEventListener("qone-toggle-dock-view", toggleDockView);
      window.removeEventListener("qone-toggle-dock-panel", toggleDockPanel);
    };
  }, [activeTabId, openTabs, collapsed, scopeActive, workspaceId]);

  const tabMeta: Record<DockView, { icon: LucideIcon; label: string }> = {
    sideChat: { icon: BotMessageSquareIcon, label: t("chat.sideChat") },
    session: { icon: ListTodoIcon, label: t("dock.session") },
    terminal: { icon: SquareTerminalIcon, label: t("dock.terminal") },
    files: { icon: FolderTreeIcon, label: t("dock.files") },
    file: { icon: FileIcon, label: t("dock.file") },
    git: { icon: GitBranchIcon, label: t("dock.git") },
    changes: { icon: GitBranchIcon, label: t("dock.changes") },
    browser: { icon: GlobeIcon, label: t("dock.browser") },
    mcp: { icon: PlugIcon, label: t("dock.mcp") },
    skills: { icon: WandSparklesIcon, label: t("dock.skills") },
    subagents: { icon: BotMessageSquareIcon, label: t("nav.subagents") },
  };

  return (
    <Popover.Root open={scopeActive && launcherOpen} onOpenChange={setLauncherOpen}>
      {scopeActive && view && isNarrowScreen && (
        <div
          role="presentation"
          onClick={closePanel}
          className="fixed inset-0 z-35 bg-black/40 backdrop-blur-xs transition-opacity"
        />
      )}
      <motion.div
        ref={panelRef}
        className={cn(
          "q-workspace-dock flex h-full shrink-0 justify-end overflow-visible bg-background",
          isNarrowScreen
            ? "fixed inset-y-0 right-0 z-40 shadow-2xl"
            : "relative z-20",
          view || paneMounted || dragging ? "visible" : "invisible",
          view || dragging ? "pointer-events-auto" : "pointer-events-none",
        )}
        style={{ width: animatedWidth }}
        inert={!view && !dragging}
        aria-hidden={!view && !dragging}
      >
        {openTabs.length > 0 && <>
          {(!maximized || dragging) && <div
            role="separator"
            aria-label={t("dock.resizePanel")}
            aria-orientation="vertical"
            aria-valuemin={minPanelW}
            aria-valuemax={maxPanelW}
            aria-valuenow={panelW}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={onResizeKeyDown}
            onDoubleClick={() => {
              cancelResize();
              setDragWidth(undefined);
              saveWidth(defaultDockWidth(availableWidth, availableHeight, isNarrowScreen));
            }}
            className="q-workspace-dock-resizer"
          ><span /></div>}
          <div className="q-workspace-dock-clip h-full w-full overflow-hidden" inert={!view} aria-hidden={!view}>
          <div className="q-workspace-dock-frame flex h-full min-w-0 shrink-0 flex-col" style={{ width: maximized ? availableWidth : panelW }}>
          <div className="q-workspace-dock-tabbar flex shrink-0 items-center gap-1 bg-background">
            <div
              role="tablist"
              aria-label={t("dock.openWindow")}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End", "Delete"].includes(event.key)) return;
                const current = event.target as HTMLElement;
                const selected = current.closest<HTMLElement>("[data-dock-tab]")?.dataset.dockTab;
                const index = selected ? openTabs.findIndex((tab) => tab.id === selected) : -1;
                if (index < 0) return;
                if (event.key === "Delete") {
                  event.preventDefault();
                  closeTab(selected!);
                  return;
                }
                const next = event.key === "Home" ? 0 : event.key === "End" ? openTabs.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : -1) + openTabs.length) % openTabs.length;
                const nextTab = openTabs[next];
                if (!nextTab) return;
                event.preventDefault();
                activateTab(nextTab.id);
                event.currentTarget.querySelector<HTMLElement>(`[data-dock-tab="${nextTab.id}"] [role="tab"]`)?.focus();
              }}
              onWheel={(e) => {
                e.currentTarget.scrollLeft += e.deltaY + e.deltaX;
              }}
              className="q-workspace-dock-tabs flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {openTabs.map((tab, index) => {
                const { icon: Icon, label } = tabMeta[tab.view];
                const active = activeTabId === tab.id;
                const duplicateCount = openTabs.filter((item) => item.view === tab.view).length;
                const fileName = tab.fileTarget?.path.split(/[\\/]/).at(-1);
                const workspace = workspaces.find((item) => item.id === (tab.workspaceId ?? workspaceId));
                const tabBaseLabel = tab.view === "sideChat" ? sideChats[tab.id]?.title ?? label : tab.view === "file" && fileName ? fileName : tab.view === "terminal" && workspace?.path ? workspace.path : label;
                const tabLabel = tab.view !== "file" && duplicateCount > 1 ? `${tabBaseLabel} ${openTabs.slice(0, index + 1).filter((item) => item.view === tab.view).length}` : tabBaseLabel;
                const terminalState = terminalStatus[tab.id]?.status ?? "starting";
                return (
                  <DockTabContextMenu
                    key={tab.id}
                    onClose={() => void closeTab(tab.id)}
                    onCloseOther={openTabs.length > 1 ? () => void closeTabs(tab.id, "other") : undefined}
                    onCloseRight={index < openTabs.length - 1 ? () => void closeTabs(tab.id, "right") : undefined}
                    filePath={tab.view === "file" && tab.fileTarget && !tab.fileTarget.attachment
                      ? resolveFileReferencePath(tab.fileTarget.path, workspace?.path) ?? tab.fileTarget.path
                      : undefined}
                  >
                    <div data-dock-tab={tab.id} className={cn("q-workspace-dock-tab group flex h-8 min-w-0 items-center rounded-lg", active && "is-active")}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        title={tabLabel}
                        onClick={() => activateTab(tab.id)}
                        tabIndex={active ? 0 : -1}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden ps-2.5 text-start"
                      >
                        {tab.view === "sideChat" ? <CodexIcon src={sideChatIcon} className="size-4 shrink-0 text-foreground/55" /> : tab.view === "terminal" ? <span className="q-dock-terminal-tab-icon relative flex size-4 shrink-0 items-center text-foreground/55" data-status={terminalState} title={terminalStatus[tab.id]?.detail}>
                          <CodexIcon src={terminalIcon} className="size-4" />
                        </span> : tab.view === "file" && tab.fileTarget
                          ? <CodexIcon src={attachmentFileIcon(tab.fileTarget.path, "")} className="size-4 shrink-0 text-foreground/55" />
                          : <Icon className="size-4 shrink-0 text-foreground/55" />}
                        <span className="truncate text-sm text-foreground/85">{tabLabel}</span>
                      </button>
                      <button type="button" aria-label={`${t("dock.closePanel")}: ${tabLabel}`} onClick={() => closeTab(tab.id)} className="q-workspace-dock-tab-close me-1 flex size-6 shrink-0 items-center justify-center rounded-md text-foreground/45 hover:bg-foreground/10 hover:text-foreground">
                        <CodexIcon src={closeIcon} className="size-3.5" />
                      </button>
                    </div>
                  </DockTabContextMenu>
                );
              })}
              <div className="relative shrink-0 ps-1.5">
                <Popover.Trigger asChild>
                  <TooltipIconButton
                    tooltip={t("dock.openWindow")}
                    aria-haspopup="menu"
                    className={cn("size-8 rounded-md text-foreground/45 hover:text-foreground", launcherOpen && "bg-foreground/10 text-foreground")}
                  >
                    <CodexIcon src={plusIcon} className="size-4" />
                  </TooltipIconButton>
                </Popover.Trigger>
              </div>
            </div>
            <div className="q-workspace-dock-actions flex shrink-0 items-center gap-0.5 ps-1">
              {view === "terminal" ? (
                <DockTerminalActions
                  onClear={() => { if (activeTabId) terminalApiRefs.current.get(activeTabId)?.current?.clear(); }}
                  onRestart={() => { if (activeTabId) terminalApiRefs.current.get(activeTabId)?.current?.restart(); }}
                />
              ) : null}
              {view === "files" || view === "file" || view === "git" || view === "mcp" || view === "skills" ? (
                  <TooltipIconButton tooltip={t("dock.refresh")} onClick={() => setOpenTabs((tabs) => tabs.map((tab) => tab.id === activeTabId ? { ...tab, refreshNonce: (tab.refreshNonce ?? 0) + 1 } : tab))} className="size-7">
                  <RefreshCwIcon className="size-3.5" />
                </TooltipIconButton>
              ) : null}
              <TooltipIconButton tooltip={t(maximized ? "dock.restorePanel" : "dock.expandPanel")} onClick={() => setMaximized((current) => !current)} aria-pressed={maximized} className="size-8">
                {maximized ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
              </TooltipIconButton>
              <TooltipIconButton tooltip={t("dock.closePanel")} onClick={closePanel} className="size-7">
                <PanelRightCloseIcon className="size-4" />
              </TooltipIconButton>
            </div>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {openTabs.map((tab) => {
              const active = scopeActive && !collapsed && activeTabId === tab.id;
              const needsWorkspace = tab.view === "files" || tab.view === "git" || tab.view === "terminal";
              const tabWorkspaceId = tab.workspaceId ?? workspaceId;
              return (
                <div key={tab.id} className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", active ? "flex flex-col" : "hidden")}>
                  {needsWorkspace && !tabWorkspaceId ? <p className="px-3 py-4 text-sm text-foreground/45">{t("dock.noWorkspace")}</p> : null}
                  {tab.view === "terminal" && tabWorkspaceId && <TerminalView tabId={tab.id} workspaceId={tabWorkspaceId} active={active} apiRef={getTerminalApiRef(tab.id)} onStatus={onTerminalStatus} />}
                  {tab.view === "browser" && <DockBrowserView browserId={tab.id} active={active && !launcherOpen && !dragging} initialUrl={tab.browserTarget?.url ?? "https://www.bing.com"} previewHtml={tab.browserTarget?.html} previewId={tab.browserTarget?.requestId} onClose={() => void closeTab(tab.id)} />}
                  {tab.view === "files" && tabWorkspaceId && <FilesView tabId={tab.id} workspaceId={tabWorkspaceId} refreshNonce={tab.refreshNonce ?? 0} fileTarget={tab.fileTarget} active={active} />}
                  {tab.view === "file" && tab.fileTarget && (tab.fileTarget.attachment
                    ? <InlineFileReader target={tab.fileTarget} active={active} refreshNonce={tab.refreshNonce ?? 0} />
                    : <FileReader tabId={tab.id} workspaceId={tab.workspaceId} sessionId={sessionId} target={tab.fileTarget} active={active} refreshNonce={tab.refreshNonce ?? 0} />)}
                  {tab.view === "git" && tabWorkspaceId && <GitView tabId={tab.id} workspaceId={tabWorkspaceId} refreshNonce={tab.refreshNonce ?? 0} />}
                  {active && tab.view === "changes" && tab.changesTarget && <RunChangesPanel target={tab.changesTarget} />}
                  {/* Keep one assistant-ui/Lexical tree alive; queue execution is session-scoped and survives tab unmounts. */}
                  {active && tab.view === "sideChat" && sideChats[tab.id] && <SideConversationPanel session={sideChats[tab.id]} />}
                  {active && tab.view === "mcp" && <DockMcpView refreshNonce={tab.refreshNonce ?? 0} />}
                  {active && tab.view === "skills" && <DockSkillsView workspaceId={tabWorkspaceId} refreshNonce={tab.refreshNonce ?? 0} />}
                  {active && tab.view === "subagents" && <SubagentPanel selectedId={selectedSubagentId} onSelect={setSelectedSubagentId} onClose={() => closeTab(tab.id)} />}
                  {active && tab.view === "session" && <SessionDetails />}
                </div>
              );
            })}
          </div>
          </div>
          </div>
        </>}
      </motion.div>
      <Popover.Portal>
        <Popover.Content side="bottom" align="end" sideOffset={8} collisionPadding={12} hideWhenDetached asChild>
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
            className="pointer-events-auto z-[1000] max-h-[min(280px,var(--radix-popover-content-available-height))] w-56 max-w-[var(--radix-popover-content-available-width)] overflow-y-auto overscroll-contain rounded-xl border border-border/60 bg-popover p-1.5 shadow-2xl"
            style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
          >
            <p className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-foreground/40">{t("dock.openWindow")}</p>
            {([
              { view: "terminal", icon: SquareTerminalIcon, label: t("dock.terminal"), detail: t("dock.terminalDescription") },
              { view: "browser", icon: GlobeIcon, label: t("dock.browser"), detail: t("dock.browserDescription") },
              { view: "files", icon: FolderTreeIcon, label: t("dock.files"), detail: t("dock.filesDescription") },
              { view: "git", icon: GitBranchIcon, label: t("dock.git"), detail: t("dock.gitDescription") },
              { view: "mcp", icon: PlugIcon, label: t("dock.mcp"), detail: t("dock.mcpDescription") },
              { view: "skills", icon: WandSparklesIcon, label: t("dock.skills"), detail: t("dock.skillsDescription") },
              { view: "subagents", icon: BotMessageSquareIcon, label: t("nav.subagents"), detail: t("dock.subagentsDescription") },
            ] as const).map(({ view: name, icon: Icon, label, detail }) => (
              <button
                key={name}
                type="button"
                role="menuitem"
                onClick={() => openTab(name)}
                className="pointer-events-auto flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start transition-colors hover:bg-foreground/[0.07]"
              >
                <Icon className="size-4 shrink-0 text-foreground/55" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-foreground/85">{label}</span>
                  <span className="block truncate text-[10.5px] text-foreground/40">{detail}</span>
                </span>
              </button>
            ))}
          </motion.div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
