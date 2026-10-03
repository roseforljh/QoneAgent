import { useEffect, useRef, useState } from "react";
import type { FilePreviewInfo } from "@qone/protocol";
import type { DockFileTarget } from "../../lib/dock-state";
import { useLocalFilePreview } from "../../lib/local-file-preview";
import { fileReferenceDirectory } from "../../lib/workspace-file-navigation";
import { languageForFile } from "../../lib/file-preview-language";
import { useLocale } from "../../localization";
import { CodexIcon } from "../ui/CodexIcon";
import { attachmentFileIcon } from "../../lib/attachment-file-kind";
import { FadeScroll } from "./elements/surfaces";
import { WorkspaceFileContent } from "./workspace-file-content";
import { MarkdownDocument } from "./markdown-document";

export function FilePreviewContent({ file, source, target, active, revision, relativePath, resourceUrl }: {
  file: FilePreviewInfo; source: boolean; target: DockFileTarget; active: boolean; revision: string; relativePath?: string; resourceUrl?: string;
}) {
  const { t } = useLocale();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const resource = ["image", "pdf", "audio", "video"].includes(file.kind) && !source;
  const localPreview = useLocalFilePreview(resource && !resourceUrl ? file.absolutePath : undefined, revision, fileReferenceDirectory(file.absolutePath));
  const preview = resourceUrl ? { url: resourceUrl } : localPreview;
  const [failedRevision, setFailedRevision] = useState<string>();
  useEffect(() => { if (!active) { videoRef.current?.pause(); audioRef.current?.pause(); } }, [active]);
  if (source || file.kind === "text") return <FadeScroll data-file-viewport className="min-h-0 flex-1">
    <WorkspaceFileContent path={file.absolutePath} relativePath={relativePath} code={file.content ?? ""} language={languageForFile(file.absolutePath)} target={target} active={active} />
  </FadeScroll>;
  if (file.kind === "markdown") return <FadeScroll data-file-viewport className="min-h-0 flex-1"><MarkdownDocument text={file.content ?? ""} /></FadeScroll>;
  if (file.kind === "html") return <iframe title={file.absolutePath} sandbox="" referrerPolicy="no-referrer" srcDoc={file.content} className="min-h-0 w-full flex-1 border-0 bg-white" />;
  if (file.kind === "binary") return <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center text-muted-foreground">
    <CodexIcon src={attachmentFileIcon(file.absolutePath, file.mimeType)} className="size-10" /><p className="text-sm">{t("dock.fileUnsupported")}</p>
  </div>;
  if (preview.error || failedRevision === revision) return <p role="alert" className="px-6 py-8 text-sm text-destructive">{t("dock.filePreviewFailed")}{preview.error ? `: ${preview.error}` : ""}</p>;
  if (!preview.url) return <p role="status" className="px-6 py-8 text-sm text-muted-foreground">{t("dock.fileLoading")}</p>;
  const fail = () => setFailedRevision(revision);
  if (file.kind === "pdf") return <iframe title={file.absolutePath} src={preview.url} className="min-h-0 w-full flex-1 border-0" onError={fail} />;
  return <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
    {file.kind === "image" && <img src={preview.url} alt={file.absolutePath.split(/[\\/]/).at(-1)} className="max-h-full max-w-full object-contain" onError={fail} />}
    {file.kind === "video" && <video ref={videoRef} src={preview.url} controls playsInline preload="metadata" className="max-h-full max-w-full" onError={fail} />}
    {file.kind === "audio" && <audio ref={audioRef} src={preview.url} controls preload="metadata" className="w-full max-w-lg" onError={fail} />}
  </div>;
}
