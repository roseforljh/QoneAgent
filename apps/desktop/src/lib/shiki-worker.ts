import { tokenizeLinesInChunks, type HighlightLine, type HighlightThemes } from "./shiki-tokenize";

type WorkerRequest =
  | { type: "highlight"; id: number; lines: string[]; language: string; themes?: HighlightThemes; chunkSize?: number }
  | { type: "cancel"; id: number };

export type ShikiWorkerResponse =
  | { type: "chunk"; id: number; startLine: number; lines: HighlightLine[]; done: boolean }
  | { type: "error"; id: number; error: string };

const cancelled = new Set<number>();
const queue: Extract<WorkerRequest, { type: "highlight" }>[] = [];
let running = false;

async function drainQueue() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      if (cancelled.delete(job.id)) continue;
      try {
        await tokenizeLinesInChunks({
          lines: job.lines,
          language: job.language,
          themes: job.themes,
          chunkSize: job.chunkSize,
          isCancelled: () => cancelled.has(job.id),
          onChunk: (startLine, lines, done) => {
            if (cancelled.has(job.id)) return;
            const message: ShikiWorkerResponse = { type: "chunk", id: job.id, startLine, lines, done };
            self.postMessage(message);
          },
        });
      } catch (error) {
        if (!cancelled.has(job.id)) {
          const message: ShikiWorkerResponse = {
            type: "error",
            id: job.id,
            error: error instanceof Error ? error.message : String(error),
          };
          self.postMessage(message);
        }
      } finally {
        cancelled.delete(job.id);
      }
    }
  } finally {
    running = false;
  }
}

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === "cancel") {
    cancelled.add(data.id);
    // 清理队列中尚未启动的对应任务，避免积压
    const index = queue.findIndex((item) => item.id === data.id);
    if (index >= 0) queue.splice(index, 1);
    return;
  }
  queue.push(data);
  void drainQueue();
};
