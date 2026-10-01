import { localizeError } from "../../lib/error-localization";
import { useEffect, useMemo, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import type { DockFileTarget } from "../../lib/dock-state";
import { removeFilePreview, requestFilePreview, useFilePreviewStore } from "../../lib/file-preview-state";
import { FileReferenceContext } from "../../lib/file-reference-context";
import { fileReferenceDirectory, workspaceRelativeFilePath } from "../../lib/workspace-file-navigation";
import { FilePreviewContent } from "./file-preview-content";
import { WorkspacePathContextMenu } from "./dock-context-menu";
import { TooltipIconButton } from "./tooltip-icon-button";
import { CodexIcon } from "../ui/CodexIcon";
import { attachmentFileIcon } from "../../lib/attachment-file-kind";
import codeIcon from "../../assets/codex-icons/code-light-20.svg";
import documentIcon from "../../assets/codex-icons/document-text-light-24.svg";
import externalIcon from "../../assets/codex-icons/arrow-up-right-md-light-20.svg";

export default function FileReader({ tabId, workspaceId, sessionId, target, active, refreshNonce }: {
  tabId: string; workspaceId?: string; sessionId?: string; target: DockFileTarget; active: boolean; refreshNonce: number;
}) {
  const { t, locale } = useLocale();
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const supported = useStore((state) => state.runtimeCapabilities.includes("file.preview"));
  const workspaceRoot = useStore((state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.path);
  const view = useFilePreviewStore((state) => state.views[tabId]);
  const [full, setFull] = useState(false);
  const [source, setSource] = useState(Boolean(target.line));
  const [retry, setRetry] = useState(0);
  const [actionError, setActionError] = useState<string>();
  const file = view?.file;
  const name = (file?.absolutePath ?? target.path).split(/[\\/]/).at(-1) ?? target.path;
  const sourceAvailable = file?.content !== undefined && file.kind !== "text";
  const referenceContext = useMemo(() => {
    const path = file?.absolutePath ?? target.path;
    const directory = fileReferenceDirectory(path) ?? workspaceRoot ?? path;
    const root = workspaceRoot && workspaceRelativeFilePath(path, workspaceRoot) ? workspaceRoot : directory;
    return { directory, root, sessionId, workspaceId };
  }, [file?.absolutePath, target.path, workspaceRoot, sessionId, workspaceId]);
  useEffect(() => () => removeFilePreview(tabId), [tabId]);
  useEffect(() => {
    if (connected && supported) void requestFilePreview(tabId, { workspaceId, path: target.path, full }, send);
  }, [tabId, workspaceId, target.path, full, connected, supported, send, refreshNonce, retry]);
  useEffect(() => { setSource(Boolean(target.line)); setFull(false); }, [target.requestId]);
  const openExternal = async () => {
    setActionError(undefined);
    try { await openPath(file?.absolutePath ?? target.path); } catch (error) { setActionError(localizeError(error)); }
  };
  const error = !connected || view?.error === "disconnected" ? t("dock.fileDisconnected") : !supported ? t("dock.runtimeOutdated") : view?.error;
  return <FileReferenceContext.Provider value={referenceContext}>
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={name}>
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        <CodexIcon src={attachmentFileIcon(name, file?.mimeType ?? "")} className="size-4 shrink-0 text-foreground/60" />
        <WorkspacePathContextMenu path={file?.absolutePath ?? target.path} onOpenExternal={file ? () => void openExternal() : undefined}>
          <span tabIndex={0} title={file?.absolutePath ?? target.path} className="min-w-0 flex-1 truncate text-xs text-foreground/70 focus-visible:outline-2 focus-visible:outline-ring">{file?.absolutePath ?? target.path}</span>
        </WorkspacePathContextMenu>
        {file && <span className="shrink-0 text-[11px] text-muted-foreground">{new Intl.NumberFormat(locale, { style: "unit", unit: "byte", unitDisplay: "short" }).format(file.size)}</span>}
        {sourceAvailable && <>
          <TooltipIconButton tooltip={t("dock.filePreview")} aria-pressed={!source} onClick={() => setSource(false)} className="size-7"><CodexIcon src={documentIcon} className="size-4" /></TooltipIconButton>
          <TooltipIconButton tooltip={t("dock.fileSource")} aria-pressed={source} onClick={() => setSource(true)} className="size-7"><CodexIcon src={codeIcon} className="size-4" /></TooltipIconButton>
        </>}
        <TooltipIconButton tooltip={t("dock.fileOpenExternal")} onClick={() => void openExternal()} disabled={!file} className="size-7"><CodexIcon src={externalIcon} className="size-4" /></TooltipIconButton>
      </div>
      {actionError && <p role="alert" className="px-3 py-2 text-xs text-destructive">{actionError}</p>}
      {file?.truncated && <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground"><span>{t("dock.fileTruncated")}</span><button type="button" onClick={() => setFull(true)} disabled={view?.loading} className="shrink-0 text-primary disabled:opacity-50">{t("dock.fileLoadFull")}</button></div>}
      {error ? <div role="alert" className="px-6 py-8 text-sm"><p className="break-words text-destructive">{error}</p><button type="button" disabled={!connected || !supported} onClick={() => setRetry((value) => value + 1)} className="mt-3 text-primary disabled:opacity-50">{t("dock.fileRetry")}</button></div>
        : !file ? <p role="status" className="px-6 py-8 text-sm text-muted-foreground">{t("dock.fileLoading")}</p>
        : <FilePreviewContent file={file} relativePath={workspaceRoot ? workspaceRelativeFilePath(file.absolutePath, workspaceRoot) : undefined} source={source && sourceAvailable} target={target} active={active} revision={view!.requestId} />}
      {file?.kind === "binary" && <button type="button" onClick={() => void openExternal()} className="mx-auto mb-8 rounded-lg border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted">{t("dock.fileOpenExternal")}</button>}
    </section>
  </FileReferenceContext.Provider>;
}
