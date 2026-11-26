import type { CSSProperties, ReactNode } from "react";
import { createElement } from "react";
import type { HighlightLine, HighlightThemes, HighlightToken } from "./shiki-tokenize";
import type { ShikiWorkerResponse } from "./shiki-worker";

export type { HighlightLine, HighlightThemes, HighlightToken };

export const DEFAULT_HIGHLIGHT_THEMES: HighlightThemes = {
  dark: "github-dark-default",
  light: "github-light-default",
};

const PLAIN_LANGS = new Set(["", "text", "txt", "plain", "plaintext"]);
const MAX_CACHE_ENTRIES = 24;
const MAX_CACHE_CHARS = 4_000_000;

interface CacheEntry {
  lines: HighlightLine[];
  chars: number;
}

const cache = new Map<string, CacheEntry>();
let cachedChars = 0;

function makeCacheKey(code: string, language: string, themes: HighlightThemes): string {
  return `${language.trim().toLowerCase()}\0${themes.dark}\0${themes.light}\0${code}`;
}

export function getCachedHighlight(code: string, language: string, themes = DEFAULT_HIGHLIGHT_THEMES): HighlightLine[] | undefined {
  const key = makeCacheKey(code, language, themes);
  const entry = cache.get(key);
  if (!entry) return undefined;
  // 刷新 LRU 顺序
  cache.delete(key);
  cache.set(key, entry);
  return entry.lines;
}

function setCachedHighlight(key: string, lines: HighlightLine[], chars: number): void {
  if (chars > MAX_CACHE_CHARS) return;
  const existing = cache.get(key);
  if (existing) {
    cachedChars -= existing.chars;
    cache.delete(key);
  }
  cache.set(key, { lines, chars });
  cachedChars += chars;
  while (cache.size > MAX_CACHE_ENTRIES || cachedChars > MAX_CACHE_CHARS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const removed = cache.get(oldest);
    cache.delete(oldest);
    if (removed) cachedChars -= removed.chars;
  }
}

export function isPlainHighlightLanguage(language?: string): boolean {
  return !language || PLAIN_LANGS.has(language.trim().toLowerCase());
}

interface ActiveJob {
  cacheKey: string;
  chars: number;
  collected: HighlightLine[];
  cancelled: boolean;
  onChunk: (startLine: number, lines: HighlightLine[], done: boolean) => void;
  onError?: (error: string) => void;
}

let worker: Worker | null = null;
let workerFailed = false;
let nextJobId = 1;
const activeJobs = new Map<number, ActiveJob>();

function getWorker(): Worker | null {
  if (workerFailed || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    const instance = new Worker(new URL("./shiki-worker.ts", import.meta.url), { type: "module" });
    instance.onmessage = ({ data }: MessageEvent<ShikiWorkerResponse>) => {
      const job = activeJobs.get(data.id);
      if (!job || job.cancelled) return;
      if (data.type === "error") {
        activeJobs.delete(data.id);
        job.onError?.(data.error);
        return;
      }
      for (let i = 0; i < data.lines.length; i++) {
        job.collected[data.startLine + i] = data.lines[i]!;
      }
      if (data.done) {
        activeJobs.delete(data.id);
        if (job.collected.length > 0) setCachedHighlight(job.cacheKey, job.collected, job.chars);
      }
      job.onChunk(data.startLine, data.lines, data.done);
    };
    instance.onerror = (event) => {
      event.preventDefault();
      workerFailed = true;
      worker = null;
      const message = event.message || "Shiki worker failed";
      for (const job of activeJobs.values()) {
        if (!job.cancelled) job.onError?.(message);
      }
      activeJobs.clear();
    };
    worker = instance;
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

export interface HighlightRequest {
  code: string;
  lines?: readonly string[];
  language: string;
  themes?: HighlightThemes;
  chunkSize?: number;
  onChunk: (startLine: number, lines: HighlightLine[], done: boolean) => void;
  onError?: (error: string) => void;
}

/**
 * 发起异步分块语法高亮请求。优先命中 LRU 缓存，否则交给后台 Web Worker，
 * 在无 Worker 环境（如单测）下自动降级为动态导入的本地异步分词。
 * 返回取消函数。
 */
export function requestHighlight(request: HighlightRequest): () => void {
  const themes = request.themes ?? DEFAULT_HIGHLIGHT_THEMES;
  if (isPlainHighlightLanguage(request.language) || !request.code) {
    return () => {};
  }

  const cacheKey = makeCacheKey(request.code, request.language, themes);
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    request.onChunk(0, cached.lines, true);
    return () => {};
  }

  const id = nextJobId++;
  const lines = request.lines ? [...request.lines] : request.code.split(/\r?\n/);
  const job: ActiveJob = {
    cacheKey,
    chars: request.code.length,
    collected: new Array<HighlightLine>(lines.length),
    cancelled: false,
    onChunk: request.onChunk,
    onError: request.onError,
  };
  activeJobs.set(id, job);

  const activeWorker = getWorker();
  if (activeWorker) {
    activeWorker.postMessage({
      type: "highlight",
      id,
      lines,
      language: request.language,
      themes,
      chunkSize: request.chunkSize,
    });
    return () => {
      job.cancelled = true;
      if (activeJobs.delete(id)) {
        activeWorker.postMessage({ type: "cancel", id });
      }
    };
  }

  // 无 Worker 环境（如 JSDOM/Node 测试）延迟加载本地分块引擎，避免主 bundle 静态引入 shiki
  void import("./shiki-tokenize")
    .then(({ tokenizeLinesInChunks }) => tokenizeLinesInChunks({
      lines,
      language: request.language,
      themes,
      chunkSize: request.chunkSize,
      isCancelled: () => job.cancelled,
      onChunk: (startLine, chunkLines, done) => {
        if (job.cancelled) return;
        for (let i = 0; i < chunkLines.length; i++) {
          job.collected[startLine + i] = chunkLines[i]!;
        }
        if (done) {
          activeJobs.delete(id);
          if (job.collected.length > 0) setCachedHighlight(job.cacheKey, job.collected, job.chars);
        }
        job.onChunk(startLine, chunkLines, done);
      },
    }))
    .catch((error) => {
      if (job.cancelled) return;
      activeJobs.delete(id);
      job.onError?.(error instanceof Error ? error.message : String(error));
    });

  return () => {
    job.cancelled = true;
    activeJobs.delete(id);
  };
}

function tokenStyle(color?: string, fontStyle?: number): CSSProperties {
  const style: CSSProperties = {};
  if (color) style.color = color;
  if (fontStyle) {
    if (fontStyle & 1) style.fontStyle = "italic";
    if (fontStyle & 2) style.fontWeight = "bold";
    const decorations: string[] = [];
    if (fontStyle & 4) decorations.push("underline");
    if (fontStyle & 8) decorations.push("line-through");
    if (decorations.length) style.textDecoration = decorations.join(" ");
  }
  return style;
}

/** 将紧凑的 HighlightLine 转为最小 DOM 节点，无样式片段直接输出字符串 */
export function renderHighlightLine(tokens: HighlightLine | undefined, fallbackText: string): ReactNode {
  if (!tokens) return fallbackText;
  if (tokens.length === 0) return "";
  return tokens.map((token, index) => {
    if (typeof token === "string") return token;
    const [content, color, fontStyle] = token;
    return createElement("span", { key: index, style: tokenStyle(color, fontStyle) }, content);
  });
}
