import { useEffect, useState } from "react";
import type { FilePreviewInfo } from "@qone/protocol";
import { invoke } from "../../lib/desktop-bridge";
import { localizeError } from "../../lib/error-localization";
import { openWorkbook, renderWordDocument, type Workbook } from "../../lib/office-preview";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";

/** 本地文件经主进程按预览授权读取（渲染进程不能跨源 fetch asset://），消息附件直接读 blob URL。 */
async function readBytes(file: FilePreviewInfo, url: string, local: boolean): Promise<ArrayBuffer | Uint8Array> {
  if (local) return invoke<Uint8Array>("read_file_preview", { path: file.absolutePath });
  return (await fetch(url)).arrayBuffer();
}

export function OfficePreview({ file, url, local, revision }: { file: FilePreviewInfo; url: string; local: boolean; revision: string }) {
  const { t } = useLocale();
  const chartLabel = t("dock.chartUnsupported");
  const [opened, setOpened] = useState<{ revision: string; html?: string; book?: Workbook; error?: string }>();
  const [page, setPage] = useState<{ book: Workbook; sheet: string; html?: string; error?: string }>();
  useEffect(() => {
    let disposed = false;
    let book: Workbook | undefined;
    setOpened(undefined);
    void readBytes(file, url, local).then(async (data) => {
      if (file.kind === "word") return { html: await renderWordDocument(data) };
      book = await openWorkbook(data, chartLabel);
      if (disposed) book.close();
      return { book };
    }).then((next) => {
      if (disposed) return;
      setOpened({ revision, ...next });
      if (next.book?.sheets[0] !== undefined) setPage({ book: next.book, sheet: next.book.sheets[0] });
    }, (error: unknown) => { if (!disposed) setOpened({ revision, error: localizeError(error) }); });
    return () => { disposed = true; book?.close(); };
  }, [file, url, local, revision, chartLabel]);
  const book = opened?.book;
  const sheet = page?.book === book ? page?.sheet : undefined;
  useEffect(() => {
    if (!book || sheet === undefined) return;
    let disposed = false;
    void book.renderSheet(sheet).then((html) => { if (!disposed) setPage({ book, sheet, html }); },
      (error: unknown) => { if (!disposed) setPage({ book, sheet, error: localizeError(error) }); });
    return () => { disposed = true; };
  }, [book, sheet]);
  const error = opened?.error ?? (page?.book === book ? page?.error : undefined);
  if (error) return <p role="alert" className="px-6 py-8 text-sm text-destructive">{t("dock.filePreviewFailed")}: {error}</p>;
  const html = file.kind === "word" ? opened?.html : page?.book === book ? page?.html : undefined;
  return <div className="flex min-h-0 flex-1 flex-col">
    {html ? <iframe title={file.absolutePath} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={html} className="min-h-0 w-full flex-1 border-0 bg-white" />
      : <p role="status" className="flex-1 px-6 py-8 text-sm text-muted-foreground">{t("dock.fileLoading")}</p>}
    {book && book.sheets.length > 1 && <div role="tablist" className="flex shrink-0 gap-1 overflow-x-auto border-t border-border/50 px-2 py-1">
      {book.sheets.map((name) => <button key={name} type="button" role="tab" aria-selected={name === sheet} onClick={() => { if (name !== sheet) setPage({ book, sheet: name }); }}
        className={cn("shrink-0 rounded-md px-3 py-1 text-xs transition-colors", name === sheet ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>{name}</button>)}
    </div>}
  </div>;
}
