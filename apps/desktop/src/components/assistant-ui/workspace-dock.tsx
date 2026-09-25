"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GlobeIcon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
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
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import type { WorkspaceFileInfo, WorkspaceGitEntry } from "@qone/protocol";
import { useStore } from "../../store";
import { TooltipIconButton } from "./tooltip-icon-button";
import { DiffViewer } from "./elements/diff-viewer";
import { SyntaxHighlighter } from "./elements/shiki-highlighter";
import { DockBrowserView, DockMcpView, DockSkillsView } from "./dock-extra-views";
import { FadeScroll, mono } from "./elements/surfaces";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { reportStartup } from "../../lib/startup-diagnostic";

type DockView = "terminal" | "files" | "git" | "browser" | "mcp" | "skills";

const rid = () => crypto.randomUUID();

// Real ConPTY terminal hosted by the Tauri backend: keystrokes go through
// terminal_write, output arrives via "terminal:data" events.
interface TerminalApi {
  clear: () => void;
  focus: () => void;
  restart: () => void;
}

function TerminalView({ workspaceId, active, apiRef, onStatus }: { workspaceId: string; active: boolean; apiRef: MutableRefObject<TerminalApi | undefined>; onStatus: (status: "starting" | "ready" | "exited" | "error", detail?: string) => void }) {
  const cwd = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const terminalIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !cwd) return undefined;
    // A mount gets its own native session id. This prevents a delayed
    // cleanup from one React mount from colliding with the next mount.
    const terminalId = `dock-${workspaceId}-${crypto.randomUUID()}`;
    terminalIdRef.current = terminalId;
    // getComputedStyle resolves the inherited color to rgb(); xterm's canvas
    // parser cannot handle raw CSS var values like oklch().
    const term = new XTerm({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      cursorBlink: true,
      convertEol: false,
      scrollOnUserInput: true,
      theme: {
        background: "rgba(0,0,0,0)",
        foreground: getComputedStyle(host).color || undefined,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();
    termRef.current = term;
    fitRef.current = fit;
    let disposed = false;
    let restarting = false;
    let nativeReady = false;
    const pendingInput: string[] = [];
    let lastInputError = "";

    const writeInput = (data: string) => {
      if (!nativeReady) {
        pendingInput.push(data);
        return;
      }
      void invoke("terminal_write", { terminalId, data }).catch((error) => {
        if (disposed || String(error) === lastInputError) return;
        lastInputError = String(error);
        nativeReady = false;
        onStatus("error", lastInputError);
        term.write(`\r\n[input failed: ${lastInputError}]\r\n`);
      });
    };

    const flushInput = () => {
      const buffered = pendingInput.splice(0);
      for (const data of buffered) writeInput(data);
    };

    let startPromise: Promise<void> | undefined;
    let eventsReady: Promise<unknown[]> | undefined;

    const start = () => {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        restarting = true;
        nativeReady = false;
        lastInputError = "";
        onStatus("starting");
        try {
          // xterm must be listening before CreateProcessW starts emitting the
          // initial PowerShell prompt. A bounded fallback prevents one stuck
          // event registration from blocking the whole terminal forever.
          await Promise.race([
            eventsReady,
            new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
          ]);
          // Kill stale sessions first. This closes the race where React has
          // already unmounted the view but ConPTY has not finished cleaning up.
          await invoke("terminal_kill", { terminalId }).catch(() => {});
          if (disposed) return;
          await invoke("terminal_spawn", {
            terminalId,
            shell: "pwsh.exe -NoProfile",
            cwd,
            cols: term.cols,
            rows: term.rows,
          });
          if (!disposed) {
            nativeReady = true;
            await invoke("terminal_resize", { terminalId, cols: term.cols, rows: term.rows }).catch(() => {});
            flushInput();
            onStatus("ready");
          }
        } catch (error) {
          nativeReady = false;
          pendingInput.splice(0);
          if (!disposed) {
            onStatus("error", String(error));
            term.write(`\r\nspawn failed: ${String(error)}\r\n`);
          }
        } finally {
          restarting = false;
        }
      })().finally(() => { startPromise = undefined; });
      return startPromise;
    };

    apiRef.current = { clear: () => term.clear(), focus: () => term.focus(), restart: () => { void start(); } };
    onStatus("starting");

    const unData = listen<{ terminalId: string; data: string }>("terminal:data", (e) => {
      if (e.payload.terminalId === terminalId) term.write(e.payload.data);
    });
    const unExit = listen<{ terminalId: string }>("terminal:exit", (e) => {
      if (e.payload.terminalId === terminalId && !disposed) {
        nativeReady = false;
        if (!restarting) {
          term.write("\r\n[process exited]\r\n");
          onStatus("exited");
        }
      }
    });
    eventsReady = Promise.all([unData, unExit]);
    const inputSub = term.onData((data) => {
      writeInput(data);
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (nativeReady) invoke("terminal_resize", { terminalId, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    observer.observe(host);

    void start();

    return () => {
      disposed = true;
      nativeReady = false;
      pendingInput.splice(0);
      inputSub.dispose();
      observer.disconnect();
      if (apiRef.current) apiRef.current = undefined;
      unData.then((off) => off());
      unExit.then((off) => off());
      invoke("terminal_kill", { terminalId }).catch(() => {});
      term.dispose();
      termRef.current = undefined;
      fitRef.current = undefined;
      if (terminalIdRef.current === terminalId) terminalIdRef.current = undefined;
    };
  }, [workspaceId, cwd, apiRef, onStatus]);

  useEffect(() => {
    const terminalId = terminalIdRef.current;
    if (!active || !fitRef.current || !terminalId) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      if (termRef.current) {
        invoke("terminal_resize", { terminalId, cols: termRef.current.cols, rows: termRef.current.rows }).catch(() => {});
        termRef.current.focus();
      }
    });
  }, [active, workspaceId]);

  return (
    <div
      ref={hostRef}
      className="min-h-0 flex-1 overflow-hidden px-2 py-2"
      tabIndex={0}
      role="application"
      aria-label="Terminal"
      onPointerDown={() => termRef.current?.focus()}
      onClick={() => termRef.current?.focus()}
    />
  );
}

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
            className="text-foreground/75 hover:bg-foreground/[0.05] hover:text-foreground flex w-full min-w-0 items-center gap-1.5 py-1 pe-2 text-start text-[13px] transition-colors"
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

  if (unsupported) return <p className="px-3 py-4 text-[13px] text-foreground/55">{t("dock.runtimeOutdated")}</p>;

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
          {workspaceError ? <p className="px-3 py-3 text-[13px] text-red-500/80">{workspaceError}</p> : content === undefined ? (
            <p className="px-3 py-3 text-[13px] text-foreground/50">{t("dock.fileLoading")}</p>
          ) : (
            <SyntaxHighlighter
              code={content}
              language={languageForPath(selected)}
              className="min-h-full [&_pre]:m-0! [&_pre]:rounded-none! [&_pre]:border-0! [&_pre]:bg-transparent! [&_pre]:px-3! [&_pre]:py-2.5! [&_pre]:text-[12px]! [&_pre]:leading-relaxed"
            />
          )}
        </FadeScroll>
      </div>
    );
  }

  if (workspaceError) return <p className="px-3 py-4 text-[13px] text-red-500/80">{workspaceError}</p>;
  if (!files.length) return <p className="px-3 py-4 text-[13px] text-foreground/45">{t("dock.filesEmpty")}</p>;

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

  if (unsupported) return <p className="px-3 py-4 text-[13px] text-foreground/55">{t("dock.runtimeOutdated")}</p>;

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
          {workspaceError ? <p className="px-1 py-1 text-[13px] text-red-500/80">{workspaceError}</p> : diff === undefined ? (
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

  if (workspaceError) return <p className="px-3 py-4 text-[13px] text-red-500/80">{workspaceError}</p>;
  if (!gitLoaded) return <p className="px-3 py-4 text-[13px] text-foreground/45">{t("dock.gitLoading")}</p>;
  if (!entries.length) {
    return <p className="px-3 py-3 text-[13px] text-foreground/45">{t("dock.gitClean")}</p>;
  }

  return (
    <FadeScroll className="min-h-0 flex-1 py-1.5">
      {entries.map((entry) => (
        <button
          key={`${entry.code}:${entry.path}`}
          type="button"
          onClick={() => open(entry.path)}
          className="text-foreground/75 hover:bg-foreground/[0.05] hover:text-foreground flex w-full min-w-0 items-center gap-2 px-3 py-1 text-start text-[13px] transition-colors"
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

const PANEL_TRANSITION = "width 0.25s cubic-bezier(0.32,0.72,0,1), right 0.25s cubic-bezier(0.32,0.72,0,1)";
const MIN_PANEL_W = 288;
const MAX_PANEL_RATIO = 0.6;

export function WorkspaceDock() {
  const { t } = useLocale();
  const workspaceId = useStore((s) => s.currentWorkspaceId);
  const workspacePath = useStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId)?.path);
  const [view, setView] = useState<DockView>();
  const [openViews, setOpenViews] = useState<DockView[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<"starting" | "ready" | "exited" | "error">("starting");
  const [terminalDetail, setTerminalDetail] = useState<string>();
  const [moreOpen, setMoreOpen] = useState(false);
  const [panelW, setPanelW] = useState(416);
  const [dragging, setDragging] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLDivElement>(null);
  const launcherMenuRef = useRef<HTMLDivElement>(null);
  const dockZoneRef = useRef<HTMLDivElement>(null);
  const dockRevealRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [launcherPosition, setLauncherPosition] = useState<{ top: number; right: number }>();
  const terminalApiRef = useRef<TerminalApi | undefined>(undefined);
  const onTerminalStatus = useCallback((status: "starting" | "ready" | "exited" | "error", detail?: string) => {
    setTerminalStatus(status);
    setTerminalDetail(detail);
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => {
      setPanelW(Math.min(Math.max(window.innerWidth - ev.clientX, MIN_PANEL_W), window.innerWidth * MAX_PANEL_RATIO));
    };
    const done = () => {
      setDragging(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  };

  useEffect(() => {
    if (!moreOpen && !launcherOpen) return undefined;
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const path = event.composedPath();
      const inside = (element: HTMLElement | null) => Boolean(
        element && (path.includes(element) || (target && element.contains(target))),
      );
      if (!inside(moreRef.current)) setMoreOpen(false);
      if (!inside(launcherRef.current) && !inside(launcherMenuRef.current) && !inside(expandRef.current)) setLauncherOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [moreOpen, launcherOpen]);

  useEffect(() => {
    if (!launcherOpen) {
      setLauncherPosition(undefined);
      return undefined;
    }
    const update = () => {
      // The "+" button only exists while the panel is open; when the chooser is
      // triggered from the capsule's expand button, anchor to it instead.
      const rect = (launcherRef.current ?? expandRef.current)?.getBoundingClientRect();
      if (!rect) return;
      setLauncherPosition(launcherRef.current
        ? { top: rect.bottom + 8, right: 12 }
        : { top: rect.top, right: window.innerWidth - rect.left + 8 });
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
    setMoreOpen(false);
    setLauncherOpen(false);
  }, [view]);

  useEffect(() => {
    if (view) return undefined;
    const timer = window.setTimeout(() => {
      const x = Math.max(0, window.innerWidth - 30);
      const label = (node: Element | undefined) => {
        if (!node) return "null";
        const classes = typeof node.className === "string"
          ? node.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".")
          : "";
        return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${classes ? `.${classes}` : ""}`;
      };
      const rect = (node: Element | null) => {
        if (!(node instanceof HTMLElement)) return "none";
        const box = node.getBoundingClientRect();
        return `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}`;
      };
      const reveal = dockRevealRef.current;
      const revealStyle = reveal ? getComputedStyle(reveal) : undefined;
      const buttons = reveal
        ? [...reveal.querySelectorAll<HTMLButtonElement>("button")].map((button, index) => {
          const box = button.getBoundingClientRect();
          const x = Math.round(box.left + box.width / 2);
          const y = Math.round(box.top + box.height / 2);
          return `${index}:${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}@${label(document.elementFromPoint(x, y) ?? undefined)}`;
        }).join(";")
        : "none";
      const points = [30, 60, 90, 120].map((y) => {
        const hits = document.elementsFromPoint(x, y).slice(0, 4).map(label).join(">");
        return `${y}:${hits || "null"}`;
      }).join("|");
      reportStartup(
        `dock closed hit-test x=${x} zone=${rect(dockZoneRef.current)} reveal=${rect(reveal)} panel=${rect(panelRef.current)} `
        + `visibility=${revealStyle?.visibility ?? "none"} pointerEvents=${revealStyle?.pointerEvents ?? "none"} `
        + `buttons=${buttons} points=${points}`,
      );
    }, 350);
    return () => window.clearTimeout(timer);
  }, [view]);

  const activate = (next: DockView) => {
    setMoreOpen(false);
    setLauncherOpen(false);
    if (next === "terminal") setTerminalOpened(true);
    setOpenViews((current) => current.includes(next) ? current : [...current, next]);
    setView(next);
  };

  const toggle = (next: DockView) => {
    if (view === next) {
      setMoreOpen(false);
      setLauncherOpen(false);
      setView(undefined);
      return;
    }
    activate(next);
  };

  const closeTab = (closing: DockView) => {
    const remaining = openViews.filter((item) => item !== closing);
    setMoreOpen(false);
    setLauncherOpen(false);
    setOpenViews(remaining);
    if (closing === "terminal") setTerminalOpened(false);
    setView((current) => {
      if (current !== closing) return current;
      return remaining.at(-1);
    });
  };

  const closePanel = () => {
    setMoreOpen(false);
    setLauncherOpen(false);
    setView(undefined);
  };

  const togglePanel = () => {
    if (view) {
      closePanel();
      return;
    }
    const last = openViews.at(-1);
    if (last) {
      activate(last);
      return;
    }
    setMoreOpen(false);
    setLauncherOpen((open) => !open);
  };

  const buttons: { view: DockView; icon: typeof SquareTerminalIcon; tip: string }[] = [
    { view: "terminal", icon: SquareTerminalIcon, tip: t("dock.terminal") },
    { view: "files", icon: FolderTreeIcon, tip: t("dock.files") },
    { view: "git", icon: GitBranchIcon, tip: t("dock.git") },
  ];

  const tabMeta: Record<DockView, { icon: LucideIcon; label: string }> = {
    terminal: { icon: SquareTerminalIcon, label: t("dock.terminal") },
    files: { icon: FolderTreeIcon, label: t("dock.files") },
    git: { icon: GitBranchIcon, label: t("dock.git") },
    browser: { icon: GlobeIcon, label: t("dock.browser") },
    mcp: { icon: PlugIcon, label: t("dock.mcp") },
    skills: { icon: WandSparklesIcon, label: t("dock.skills") },
  };

  return (
    <>
      <div
        ref={dockZoneRef}
        data-qone-dock-zone="true"
        className="q-dock-reveal-zone absolute top-0 z-30 p-3"
        style={{ right: view ? panelW : 0, transition: dragging ? "none" : PANEL_TRANSITION }}
      >
        <div
          ref={dockRevealRef}
          className="q-dock-reveal flex flex-col items-center gap-0.5 rounded-full border border-border/60 bg-background/85 p-1 shadow-lg backdrop-blur"
          data-open={(!!view || moreOpen || launcherOpen) || undefined}
        >
          <div ref={expandRef}>
            <TooltipIconButton
              tooltip={view ? t("dock.collapsePanel") : t("dock.expandPanel")}
              onClick={togglePanel}
              className={cn("size-7 rounded-full", launcherOpen && "bg-foreground/10 text-foreground")}
            >
              {view ? <PanelRightCloseIcon className="size-4" /> : <PanelRightOpenIcon className="size-4" />}
            </TooltipIconButton>
          </div>
          {buttons.map(({ view: name, icon: Icon, tip }) => (
            <TooltipIconButton
              key={name}
              data-qone-dock-action={name}
              tooltip={tip}
              onClick={() => toggle(name)}
              className={cn("size-7 rounded-full", view === name && "bg-foreground/10 text-foreground")}
            >
              <Icon className="size-4" />
            </TooltipIconButton>
          ))}
          <div ref={moreRef} className="relative">
            <TooltipIconButton tooltip={t("dock.more")} onClick={() => setMoreOpen((open) => !open)} className="size-7 rounded-full">
              <MoreHorizontalIcon className="size-4" />
            </TooltipIconButton>
            <AnimatePresence>
              {moreOpen && (
                <motion.div
                  initial={{ opacity: 0, x: 4, scale: 0.97 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 4, scale: 0.97 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  className="bg-popover absolute end-9 top-0 z-40 w-40 overflow-hidden rounded-xl border border-border/60 p-1 shadow-xl"
                >
                  {([
                    { view: "browser", icon: GlobeIcon, label: t("dock.browser") },
                    { view: "mcp", icon: PlugIcon, label: t("dock.mcp") },
                    { view: "skills", icon: WandSparklesIcon, label: t("dock.skills") },
                  ] as const).map(({ view: name, icon: Icon, label }) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggle(name)}
                      className="text-foreground/75 hover:bg-foreground/[0.06] hover:text-foreground flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-start text-[13px] transition-colors"
                    >
                      <Icon className="size-3.5 shrink-0 text-foreground/50" />
                      {label}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
      <div
        ref={panelRef}
        className={cn(
          "relative z-20 flex h-full shrink-0 justify-end overflow-hidden bg-background",
          view ? "pointer-events-auto visible" : "pointer-events-none invisible",
          view && "border-s border-border/60",
        )}
        style={{ width: view ? panelW : 0, transition: dragging ? "none" : PANEL_TRANSITION }}
      >
        {view && <>
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startResize}
            className="absolute inset-y-0 start-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-foreground/10"
          />
          <div className="flex h-full shrink-0 flex-col" style={{ width: panelW }}>
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/50 bg-background/95 px-2">
            <div
              role="tablist"
              aria-label="Workspace tools"
              onWheel={(e) => {
                e.currentTarget.scrollLeft += e.deltaY + e.deltaX;
              }}
              className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {openViews.map((name) => {
                const { icon: Icon, label } = tabMeta[name];
                const active = view === name;
                return (
                  <div key={name} className={cn("group flex h-6 w-36 shrink-0 items-center rounded-md border transition-colors", active ? "border-border/70 bg-foreground/[0.07]" : "border-transparent hover:bg-foreground/[0.04]")}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => activate(name)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden ps-2.5 text-start"
                    >
                      {name === "terminal" ? <span className={cn("size-1.5 shrink-0 rounded-full", terminalStatus === "ready" ? "bg-emerald-500" : terminalStatus === "error" ? "bg-red-500" : "bg-amber-500")} title={terminalDetail} /> : null}
                      <Icon className="size-3.5 shrink-0 text-foreground/55" />
                      <span className="truncate text-[12px] font-medium text-foreground/80">{label}</span>
                      {name === "terminal" && workspacePath ? <span className={cn(mono, "min-w-0 truncate text-[11px] text-foreground/45")} title={workspacePath}>{workspacePath}</span> : null}
                    </button>
                    <button type="button" aria-label={`Close ${label}`} onClick={() => closeTab(name)} className="me-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-foreground/35 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus:opacity-100">
                      <XIcon className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              <div ref={launcherRef} className="relative shrink-0">
                <TooltipIconButton
                  tooltip={t("dock.openWindow")}
                  onClick={() => setLauncherOpen((open) => !open)}
                  className={cn("size-7 rounded-md text-foreground/45 hover:text-foreground", launcherOpen && "bg-foreground/10 text-foreground")}
                >
                  <PlusIcon className="size-4" />
                </TooltipIconButton>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5 border-s border-border/50 ps-1">
              {view === "terminal" ? (
                <>
                  <TooltipIconButton tooltip={t("dock.terminalClear")} onClick={() => terminalApiRef.current?.clear()} className="size-7">
                    <Trash2Icon className="size-3.5" />
                  </TooltipIconButton>
                  <TooltipIconButton tooltip={t("dock.terminalRestart")} onClick={() => terminalApiRef.current?.restart()} className="size-7">
                    <RotateCwIcon className="size-3.5" />
                  </TooltipIconButton>
                </>
              ) : null}
              {view === "files" || view === "git" || view === "mcp" || view === "skills" ? (
                <TooltipIconButton tooltip={t("dock.refresh")} onClick={() => setRefreshNonce((value) => value + 1)} className="size-7">
                  <RefreshCwIcon className="size-3.5" />
                </TooltipIconButton>
              ) : null}
              <TooltipIconButton tooltip={t("dock.closePanel")} onClick={closePanel} className="size-7">
                <PanelRightCloseIcon className="size-4" />
              </TooltipIconButton>
            </div>
          </div>
          <div className={cn("min-h-0 flex-1", view === "terminal" ? "flex flex-col" : "hidden")}>
            {terminalOpened && workspaceId && <TerminalView workspaceId={workspaceId} active={view === "terminal"} apiRef={terminalApiRef} onStatus={onTerminalStatus} />}
          </div>
          <div className={cn("min-h-0 flex-1", view === "browser" ? "flex flex-col" : "hidden")}>
            {view === "browser" && <DockBrowserView active={!launcherOpen && !moreOpen && !dragging} />}
          </div>
          {view === "mcp" && <DockMcpView refreshNonce={refreshNonce} />}
          {view === "skills" && <DockSkillsView workspaceId={workspaceId} refreshNonce={refreshNonce} />}
          {(view === "files" || view === "git" || view === "terminal") && !workspaceId ? (
            <p className="px-3 py-4 text-[13px] text-foreground/45">{t("dock.noWorkspace")}</p>
          ) : view === "files" ? (
            <FilesView workspaceId={workspaceId!} refreshNonce={refreshNonce} />
          ) : view === "git" ? (
            <GitView workspaceId={workspaceId!} refreshNonce={refreshNonce} />
          ) : null}
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
            className="pointer-events-auto fixed z-[1000] w-56 overflow-hidden rounded-xl border border-border/60 bg-popover p-1.5 shadow-2xl"
            style={{ top: launcherPosition.top, right: launcherPosition.right, transformOrigin: "top right" }}
          >
            <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-foreground/40">{t("dock.openWindow")}</p>
            {([
              { view: "terminal", icon: SquareTerminalIcon, label: t("dock.terminal"), detail: t("dock.terminalDescription") },
              { view: "browser", icon: GlobeIcon, label: t("dock.browser"), detail: t("dock.browserDescription") },
              { view: "files", icon: FolderTreeIcon, label: t("dock.files"), detail: t("dock.filesDescription") },
              { view: "git", icon: GitBranchIcon, label: t("dock.git"), detail: t("dock.gitDescription") },
              { view: "mcp", icon: PlugIcon, label: t("dock.mcp"), detail: t("dock.mcpDescription") },
              { view: "skills", icon: WandSparklesIcon, label: t("dock.skills"), detail: t("dock.skillsDescription") },
            ] as const).map(({ view: name, icon: Icon, label, detail }) => (
              <button
                key={name}
                type="button"
                role="menuitem"
                onClick={() => activate(name)}
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
