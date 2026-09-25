"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderTreeIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  RotateCwIcon,
  SquareTerminalIcon,
  Trash2Icon,
  XIcon,
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
import { FadeScroll, mono } from "./elements/surfaces";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";

type DockView = "terminal" | "files" | "git";

const rid = () => crypto.randomUUID();

// Real ConPTY terminal hosted by the Tauri backend: keystrokes go through
// terminal_write, output arrives via "terminal.data" events.
interface TerminalApi {
  clear: () => void;
  focus: () => void;
}

function TerminalView({ workspaceId, apiRef, onStatus }: { workspaceId: string; apiRef: MutableRefObject<TerminalApi | undefined>; onStatus: (status: "starting" | "ready" | "exited" | "error", detail?: string) => void }) {
  const cwd = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !cwd) return undefined;
    const terminalId = `dock-${workspaceId}`;
    let disposed = false;
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
    apiRef.current = { clear: () => term.clear(), focus: () => term.focus() };
    onStatus("starting");

    const unData = listen<{ terminalId: string; data: string }>("terminal.data", (e) => {
      if (e.payload.terminalId === terminalId) term.write(e.payload.data);
    });
    const unExit = listen<{ terminalId: string }>("terminal.exit", (e) => {
      if (e.payload.terminalId === terminalId && !disposed) {
        term.write("\r\n[process exited]\r\n");
        onStatus("exited");
      }
    });
    const inputSub = term.onData((data) => {
      invoke("terminal_write", { terminalId, data }).catch(() => {});
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      invoke("terminal_resize", { terminalId, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    observer.observe(host);

    invoke("terminal_spawn", {
      terminalId,
      shell: "powershell.exe",
      cwd,
      cols: term.cols,
      rows: term.rows,
    }).then(() => {
      if (!disposed) onStatus("ready");
    }).catch((error) => {
      if (!disposed) {
        onStatus("error", String(error));
        term.write(`\r\nspawn failed: ${String(error)}\r\n`);
      }
    });

    return () => {
      disposed = true;
      inputSub.dispose();
      observer.disconnect();
      if (apiRef.current) apiRef.current = undefined;
      unData.then((off) => off());
      unExit.then((off) => off());
      invoke("terminal_kill", { terminalId }).catch(() => {});
      term.dispose();
      termRef.current = undefined;
    };
  }, [workspaceId, cwd, apiRef, onStatus]);

  return (
    <div
      ref={hostRef}
      className="min-h-0 flex-1 px-2 py-2"
      onPointerDown={() => termRef.current?.focus()}
    />
  );
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

function FilesView({ workspaceId }: { workspaceId: string }) {
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
  }, [workspaceId, send, unsupported]);

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
          {workspaceError ? <p className="px-3 py-3 text-[13px] text-red-500/80">{workspaceError}</p> : <pre className={cn(mono, "whitespace-pre-wrap break-words px-3 py-2.5 text-[12px] leading-relaxed text-foreground/80 [overflow-wrap:anywhere]")}>
            {content ?? t("dock.fileLoading")}
          </pre>}
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

function GitView({ workspaceId }: { workspaceId: string }) {
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
  }, [workspaceId, send, unsupported]);

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
            <DiffViewer patch={diff} showIcon showStats size="default" className="min-w-full" />
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
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [panelW, setPanelW] = useState(416);
  const [dragging, setDragging] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

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
    if (!moreOpen) return undefined;
    const close = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [moreOpen]);

  const toggle = (next: DockView) => {
    setMoreOpen(false);
    if (next === "terminal") setTerminalStarted(true);
    setView((current) => (current === next ? undefined : next));
  };

  const buttons: { view: DockView; icon: typeof SquareTerminalIcon; tip: string }[] = [
    { view: "terminal", icon: SquareTerminalIcon, tip: t("dock.terminal") },
    { view: "files", icon: FolderTreeIcon, tip: t("dock.files") },
    { view: "git", icon: GitBranchIcon, tip: t("dock.git") },
  ];

  return (
    <>
      <div
        className="q-reveal-zone absolute top-0 z-30 p-3"
        style={{ right: view ? panelW : 0, transition: dragging ? "none" : PANEL_TRANSITION }}
      >
        <div
          className="q-reveal flex flex-col items-center gap-0.5 rounded-full border border-border/60 bg-background/85 p-1 shadow-lg backdrop-blur"
          data-open={(!!view || moreOpen) || undefined}
        >
          {buttons.map(({ view: name, icon: Icon, tip }) => (
            <TooltipIconButton
              key={name}
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
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="text-foreground/40 cursor-default rounded-md px-2.5 py-1.5 text-[13px]">
                      {t("dock.comingSoon")}
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
      <div
        className={cn(
          "relative z-20 flex h-full shrink-0 justify-end overflow-hidden bg-background",
          view && "border-s border-border/60",
        )}
        style={{ width: view ? panelW : 0, transition: dragging ? "none" : PANEL_TRANSITION }}
      >
        {view && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startResize}
            className="absolute inset-y-0 start-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-foreground/10"
          />
        )}
        <div className="flex h-full shrink-0 flex-col" style={{ width: panelW }}>
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/50 pe-3 ps-2">
            <TooltipIconButton tooltip={t("dock.closePanel")} onClick={() => setView(undefined)} className="size-7">
              <XIcon className="size-4" />
            </TooltipIconButton>
            {view === "terminal" && workspacePath ? (
              <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2 py-1" title={workspacePath}>
                <SquareTerminalIcon className="size-3.5 shrink-0 text-foreground/50" />
                <span className={cn(mono, "truncate text-[12px] text-foreground/70")}>{workspacePath}</span>
              </span>
            ) : (
              <span className="text-[13px] font-medium text-foreground/80">{view ? t(`dock.${view}`) : ""}</span>
            )}
          </div>
          {workspaceId ? (
            <>
              <div className={cn("min-h-0 flex-1", view === "terminal" ? "flex flex-col" : "hidden")}>
                {terminalStarted && <TerminalView workspaceId={workspaceId} />}
              </div>
              {view === "files" && <FilesView workspaceId={workspaceId} />}
              {view === "git" && <GitView workspaceId={workspaceId} />}
            </>
          ) : (
            view && <p className="px-3 py-4 text-[13px] text-foreground/45">{t("dock.noWorkspace")}</p>
          )}
        </div>
      </div>
    </>
  );
}
