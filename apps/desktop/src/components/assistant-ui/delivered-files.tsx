import { memo, useMemo, type FC } from "react";
import { ExternalLinkIcon, FolderOpenIcon, Trash2Icon } from "lucide-react";
import { DIRECTORY_MIME_TYPE, type ArtifactInfo } from "@qone/protocol";
import { useConversationStore } from "../../lib/conversation-context";
import { conversationSession } from "../../lib/session-execution-state";
import { localizeError } from "../../lib/error-localization";
import { openPath, revealItemInDir } from "../../lib/desktop-bridge";
import { useLocalFilePreview } from "../../lib/local-file-preview";
import { openWorkspaceFile } from "../../lib/workspace-file-navigation";
import { attachmentFileIcon } from "../../lib/attachment-file-kind";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { CodexIcon } from "../ui/CodexIcon";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Image } from "./elements/image";
import { formatFileSize } from "./elements/file";

const reportError = (error: unknown) => useStore.setState({ lastError: localizeError(error) });

/** Image, video and audio stream from disk in place; nothing is copied or loaded whole. */
function DeliveredMedia({ artifact, url }: { artifact: ArtifactInfo; url: string }) {
  if (artifact.type === "image") return <Image.Root><Image.Zoom src={url} alt={artifact.name} filename={artifact.name}><Image.Preview src={url} alt={artifact.name} /></Image.Zoom></Image.Root>;
  if (artifact.type === "video") return <video src={url} controls preload="metadata" playsInline className="max-h-[min(60vh,480px)] w-full rounded-xl bg-black" />;
  return <audio src={url} controls preload="metadata" className="w-full" />;
}

const DeliveredFile = memo(function DeliveredFile({ artifact }: { artifact: ArtifactInfo }) {
  const { t } = useLocale();
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const workspaceId = useConversationStore((state) => conversationSession(state)?.workspaceId);
  const media = artifact.type === "image" || artifact.type === "video" || artifact.type === "audio";
  const folder = artifact.type === "folder";
  const preview = useLocalFilePreview(media ? artifact.path : undefined, artifact.id);
  const open = () => folder
    ? void openPath(artifact.path).catch(reportError)
    : openWorkspaceFile({ sessionId, workspaceId, path: artifact.path });
  const remove = async () => {
    if (!sessionId || !await confirmDestructiveAction(t("delivered.deleteConfirm", { name: artifact.name }))) return;
    useStore.getState().send({ type: "artifact.delete", requestId: crypto.randomUUID(), sessionId, artifactId: artifact.id });
  };
  return <div data-slot="delivered-file" className="flex flex-col gap-2">
    {media && preview.url && <DeliveredMedia artifact={artifact} url={preview.url} />}
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border/60 bg-foreground/[0.025] px-3 py-2">
      <CodexIcon src={attachmentFileIcon(artifact.name, folder ? DIRECTORY_MIME_TYPE : artifact.mimeType ?? "")} className="size-4 shrink-0 text-foreground/70" />
      <button type="button" onClick={open} title={artifact.path} className="min-w-0 flex-1 text-start">
        <span className="block truncate text-sm text-foreground/90 hover:text-foreground">{artifact.name}</span>
        <span className="block truncate text-xs text-foreground/50">
          {preview.error ? t("delivered.missing") : folder ? t("delivered.folder") : artifact.size !== undefined ? formatFileSize(artifact.size) : artifact.mimeType}
        </span>
      </button>
      <TooltipIconButton tooltip={t("delivered.open")} onClick={() => void openPath(artifact.path).catch(reportError)}><ExternalLinkIcon /></TooltipIconButton>
      <TooltipIconButton tooltip={t("delivered.reveal")} onClick={() => void revealItemInDir(artifact.path).catch(reportError)}><FolderOpenIcon /></TooltipIconButton>
      <TooltipIconButton tooltip={t("delivered.delete")} onClick={() => void remove()} className="hover:text-destructive"><Trash2Icon /></TooltipIconButton>
    </div>
  </div>;
});

/** Files the agent delivered during a run: generated media and anything sent with qone_send_file. */
export const DeliveredFiles: FC<{ runIds: readonly string[] }> = ({ runIds }) => {
  const artifacts = useConversationStore((state) => state.artifacts);
  const visible = useMemo(() => {
    const ids = new Set(runIds);
    return artifacts.filter((artifact) => artifact.runId && ids.has(artifact.runId)).reverse();
  }, [artifacts, runIds]);
  if (!visible.length) return null;
  return <div className="flex flex-col gap-2 py-2">{visible.map((artifact) => <DeliveredFile key={artifact.id} artifact={artifact} />)}</div>;
};
