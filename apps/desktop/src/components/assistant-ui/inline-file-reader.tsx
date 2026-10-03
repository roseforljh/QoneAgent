import { useEffect, useState } from "react";
import type { FilePreviewInfo } from "@qone/protocol";
import type { DockFileTarget } from "../../lib/dock-state";
import { readInlineFilePreview } from "../../lib/message-file-preview";
import { localizeError } from "../../lib/error-localization";
import { useLocale } from "../../localization";
import { FilePreviewContent } from "./file-preview-content";
import { CodexIcon } from "../ui/CodexIcon";
import { attachmentFileIcon } from "../../lib/attachment-file-kind";

export function InlineFileReader({ target, active, refreshNonce }: { target: DockFileTarget; active: boolean; refreshNonce: number }) {
  const { t, locale } = useLocale();
  const [preview, setPreview] = useState<{ file?: FilePreviewInfo; url?: string; error?: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const attachment = target.attachment;
    if (!attachment) return;
    const controller = new AbortController();
    let url: string | undefined;
    setPreview(undefined);
    void readInlineFilePreview(target.path, attachment, controller.signal).then(({ file, blob }) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPreview({ file, url });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setPreview({ error: localizeError(error) });
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [target.path, target.attachment, refreshNonce, retry]);
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={target.path}>
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
      <CodexIcon src={attachmentFileIcon(target.path, target.attachment?.mimeType ?? "")} className="size-4 shrink-0 text-foreground/60" />
      <span title={target.path} className="min-w-0 flex-1 truncate text-xs text-foreground/70">{target.path}</span>
      {preview?.file && <span className="shrink-0 text-[11px] text-muted-foreground">{new Intl.NumberFormat(locale, { style: "unit", unit: "byte", unitDisplay: "short" }).format(preview.file.size)}</span>}
    </div>
    {preview?.error ? <div role="alert" className="px-6 py-8 text-sm"><p className="break-words text-destructive">{t("dock.filePreviewFailed")}: {preview.error}</p><button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-3 text-primary">{t("dock.fileRetry")}</button></div>
      : !preview?.file ? <p role="status" className="px-6 py-8 text-sm text-muted-foreground">{t("dock.fileLoading")}</p>
      : <FilePreviewContent file={preview.file} source={false} target={target} active={active} revision={`${target.requestId}:${retry}`} resourceUrl={preview.url} />}
  </section>;
}
