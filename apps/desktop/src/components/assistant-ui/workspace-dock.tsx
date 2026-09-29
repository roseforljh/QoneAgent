"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
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
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WandSparklesIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import type { WorkspaceFileInfo, WorkspaceGitEntry } from "@qone/protocol";
import { useStore } from "../../store";
import { TooltipIconButton } from "./tooltip-icon-button";
import { DiffViewer } from "./elements/diff-viewer";
import { SyntaxHighlighter } from "./elements/shiki-highlighter";
import { DockBrowserView, DockMcpView, DockSkillsView } from "./dock-extra-views";
import { FadeScroll, mono } from "./elements/surfaces";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { onOpenBrowserInDock, type BrowserDockRequest } from "../../lib/browser-dock";
import { SubagentPanel } from "./subagent-view";
import { clampDockWidth, defaultDockWidth, DOCK_WIDTH_STORAGE_KEY, dockWidthBounds, dockWidthFromRatio, dockWidthRatio } from "../../lib/dock-layout";
import TerminalView, { type TerminalApi } from "./dock-terminal-view";
import "./workspace-dock.css";

type DockView = "session" | "terminal" | "files" | "git" | "browser" | "mcp" | "skills" | "subagents";
type DockTab = { id: string; view: DockView; browserTarget?: BrowserDockRequest };
const DOCK_VIEWS: readonly DockView[] = ["session", "terminal", "files", "git", "browser", "mcp", "skills", "subagents"];
const isDockView = (value: unknown): value is DockView =>
  typeof value === "string" && DOCK_VIEWS.some((view) => view === value);

const rid = () => crypto.randomUUID();

function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (["dockerfile", "makefile"].includes(name)) return "shellscript";
  const extension = name.includes(".") ? name.split(".").pop()! : "text";
  const aliases: Record<string, string> = {
    js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", json: "json",
    css: "css", scss: "scss", html: "html", xml: "xml", md: "markdown",
    py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", sh: "shellscript",
    bash: "shellscript", ps1: "powershell", yaml: "yaml", yml: "yaml", toml: "toml",
    sql: "sql", vue: "vue", svelte: "svelte",
  };
  return aliases[extension] ?? "text";
}

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

function buildTree(files: readonly WorkspaceFileInfo[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const ensureDir = (parent: TreeNode[], name: string, path: string): TreeNode => {
    let node = parent.find((item) => item.name === name && item.dir);
    if (!node) {
      node = { name, path, dir: true, children: [] };
      parent.push(node);
    }
    return node;
  };
  for (const file of files) {
    const segments = file.path.split(/[\\/]/).filter(Boolean);
    let level = roots;
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      const last = index === segments.length - 1;
      if (last && file.kind === "file") {
        if (!level.some((n) => n.name === segment && !n.dir)) level.push({ name: segment, path, dir: false, children: [] });
      } else {
        level = ensureDir(level, segment, path).children;
      }
    });
  }
  const sortLevel = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    for (const node of nodes) sortLevel(node.children);
  };
  sortLevel(roots);
  return roots;
}

function TreeRows({
  nodes,
  depth,
  expanded,
  onToggle,
  onOpen,
}: {
  nodes: TreeNode[];
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.path}>
          <button
            type="button"
            onClick={() => (node.dir ? onToggle(node.path) : onOpen(node.path))}
            className="text-foreground/75 hover:bg-foreground/[0.05] hover:text-foreground flex w-full min-w-0 items-center gap-1.5 py-1 pe-2 text-start text-sm transition-colors"
            style={{ paddingInlineStart: `${10 + depth * 14}px` }}
          >
            {node.dir ? (
              <ChevronRightIcon className={cn("size-3 shrink-0 text-foreground/40 transition-transform duration-150", expanded.has(node.path) && "rotate-90")} />
            ) : (
              <span className="size-3 shrink-0" />
            )}
            {node.dir ? (
              <FolderIcon className="size-3.5 shrink-0 text-sky-500/80 dark:text-sky-400/80" />
            ) : (
              <FileIcon className="size-3.5 shrink-0 text-foreground/40" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {node.dir && expanded.has(node.path) && (
            <TreeRows nodes={node.children} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
          )}
        </div>
      ))}
    </>
  );
}

function FilesView({ workspaceId, refreshNonce }: { workspaceId: string; refreshNonce: number }) {
  const { t } = useLocale();
  const send = useStore((s) => s.send);
  const files = useStore((s) => s.workspaceFiles);
  const openFile = useStore((s) => s.openFile);
  const connected = useStore((s) => s.connected);
  const capabilities = useStore((s) => s.runtimeCapabilities);
  const workspaceError = useStore((s) => s.workspaceError);
  const [selected, setSelected] = useState<string>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loadedDirectories, setLoadedDirectories] = useState<ReadonlySet<string>>(new Set());
  const initializedTree = useRef(false);
  const tree = useMemo(() => buildTree(files), [files]);
  const unsupported = connected && !capabilities.includes("workspace.files");

  useEffect(() => {
    setSelected(undefined);
    setExpanded(new Set());
    setLoadedDirectories(new Set());
    initializedTree.current = false;
    useStore.setState({ workspaceFiles: [], openFile: undefined, workspaceError: undefined });
    if (!unsupported) send({ type: "workspace.files", requestId: rid(), workspaceId });
  }, [workspaceId, send, unsupported, refreshNonce]);

  useEffect(() => {
    if (!tree.length || initializedTree.current) return;
    initializedTree.current = true;
    const directories = tree.filter((node) => node.dir).map((node) => node.path);
    setExpanded(new Set(directories));
    if (directories.length) {
      setLoadedDirectories(new Set(directories));
      for (const path of directories) send({ type: "workspace.files", requestId: rid(), workspaceId, path });
    }
  }, [tree, send, workspaceId]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!loadedDirectories.has(path)) {
      setLoadedDirectories((prev) => new Set(prev).add(path));
      send({ type: "workspace.files", requestId: rid(), workspaceId, path });
    }
  };

  const open = (path: string) => {
    setSelected(path);
    useStore.setState({ workspaceError: undefined });
    if (openFile?.path !== path || openFile.workspaceId !== workspaceId) {
      useStore.setState({ openFile: undefined });
      send({ type: "file.read", requestId: rid(), workspaceId, path });
    }
  };

  if (unsupported) return <p className="px-3 py-4 text-sm text-foreground/55">{t("dock.runtimeOutdated")}</p>;

  if (selected) {
    const content = openFile?.workspaceId === workspaceId && openFile.path === selected ? openFile.content : undefined;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setSelected(undefined)}
          className="text-foreground/60 hover:text-foreground hover:bg-foreground/[0.05] flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-2 text-start text-[12.5px] transition-colors"
        >
          <ArrowLeftIcon className="size-3.5 shrink-0" />
          <span className={cn(mono, "truncate")}>{selected}</span>
        </button>
        <FadeScroll className="min-h-0 flex-1">
          {workspaceError ? <p className="px-3 py-3 text-sm text-red-500/80">{workspaceError}</p> : content === undefined ? (
            <p className="px-3 py-3 text-sm text-foreground/50">{t("dock.fileLoading")}</p>
          ) : (
            <SyntaxHighlighter
              code={content}
              language={languageForPath(selected)}
              className="min-h-full [&_pre]:m-0! [&_pre]:rounded-none! [&_pre]:border-0! [&_pre]:bg-transparent! [&_pre]:px-3! [&_pre]:py-2.5! [&_pre]:text-xs! [&_pre]:leading-relaxed"
            />
          )}
        </FadeScroll>
      </div>
    );
  }

  if (workspaceError) return <p className="px-3 py-4 text-sm text-red-500/80">{workspaceError}</p>;
  if (!files.length) return <p className="px-3 py-4 text-sm text-foreground/45">{t("dock.filesEmpty")}</p>;

  return (
    <FadeScroll className="min-h-0 flex-1 py-1.5">
      <TreeRows nodes={tree} depth={0} expanded={expanded} onToggle={toggle} onOpen={open} />
    </FadeScroll>
  );
}

const GIT_STATUS_COLORS: Record<string, string> = {
  M: "text-amber-600 dark:text-amber-400",
  A: "text-emerald-600 dark:text-emerald-400",
  "??": "text-emerald-600 dark:text-emerald-400",
  D: "text-red-600 dark:text-red-400",
  R: "text-blue-600 dark:text-blue-400",
  U: "text-red-600 dark:text-red-400",
};

function parseGitStatus(text: string): { code: string; path: string }[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => {
      const code = line.slice(0, 2).trim() || "M";
      let path = line.slice(2).trim();
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4);
      return { code, path: path.replace(/^"|"$/g, "") };
    });
}

function GitView({ workspaceId, refreshNonce }: { workspaceId: string; refreshNonce: number }) {
  const { t } = useLocale();
  const send = useStore((s) => s.send);
  const gitStatus = useStore((s) => s.gitStatus);
  const gitEntries = useStore((s) => s.gitEntries);
  const gitLoaded = useStore((s) => s.gitLoaded);
  const connected = useStore((s) => s.connected);
  const capabilities = useStore((s) => s.runtimeCapabilities);
  const workspaceError = useStore((s) => s.workspaceError);
  const diffView = useStore((s) => s.gitDiffView);
  const [selected, setSelected] = useState<string>();
  const entries = useMemo<WorkspaceGitEntry[]>(() => gitEntries.length ? gitEntries : parseGitStatus(gitStatus), [gitEntries, gitStatus]);
  const unsupported = connected && !capabilities.includes("workspace.git");

  useEffect(() => {
    setSelected(undefined);
    useStore.setState({ gitStatus: "", gitEntries: [], gitLoaded: false, gitDiffView: undefined, workspaceError: undefined });
    if (!unsupported) send({ type: "workspace.git", requestId: rid(), workspaceId });
  }, [workspaceId, send, unsupported, refreshNonce]);

  const open = (path: string) => {
    setSelected(path);
    useStore.setState({ workspaceError: undefined });
    if (diffView?.path !== path || diffView.workspaceId !== workspaceId) {
      useStore.setState({ gitDiffView: undefined });
      send({ type: "workspace.gitDiff", requestId: rid(), workspaceId, path, scope: "unstaged" });
    }
  };

  if (unsupported) return <p className="px-3 py-4 text-sm text-foreground/55">{t("dock.runtimeOutdated")}</p>;

  if (selected) {
    const diff = diffView?.workspaceId === workspaceId && diffView.path === selected ? diffView.diff : undefined;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setSelected(undefined)}
          className="text-foreground/60 hover:text-foreground hover:bg-foreground/[0.05] flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-2 text-start text-[12.5px] transition-colors"
        >
          <ArrowLeftIcon className="size-3.5 shrink-0" />
          <span className={cn(mono, "truncate")}>{selected}</span>
        </button>
        <FadeScroll className="min-h-0 flex-1 px-2 py-2">
          {workspaceError ? <p className="px-1 py-1 text-sm text-red-500/80">{workspaceError}</p> : diff === undefined ? (
            <p className="px-1 py-1 text-xs text-foreground/50">{t("dock.fileLoading")}</p>
          ) : diff.trim() ? (
            <DiffViewer patch={diff} language={languageForPath(selected)} showIcon showStats size="default" className="min-w-full" />
          ) : (
            <p className="px-1 py-1 text-xs text-foreground/50">not a git-tracked change</p>
          )}
        </FadeScroll>
      </div>
    );
  }

  if (workspaceError) return <p className="px-3 py-4 text-sm text-red-500/80">{workspaceError}</p>;
  if (!gitLoaded) return <p className="px-3 py-4 text-sm text-foreground/45">{t("dock.gitLoading")}</p>;
  if (!entries.length) {
    return <p className="px-3 py-3 text-sm text-foreground/45">{t("dock.gitClean")}</p>;
  }

  return (
    <FadeScroll className="min-h-0 flex-1 py-1.5">
      {entries.map((entry) => (
        <button
          key={`${entry.code}:${entry.path}`}
          type="button"
          onClick={() => open(entry.path)}
          className="text-foreground/75 hover:bg-foreground/[0.05] hover:text-foreground flex w-full min-w-0 items-center gap-2 px-3 py-1 text-start text-sm transition-colors"
        >
          <span className={cn(mono, "w-5 shrink-0 text-center", GIT_STATUS_COLORS[entry.code] ?? "text-foreground/45")}>
            {entry.code === "??" ? "U" : entry.code}
          </span>
          <span className="truncate">{entry.path}</span>
        </button>
      ))}
    </FadeScroll>
  );
}

const PANEL_TRANSITION = "width 0.25s cubic-bezier(0.32,0.72,0,1)";
const NARROW_SCREEN_WIDTH = 960;

function readSavedDockRatio(): number | undefined {
  try {
    const value = Number(window.localStorage.getItem(DOCK_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) && value >= 0 && value <= 1 && window.localStorage.getItem(DOCK_WIDTH_STORAGE_KEY) !== null
      ? value : undefined;
  } catch {
    return undefined;
  }
}

function SessionDetails() {
  const { locale, t } = useLocale();
  const session = useStore((state) => state.sessions.find((item) => item.id === state.currentSessionId));
  const workspace = useStore((state) => state.workspaces.find((item) => item.id === session?.workspaceId));
  const messageCount = useStore((state) => state.messages.length);
  if (!session) return <p className="px-4 py-5 text-sm text-muted-foreground">{t("dock.sessionEmpty")}</p>;

  const formatDate = (timestamp: number) => new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-5" aria-label={t("dock.session")}>
      <h2 className="break-words text-base font-semibold text-foreground">{session.title}</h2>
      <dl className="mt-6 grid gap-4 text-sm">
        {workspace && <div><dt className="text-muted-foreground">{t("sidebar.projects")}</dt><dd className="mt-1 break-words text-foreground">{workspace.name}</dd></div>}
        <div><dt className="text-muted-foreground">{t("dock.sessionMessages")}</dt><dd className="mt-1 text-foreground">{messageCount}</dd></div>
        <div><dt className="text-muted-foreground">{t("dock.sessionCreated")}</dt><dd className="mt-1 text-foreground">{formatDate(session.createdAt)}</dd></div>
        <div><dt className="text-muted-foreground">{t("dock.sessionUpdated")}</dt><dd className="mt-1 text-foreground">{formatDate(session.updatedAt)}</dd></div>
      </dl>
    </section>
  );
}

export function WorkspaceDock({ onViewChange }: { onViewChange?: (view: DockView | undefined) => void }) {
  const { t } = useLocale();
  const workspaceId = useStore((s) => s.currentWorkspaceId);
  const workspacePath = useStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId)?.path);
  const [openTabs, setOpenTabs] = useState<DockTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const activeTab = openTabs.find((tab) => tab.id === activeTabId);
  const view = collapsed ? undefined : activeTab?.view;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = collapsed ? undefined : activeTab;
  useEffect(() => onViewChange?.(view), [view, onViewChange]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<Record<string, { status: "starting" | "ready" | "exited" | "error"; detail?: string }>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(() => typeof window === "undefined" ? 0 : window.innerWidth);
  const [availableHeight, setAvailableHeight] = useState(() => typeof window === "undefined" ? 0 : window.innerHeight);
  const [savedWidthRatio, setSavedWidthRatio] = useState(readSavedDockRatio);
  const [dragWidth, setDragWidth] = useState<number>();
  const [dragging, setDragging] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [isNarrowScreen, setIsNarrowScreen] = useState(() => typeof window !== "undefined" && window.innerWidth <= NARROW_SCREEN_WIDTH);
  const panelW = dragWidth ?? dockWidthFromRatio(savedWidthRatio, availableWidth, availableHeight, isNarrowScreen);
  const { minimum: minPanelW, maximum: maxPanelW } = dockWidthBounds(availableWidth, isNarrowScreen);

  useEffect(() => {
    const container = panelRef.current?.parentElement;
    if (!container) return undefined;
    const measure = () => {
      setAvailableWidth(container.getBoundingClientRect().width);
      setAvailableHeight(container.getBoundingClientRect().height);
      setIsNarrowScreen(window.innerWidth <= NARROW_SCREEN_WIDTH);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const launcherRef = useRef<HTMLDivElement>(null);
  const launcherMenuRef = useRef<HTMLDivElement>(null);
  const [launcherPosition, setLauncherPosition] = useState<{ top: number; right: number }>();
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
    setTerminalStatus((current) => ({ ...current, [tabId]: { status, detail } }));
  }, []);

  useEffect(() => onOpenBrowserInDock((target) => {
    setLauncherOpen(false);
    if (target.requestId && activeTabRef.current?.view === "browser" && activeTabRef.current.browserTarget?.requestId === target.requestId) {
      setCollapsed(true);
      return;
    }
    const tab = { id: rid(), view: "browser" as const, browserTarget: target };
    setOpenTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    setCollapsed(false);
  }), []);

  useEffect(() => {
    const toggleSubagents = () => {
      setLauncherOpen(false);
      const tab = { id: rid(), view: "subagents" as const };
      setOpenTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
      setCollapsed(false);
    };
    window.addEventListener("qone-open-subagents", toggleSubagents);
    return () => window.removeEventListener("qone-open-subagents", toggleSubagents);
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      const rightEdge = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      setDragWidth(clampDockWidth(rightEdge - ev.clientX, availableWidth, isNarrowScreen));
    };
    const done = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      const rightEdge = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      const width = clampDockWidth(rightEdge - ev.clientX, availableWidth, isNarrowScreen);
      saveWidth(width);
      setDragWidth(undefined);
      setDragging(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  };

  const saveWidth = (width: number) => {
    const ratio = dockWidthRatio(width, availableWidth, isNarrowScreen);
    setSavedWidthRatio(ratio);
    try { window.localStorage.setItem(DOCK_WIDTH_STORAGE_KEY, String(ratio)); } catch { /* unavailable storage */ }
  };

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
    if (!launcherOpen) return undefined;
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const path = event.composedPath();
      const inside = (element: HTMLElement | null) => Boolean(
        element && (path.includes(element) || (target && element.contains(target))),
      );
      if (!inside(launcherRef.current) && !inside(launcherMenuRef.current)) setLauncherOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [launcherOpen]);

  useEffect(() => {
    if (!launcherOpen) {
      setLauncherPosition(undefined);
      return undefined;
    }
    const update = () => {
      const rect = launcherRef.current?.getBoundingClientRect();
      if (!rect) return;
      setLauncherPosition({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [launcherOpen]);

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
    const tab: DockTab = { id: rid(), view: next, browserTarget: next === "browser" ? browserTarget ?? { url: "https://www.bing.com" } : undefined };
    setOpenTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    setCollapsed(false);
  };

  const closeTab = (closingId: string) => {
    const closingIndex = openTabs.findIndex((tab) => tab.id === closingId);
    if (closingIndex < 0) return;
    const remaining = openTabs.filter((tab) => tab.id !== closingId);
    setLauncherOpen(false);
    setOpenTabs(remaining);
    terminalApiRefs.current.delete(closingId);
    setTerminalStatus((current) => {
      const next = { ...current };
      delete next[closingId];
      return next;
    });
    if (activeTabId === closingId) {
      setActiveTabId(remaining[Math.max(0, closingIndex - 1)]?.id);
    }
  };

  const closePanel = () => {
    setLauncherOpen(false);
    setCollapsed(true);
  };

  useEffect(() => {
    const toggleDockView = (event: Event) => {
      const requestedView = (event as CustomEvent<unknown>).detail;
      if (!isDockView(requestedView)) return;
      openTab(requestedView);
    };
    const toggleDockPanel = () => {
      setLauncherOpen(false);
      if (activeTabId) {
        setCollapsed((current) => !current);
        return;
      }
      const fallbackTab = openTabs.at(-1);
      if (fallbackTab) {
        setActiveTabId(fallbackTab.id);
        setCollapsed(false);
        return;
      }
      const tab = { id: rid(), view: "session" as const };
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
  }, [activeTabId, openTabs]);

  const tabMeta: Record<DockView, { icon: LucideIcon; label: string }> = {
    session: { icon: ListTodoIcon, label: t("dock.session") },
    terminal: { icon: SquareTerminalIcon, label: t("dock.terminal") },
    files: { icon: FolderTreeIcon, label: t("dock.files") },
    git: { icon: GitBranchIcon, label: t("dock.git") },
    browser: { icon: GlobeIcon, label: t("dock.browser") },
    mcp: { icon: PlugIcon, label: t("dock.mcp") },
    skills: { icon: WandSparklesIcon, label: t("dock.skills") },
    subagents: { icon: BotMessageSquareIcon, label: t("nav.subagents") },
  };

  return (
    <>
      {view && isNarrowScreen && (
        <div
          role="presentation"
          onClick={closePanel}
          className="fixed inset-0 z-35 bg-black/40 backdrop-blur-xs transition-opacity"
        />
      )}
      <div
        ref={panelRef}
        className={cn(
          "q-workspace-dock flex h-full shrink-0 justify-end overflow-hidden bg-background",
          isNarrowScreen
            ? "fixed inset-y-0 right-0 z-40 shadow-2xl"
            : "relative z-20",
          view ? "pointer-events-auto visible" : "pointer-events-none invisible",
        )}
        style={{ width: view ? maximized ? availableWidth : panelW : 0, transition: dragging ? "none" : PANEL_TRANSITION }}
        inert={!view}
        aria-hidden={!view}
      >
        {openTabs.length > 0 && <>
          {!maximized && <div
            role="separator"
            aria-label={t("dock.resizePanel")}
            aria-orientation="vertical"
            aria-valuemin={minPanelW}
            aria-valuemax={maxPanelW}
            aria-valuenow={panelW}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={onResizeKeyDown}
            onDoubleClick={() => saveWidth(defaultDockWidth(availableWidth, availableHeight, isNarrowScreen))}
            className="q-workspace-dock-resizer"
          ><span /></div>}
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
                const tabLabel = duplicateCount > 1 ? `${label} ${openTabs.slice(0, index + 1).filter((item) => item.view === tab.view).length}` : label;
                const terminalState = terminalStatus[tab.id]?.status ?? "starting";
                return (
                  <div key={tab.id} data-dock-tab={tab.id} className={cn("q-workspace-dock-tab group flex h-8 min-w-0 flex-1 items-center rounded-lg", active && "is-active")}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => activateTab(tab.id)}
                      tabIndex={active ? 0 : -1}
                      className="flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden ps-2.5 text-start"
                    >
                      {tab.view === "terminal" ? <span className={cn("size-1.5 shrink-0 rounded-full", terminalState === "ready" ? "bg-emerald-500" : terminalState === "error" ? "bg-red-500" : "bg-amber-500")} title={terminalStatus[tab.id]?.detail} /> : null}
                      <Icon className="size-4 shrink-0 text-foreground/55" />
                      <span className="truncate text-sm text-foreground/85">{tabLabel}</span>
                      {tab.view === "terminal" && workspacePath ? <span className={cn(mono, "min-w-0 truncate text-xs text-foreground/45")} title={workspacePath}>{workspacePath}</span> : null}
                    </button>
                    <button type="button" aria-label={`${t("dock.closePanel")}: ${tabLabel}`} onClick={() => closeTab(tab.id)} className="q-workspace-dock-tab-close me-1 flex size-6 shrink-0 items-center justify-center rounded-md text-foreground/45 hover:bg-foreground/10 hover:text-foreground">
                      <XIcon className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              <div ref={launcherRef} className="relative shrink-0 ps-1.5">
                <TooltipIconButton
                  tooltip={t("dock.openWindow")}
                  onClick={() => setLauncherOpen((open) => !open)}
                  className={cn("size-8 rounded-md text-foreground/45 hover:text-foreground", launcherOpen && "bg-foreground/10 text-foreground")}
                >
                  <PlusIcon className="size-4" />
                </TooltipIconButton>
              </div>
            </div>
            <div className="q-workspace-dock-actions flex shrink-0 items-center gap-0.5 ps-1">
              {view === "terminal" ? (
                <>
                  <TooltipIconButton tooltip={t("dock.terminalClear")} onClick={() => activeTabId && terminalApiRefs.current.get(activeTabId)?.current?.clear()} className="size-7">
                    <Trash2Icon className="size-3.5" />
                  </TooltipIconButton>
                  <TooltipIconButton tooltip={t("dock.terminalRestart")} onClick={() => activeTabId && terminalApiRefs.current.get(activeTabId)?.current?.restart()} className="size-7">
                    <RotateCwIcon className="size-3.5" />
                  </TooltipIconButton>
                </>
              ) : null}
              {view === "files" || view === "git" || view === "mcp" || view === "skills" ? (
                <TooltipIconButton tooltip={t("dock.refresh")} onClick={() => setRefreshNonce((value) => value + 1)} className="size-7">
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
              const active = !collapsed && activeTabId === tab.id;
              const needsWorkspace = tab.view === "files" || tab.view === "git" || tab.view === "terminal";
              return (
                <div key={tab.id} className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", active ? "flex flex-col" : "hidden")}>
                  {needsWorkspace && !workspaceId ? <p className="px-3 py-4 text-sm text-foreground/45">{t("dock.noWorkspace")}</p> : null}
                  {tab.view === "terminal" && workspaceId && <TerminalView tabId={tab.id} workspaceId={workspaceId} active={active} apiRef={getTerminalApiRef(tab.id)} onStatus={onTerminalStatus} />}
                  {tab.view === "browser" && <DockBrowserView browserId={tab.id} active={active && !launcherOpen && !dragging} initialUrl={tab.browserTarget?.url ?? "https://www.bing.com"} previewHtml={tab.browserTarget?.html} previewId={tab.browserTarget?.requestId} />}
                  {tab.view === "files" && workspaceId && <FilesView workspaceId={workspaceId} refreshNonce={refreshNonce} />}
                  {tab.view === "git" && workspaceId && <GitView workspaceId={workspaceId} refreshNonce={refreshNonce} />}
                  {tab.view === "mcp" && <DockMcpView refreshNonce={refreshNonce} />}
                  {tab.view === "skills" && <DockSkillsView workspaceId={workspaceId} refreshNonce={refreshNonce} />}
                  {tab.view === "subagents" && <SubagentPanel onClose={() => closeTab(tab.id)} />}
                  {tab.view === "session" && <SessionDetails />}
                </div>
              );
            })}
          </div>
          </div>
        </>}
      </div>
      {launcherOpen && launcherPosition && typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          <motion.div
            ref={launcherMenuRef}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
            className="pointer-events-auto fixed z-[1000] max-h-[min(280px,calc(100dvh-24px))] w-56 overflow-y-auto overscroll-contain rounded-xl border border-border/60 bg-popover p-1.5 shadow-2xl"
            style={{ top: launcherPosition.top, right: launcherPosition.right, transformOrigin: "top right" }}
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
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
