import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, ChevronRightIcon, FileIcon, FolderIcon, RefreshCwIcon } from "lucide-react";
import type { WorkspaceFileInfo, WorkspaceGitEntry } from "@qone/protocol";
import { useStore } from "../../store";
import { openPath } from "../../lib/desktop-bridge";
import { DiffViewer } from "./elements/diff-viewer";
import { WorkspaceFileContent } from "./workspace-file-content";
import { FadeScroll, mono } from "./elements/surfaces";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { attachmentFileIcon } from "../../lib/attachment-file-kind";
import { initWorkspaceView, removeWorkspaceView, requestWorkspaceFiles, requestWorkspaceFileRead, requestWorkspaceGit, requestWorkspaceGitDiff, useWorkspaceViewState, useWorkspaceViewStore } from "../../lib/workspace-view-state";
import { closeDockTerminalResource } from "../../lib/dock-terminal-resource";
import { localizeError } from "../../lib/error-localization";
import { useSelectedTextSideChat } from "../../hooks/use-selected-text-side-chat";
import { TooltipIconButton } from "./tooltip-icon-button";
import { CodeContextMenu, WorkspacePathContextMenu } from "./dock-context-menu";
import { resolveFileReferencePath } from "../../lib/workspace-file-navigation";
import type { DockTab } from "../../lib/dock-state";
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
  workspacePath,
  onOpenExternal,
}: {
  nodes: TreeNode[];
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  workspacePath?: string;
  onOpenExternal: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.path}>
          <WorkspacePathContextMenu
            path={resolveFileReferencePath(node.path, workspacePath) ?? node.path}
            onOpen={node.dir ? undefined : () => onOpen(node.path)}
            onOpenExternal={node.dir || !workspacePath ? undefined : () => onOpenExternal(resolveFileReferencePath(node.path, workspacePath) ?? node.path)}
          >
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
          </WorkspacePathContextMenu>
          {node.dir && expanded.has(node.path) && (
            <TreeRows nodes={node.children} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpen={onOpen} workspacePath={workspacePath} onOpenExternal={onOpenExternal} />
          )}
        </div>
      ))}
    </>
  );
}

export function FilesView({ tabId, workspaceId, refreshNonce, fileTarget, active }: { tabId: string; workspaceId: string; refreshNonce: number; fileTarget?: DockTab["fileTarget"]; active: boolean }) {
  const { t } = useLocale();
  const send = useStore((s) => s.send);
  const state = useWorkspaceViewState(tabId);
  const view = state?.workspaceId === workspaceId ? state : undefined;
  const workspacePath = useStore((s) => s.workspaces.find((item) => item.id === workspaceId)?.path);
  const files = view?.files;
  const openFile = view?.openFile;
  const selected = view?.selectedFilePath;
  const workspaceError = view?.error;
  const connected = useStore((s) => s.connected);
  const capabilities = useStore((s) => s.runtimeCapabilities);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loadedDirectories, setLoadedDirectories] = useState<ReadonlySet<string>>(new Set());
  const initializedTree = useRef(false);
  const tree = useMemo(() => buildTree(files ?? []), [files]);
  const unsupported = connected && !capabilities.includes("workspace.files");

  useEffect(() => {
    initWorkspaceView(tabId, workspaceId);
    return () => removeWorkspaceView(tabId);
  }, [tabId, workspaceId]);

  useEffect(() => {
    useWorkspaceViewStore.getState().resetViewData(tabId);
    setExpanded(new Set());
    setLoadedDirectories(new Set());
    initializedTree.current = false;
    if (!unsupported) void requestWorkspaceFiles({ ownerId: tabId, workspaceId, send });
  }, [tabId, workspaceId, send, unsupported, refreshNonce]);

  useEffect(() => {
    if (unsupported || !fileTarget) return;
    void requestWorkspaceFileRead({ ownerId: tabId, workspaceId, path: fileTarget.path, send });
  }, [tabId, workspaceId, send, unsupported, fileTarget?.requestId]);

  useEffect(() => {
    if (!tree.length || initializedTree.current) return;
    initializedTree.current = true;
    const directories = tree.filter((node) => node.dir).map((node) => node.path);
    setExpanded(new Set(directories));
    if (directories.length) {
      setLoadedDirectories(new Set(directories));
      for (const path of directories) void requestWorkspaceFiles({ ownerId: tabId, workspaceId, path, send });
    }
  }, [tree, send, tabId, workspaceId]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!loadedDirectories.has(path)) {
      setLoadedDirectories((prev) => new Set(prev).add(path));
      void requestWorkspaceFiles({ ownerId: tabId, workspaceId, path, send });
    }
  };

  const open = (path: string) => {
    if (openFile?.path === path) useWorkspaceViewStore.getState().setSelectedFilePath(tabId, path);
    else void requestWorkspaceFileRead({ ownerId: tabId, workspaceId, path, send });
  };

  if (unsupported) return <p className="px-3 py-4 text-sm text-foreground/55">{t("dock.runtimeOutdated")}</p>;

  if (selected) {
    const content = openFile?.path === selected ? openFile.content : undefined;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => useWorkspaceViewStore.getState().clearOpenFile(tabId)}
          className="text-foreground/60 hover:text-foreground hover:bg-foreground/[0.05] flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-2 text-start text-[12.5px] transition-colors"
        >
          <ArrowLeftIcon className="size-3.5 shrink-0" />
          <span className={cn(mono, "truncate")}>{selected}</span>
        </button>
        <FadeScroll data-file-viewport className="min-h-0 flex-1">
          {workspaceError ? <p className="px-3 py-3 text-sm text-red-500/80">{workspaceError}</p> : content === undefined ? (
            <p className="px-3 py-3 text-sm text-foreground/50">{t("dock.fileLoading")}</p>
          ) : (
            <WorkspaceFileContent
              path={resolveFileReferencePath(selected, workspacePath)}
              relativePath={selected}
              code={content}
              language={languageForPath(selected)}
              target={fileTarget?.path === selected ? fileTarget : undefined}
              active={active}
            />
          )}
        </FadeScroll>
      </div>
    );
  }

  if (workspaceError) return <p className="px-3 py-4 text-sm text-red-500/80">{workspaceError}</p>;
  if (!files?.length) return <p className="px-3 py-4 text-sm text-foreground/45">{t("dock.filesEmpty")}</p>;

  return (
    <FadeScroll className="min-h-0 flex-1 py-1.5">
      <TreeRows
        nodes={tree}
        depth={0}
        expanded={expanded}
        onToggle={toggle}
        onOpen={open}
        workspacePath={workspacePath}
        onOpenExternal={(path) => void openPath(path).catch((error) => useStore.setState({ lastError: localizeError(error) }))}
      />
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

export function GitView({ tabId, workspaceId, refreshNonce }: { tabId: string; workspaceId: string; refreshNonce: number }) {
  const { t } = useLocale();
  const send = useStore((s) => s.send);
  const state = useWorkspaceViewState(tabId);
  const view = state?.workspaceId === workspaceId ? state : undefined;
  const workspacePath = useStore((s) => s.workspaces.find((item) => item.id === workspaceId)?.path);
  const gitStatus = view?.gitStatus ?? "";
  const gitEntries = view?.gitEntries;
  const gitLoaded = view?.gitLoaded;
  const connected = useStore((s) => s.connected);
  const capabilities = useStore((s) => s.runtimeCapabilities);
  const workspaceError = view?.error;
  const diffView = view?.gitDiffView;
  const selected = view?.selectedDiffPath;
  const entries = useMemo<WorkspaceGitEntry[]>(() => gitEntries?.length ? gitEntries : parseGitStatus(gitStatus), [gitEntries, gitStatus]);
  const unsupported = connected && !capabilities.includes("workspace.git");

  useEffect(() => {
    initWorkspaceView(tabId, workspaceId);
    return () => removeWorkspaceView(tabId);
  }, [tabId, workspaceId]);

  useEffect(() => {
    useWorkspaceViewStore.getState().resetViewData(tabId);
    if (!unsupported) void requestWorkspaceGit({ ownerId: tabId, workspaceId, send });
  }, [tabId, workspaceId, send, unsupported, refreshNonce]);

  const open = (path: string) => {
    if (diffView?.path === path) useWorkspaceViewStore.getState().setSelectedDiffPath(tabId, path);
    else void requestWorkspaceGitDiff({ ownerId: tabId, workspaceId, path, scope: "unstaged", send });
  };

  if (unsupported) return <p className="px-3 py-4 text-sm text-foreground/55">{t("dock.runtimeOutdated")}</p>;

  if (selected) {
    const diff = diffView?.path === selected ? diffView.diff : undefined;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => useWorkspaceViewStore.getState().clearGitDiff(tabId)}
          className="text-foreground/60 hover:text-foreground hover:bg-foreground/[0.05] flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-2 text-start text-[12.5px] transition-colors"
        >
          <ArrowLeftIcon className="size-3.5 shrink-0" />
          <span className={cn(mono, "truncate")}>{selected}</span>
        </button>
        <FadeScroll className="min-h-0 flex-1 px-2 py-2">
          {workspaceError ? <p className="px-1 py-1 text-sm text-red-500/80">{workspaceError}</p> : diff === undefined ? (
            <p className="px-1 py-1 text-xs text-foreground/50">{t("dock.fileLoading")}</p>
          ) : diff.trim() ? (
            <CodeContextMenu
              path={resolveFileReferencePath(selected, workspacePath)}
              relativePath={selected}
            >
              <div tabIndex={0} className="min-w-full">
                <DiffViewer patch={diff} language={languageForPath(selected)} showIcon showStats size="default" className="min-w-full" />
              </div>
            </CodeContextMenu>
          ) : (
            <p className="px-1 py-1 text-xs text-foreground/50">{t("dock.untrackedChange")}</p>
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
      {entries.map((entry) => {
        const absolutePath = resolveFileReferencePath(entry.path, workspacePath);
        return (
          <WorkspacePathContextMenu
            key={`${entry.code}:${entry.path}`}
            path={absolutePath ?? entry.path}
            onOpen={() => open(entry.path)}
            onOpenExternal={entry.code === "D" || !absolutePath ? undefined : () => void openPath(absolutePath).catch((error) => useStore.setState({ lastError: localizeError(error) }))}
          >
            <button
              type="button"
              onClick={() => open(entry.path)}
              className="text-foreground/75 hover:bg-foreground/[0.05] hover:text-foreground flex w-full min-w-0 items-center gap-2 px-3 py-1 text-start text-sm transition-colors"
            >
              <span className={cn(mono, "w-5 shrink-0 text-center", GIT_STATUS_COLORS[entry.code] ?? "text-foreground/45")}>
                {entry.code === "??" ? "U" : entry.code}
              </span>
              <span className="truncate">{entry.path}</span>
            </button>
          </WorkspacePathContextMenu>
        );
      })}
    </FadeScroll>
  );
}

export function SessionDetails() {
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