// Office 文档渲染成静态 HTML，放进无脚本的沙箱 iframe：docx-preview 不过滤链接地址，不能直接挂进主窗口。
// 链接用 target=_blank 走主窗口的新窗口拦截，交给系统浏览器打开。
function staticDocument(body: string, css: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${css}</style></head><body>${body}</body></html>`;
}

const WORD_CSS = "html,body{margin:0;background:#f3f4f6}.docx-wrapper{padding:24px 12px!important;background:#f3f4f6!important}";
const SHEET_CSS = [
  "html,body{margin:0;background:#fff;color:#1f2937;font:12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}",
  "table{border-collapse:collapse}",
  "td{border:1px solid #e5e7eb;padding:2px 8px;white-space:pre;vertical-align:top}",
  ".sheet{position:relative}",
  ".grid{position:absolute;table-layout:fixed}",
  ".grid td{padding:0 4px;line-height:18px;white-space:pre;overflow:visible;vertical-align:bottom}",
  ".chart{position:absolute;box-sizing:border-box;border:1px solid #d1d5db;background:#fff}",
  ".chart svg{display:block;width:100%;height:100%}",
].join("");

export async function renderWordDocument(data: ArrayBuffer | Uint8Array): Promise<string> {
  const { renderAsync } = await import("docx-preview");
  const body = document.createElement("div");
  const styles = document.createElement("div");
  // altChunk 是嵌入的原始 HTML，可能带脚本，不渲染；图片转 data URL，沙箱 iframe 读不到主窗口的 blob URL。
  await renderAsync(data, body, styles, { useBase64URL: true, renderAltChunks: false });
  return staticDocument(styles.innerHTML + body.innerHTML, WORD_CSS);
}

export interface Workbook {
  sheets: string[];
  renderSheet(name: string): Promise<string>;
  close(): void;
}

type WorkerReply = { id: number; sheets?: string[]; html?: string; error?: string };

/** 工作簿在 Worker 里解析和转 HTML，主线程只拼文档。用完必须 close() 结束 Worker。 */
export async function openWorkbook(data: ArrayBuffer | Uint8Array, unsupportedChartLabel: string): Promise<Workbook> {
  const worker = new Worker(new URL("./spreadsheet-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  const fail = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  worker.onmessage = ({ data: reply }: MessageEvent<WorkerReply>) => {
    const request = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error) request?.reject(new Error(reply.error)); else request?.resolve(reply);
  };
  worker.onerror = (event) => { event.preventDefault(); fail(new Error(event.message || "Spreadsheet worker failed")); };
  const call = (message: { bytes?: ArrayBuffer | Uint8Array; sheet?: string; unsupportedLabel?: string }) => new Promise<WorkerReply>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...message });
  });
  const close = () => { worker.terminate(); fail(new Error("Spreadsheet preview closed")); };
  try {
    const { sheets = [] } = await call({ bytes: data });
    return { sheets, close, renderSheet: async (name) => staticDocument((await call({ sheet: name, unsupportedLabel: unsupportedChartLabel })).html ?? "", SHEET_CSS) };
  } catch (error) {
    close();
    throw error;
  }
}
