import { X } from "lucide-react";
import { DIRECTORY_MIME_TYPE, type MessageAttachmentInfo } from "@qone/protocol";
import { attachmentFileIcon, attachmentFileKind, attachmentFileLabel } from "../../lib/attachment-file-kind";
import { openWorkspaceFile } from "../../lib/workspace-file-navigation";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { CodexIcon } from "../ui/CodexIcon";
import { Image } from "../assistant-ui/elements/image";

interface TeamAttachmentStripProps {
  attachments: readonly MessageAttachmentInfo[];
  workspaceId?: string;
  /** 提供时展示移除按钮（用于输入框待发区）；省略时用于消息气泡展示。 */
  onRemove?: (index: number) => void;
  className?: string;
}

/** 复用主页面同一套附件样式、Codex 文件类型图标、Image.Zoom 大图灯箱与文件预览。 */
export function TeamAttachmentStrip({ attachments, workspaceId, onRemove, className }: TeamAttachmentStripProps) {
  const { t } = useLocale();
  const currentSessionId = useStore((state) => state.currentSessionId);
  if (!attachments.length) return null;

  const counts = new Map<string, number>();

  const openFilePreview = (item: MessageAttachmentInfo) => {
    if (item.type === "folder") return;
    if (!item.localPath && !item.data) return;
    openWorkspaceFile({
      sessionId: currentSessionId,
      workspaceId,
      path: item.localPath ?? item.name,
      attachment: item.localPath ? undefined : { data: item.data, mimeType: item.mimeType },
    });
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {attachments.map((item, index) => {
        const base = `${item.type}:${item.localPath ?? item.name}:${item.data.slice(0, 32)}`;
        const seen = counts.get(base) ?? 0;
        counts.set(base, seen + 1);
        const key = `${base}#${seen}`;
        const isDirectory = item.type === "folder" || item.mimeType === DIRECTORY_MIME_TYPE;
        const isImage = item.type === "image";
        const kind = attachmentFileKind(item.name, item.mimeType);
        const meta = isDirectory ? t("composer.toolFolder") : attachmentFileLabel(item.name, item.mimeType);

        if (isImage && item.data && !onRemove) {
          return (
            <Image.Zoom key={key} src={item.data} alt={item.name} filename={item.name}>
              <button type="button" className="block overflow-hidden rounded-xl border border-border/60 transition-opacity hover:opacity-90">
                <img src={item.data} alt={item.name} className="h-24 max-w-[180px] object-cover" />
              </button>
            </Image.Zoom>
          );
        }

        const tile = (
          <div
            role={!isDirectory && !(isImage && item.data) ? "button" : undefined}
            tabIndex={!isDirectory && !(isImage && item.data) ? 0 : undefined}
            onClick={() => { if (!(isImage && item.data)) openFilePreview(item); }}
            onKeyDown={(event) => {
              if (!(isImage && item.data) && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                openFilePreview(item);
              }
            }}
            title={item.localPath || item.name}
            className={cn(
              "aui-attachment-tile relative flex min-w-0 max-w-[12.5rem] items-center gap-2 overflow-hidden rounded-[14px] border border-border/75 bg-foreground/[0.04] py-1.5 ps-1.5 text-left text-foreground transition-colors hover:bg-foreground/[0.07] dark:bg-foreground/[0.06]",
              onRemove ? "pe-7" : "pe-3",
              !isDirectory && "cursor-pointer",
            )}
          >
            <span
              className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-background/80"
              data-attachment-kind={kind}
            >
              {isImage && item.data ? (
                <img src={item.data} alt="" className="size-full object-cover" />
              ) : (
                <CodexIcon src={attachmentFileIcon(item.name, item.mimeType)} className="size-4.5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium leading-tight">{item.name}</span>
              <span className="mt-0.5 block truncate text-[10.5px] leading-tight text-muted-foreground">{meta}</span>
            </span>
          </div>
        );

        return (
          <div key={key} className="relative">
            {isImage && item.data ? (
              <Image.Zoom src={item.data} alt={item.name} filename={item.name}>{tile}</Image.Zoom>
            ) : tile}
            {onRemove && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(index);
                }}
                aria-label={t("attachment.remove")}
                title={t("attachment.remove")}
                className="absolute top-1.5 right-1.5 inline-flex size-4.5 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-xs transition-colors hover:bg-background hover:text-foreground"
              >
                <X size={11} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
