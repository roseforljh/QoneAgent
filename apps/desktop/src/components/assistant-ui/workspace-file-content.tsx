import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DockFileTarget } from "../../lib/dock-state";
import {
  DEFAULT_HIGHLIGHT_THEMES,
  getCachedHighlight,
  isPlainHighlightLanguage,
  renderHighlightLine,
  requestHighlight,
  type HighlightLine,
} from "../../lib/shiki-highlight";
import { CodeContextMenu } from "./dock-context-menu";
import "./workspace-file-content.css";

/** 超过此行数启用虚拟窗口渲染；小文件全量渲染以保留完整全文选取与静态渲染兼容 */
export const FILE_VIRTUALIZE_THRESHOLD = 200;
const DEFAULT_LINE_HEIGHT = 19.5;
const OVERSCAN_LINES = 35;
const HYSTERESIS_LINES = 12;
const INITIAL_WINDOW_LINES = 90;

interface VisibleRange {
  start: number;
  end: number;
}

export function computeVirtualRange(
  totalLines: number,
  scrollTop: number,
  viewportHeight: number,
  lineHeight: number,
  current?: VisibleRange,
): VisibleRange {
  if (totalLines <= FILE_VIRTUALIZE_THRESHOLD) {
    return { start: 0, end: Math.max(0, totalLines - 1) };
  }
  const safeLineHeight = lineHeight > 0 ? lineHeight : DEFAULT_LINE_HEIGHT;
  const visibleCount = viewportHeight > 0
    ? Math.ceil(viewportHeight / safeLineHeight)
    : INITIAL_WINDOW_LINES;
  const visStart = Math.max(0, Math.floor(scrollTop / safeLineHeight));
  const visEnd = Math.min(totalLines - 1, visStart + visibleCount);

  // 当前可见区仍处于已渲染窗口的舒适区内时复用旧窗口，避免每次滚动都重渲染
  if (current) {
    const startOk = current.start === 0 ? visStart >= 0 : visStart >= current.start + HYSTERESIS_LINES;
    const endOk = current.end >= totalLines - 1 ? visEnd <= totalLines - 1 : visEnd <= current.end - HYSTERESIS_LINES;
    if (startOk && endOk && current.end < totalLines) return current;
  }

  return {
    start: Math.max(0, visStart - OVERSCAN_LINES),
    end: Math.min(totalLines - 1, visEnd + OVERSCAN_LINES),
  };
}

/** Scroll only the file viewport; never pull the conversation along with it. */
export function locateFileLines(container: HTMLElement, target?: Pick<DockFileTarget, "line" | "endLine">): void {
  const prevSelected = container.querySelectorAll<HTMLElement>('[data-file-selected="true"]');
  if (!target?.line) {
    for (const element of prevSelected) delete element.dataset.fileSelected;
    return;
  }
  const endLine = target.endLine ?? target.line;
  for (const element of prevSelected) {
    const line = Number(element.dataset.fileLine);
    if (line < target.line || line > endLine) delete element.dataset.fileSelected;
  }
  let selected: HTMLElement | undefined;
  for (let line = target.line; line <= endLine; line++) {
    const element = container.querySelector<HTMLElement>(`[data-file-line="${line}"]`);
    if (!element) continue;
    element.dataset.fileSelected = "true";
    selected ??= element;
  }
  const viewport = container.closest<HTMLElement>("[data-file-viewport]");
  if (!selected || !viewport) return;
  const lineRect = selected.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  viewport.scrollTop = Math.max(0, viewport.scrollTop + lineRect.top - viewportRect.top - (viewport.clientHeight - lineRect.height) / 2);
}

interface WorkspaceFileContentProps {
  code: string;
  language: string;
  target?: DockFileTarget;
  active: boolean;
  path?: string;
  relativePath?: string;
}

export const WorkspaceFileContent = memo(function WorkspaceFileContent({
  code,
  language,
  target,
  active,
  path,
  relativePath,
}: WorkspaceFileContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const lines = useMemo(() => code.split(/\r?\n/), [code]);
  const totalLines = lines.length;
  const virtualized = totalLines > FILE_VIRTUALIZE_THRESHOLD;

  const [lineHeight, setLineHeight] = useState(DEFAULT_LINE_HEIGHT);
  const lineHeightRef = useRef(lineHeight);
  lineHeightRef.current = lineHeight;

  const initialRange = (nextVirtualized: boolean, nextTotal: number, line?: number): VisibleRange => {
    if (!nextVirtualized) return { start: 0, end: Math.max(0, nextTotal - 1) };
    const anchor = line ? Math.max(0, Math.min(nextTotal - 1, line - 1)) : 0;
    const start = Math.max(0, anchor - OVERSCAN_LINES);
    return { start, end: Math.min(nextTotal - 1, start + INITIAL_WINDOW_LINES + OVERSCAN_LINES) };
  };

  const [rangeState, setRangeState] = useState<{ code: string; range: VisibleRange }>(() => ({
    code,
    range: initialRange(virtualized, totalLines, target?.line),
  }));
  const range = rangeState.code === code ? rangeState.range : initialRange(virtualized, totalLines, target?.line);
  const setRange = (next: VisibleRange) => setRangeState({ code, range: next });
  const rangeRef = useRef(range);
  rangeRef.current = range;

  // 文件内容变更时对齐滚动窗口
  useEffect(() => {
    if (!virtualized) {
      setRange({ start: 0, end: Math.max(0, totalLines - 1) });
      return;
    }
    const viewport = containerRef.current?.closest<HTMLElement>("[data-file-viewport]");
    const scrollTop = target?.line
      ? Math.max(0, (target.line - 1) * lineHeightRef.current - ((viewport?.clientHeight ?? 0) - lineHeightRef.current) / 2)
      : (viewport?.scrollTop ?? 0);
    setRange(computeVirtualRange(totalLines, scrollTop, viewport?.clientHeight ?? 0, lineHeightRef.current));
  }, [code, totalLines, virtualized, target?.line]);

  // 测量精确单行行高，适配不同字体缩放
  useLayoutEffect(() => {
    if (!active || !preRef.current) return;
    const computedStyle = typeof window !== "undefined" ? window.getComputedStyle?.(preRef.current) : undefined;
    const computed = computedStyle ? Number.parseFloat(computedStyle.lineHeight) : Number.NaN;
    const measured = Number.isFinite(computed) && computed > 0
      ? computed
      : preRef.current.querySelector<HTMLElement>(".line")?.getBoundingClientRect().height ?? 0;
    if (measured > 0 && Math.abs(measured - lineHeightRef.current) > 0.25) {
      setLineHeight(measured);
    }
  }, [active, code]);

  // 监听外层滚动容器的滚动与尺寸变化（仅在虚拟化且可见时挂载）
  useEffect(() => {
    if (!virtualized || !active) return;
    const viewport = containerRef.current?.closest<HTMLElement>("[data-file-viewport]");
    if (!viewport) return;

    let rafId: number | null = null;
    const sync = () => {
      rafId = null;
      const next = computeVirtualRange(totalLines, viewport.scrollTop, viewport.clientHeight, lineHeightRef.current, rangeRef.current);
      if (next.start !== rangeRef.current.start || next.end !== rangeRef.current.end) {
        setRange(next);
      }
    };
    const schedule = () => {
      if (rafId === null) rafId = requestAnimationFrame(sync);
    };

    sync();
    viewport.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    return () => {
      viewport.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [virtualized, active, totalLines]);

  // 行号跳转：使用 O(1) 数学定位，兼容虚拟化与未渲染到 DOM 的深处行
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active || !target?.line) return;
    const viewport = container.closest<HTMLElement>("[data-file-viewport]");
    if (!viewport) return;

    const clampedLine = Math.max(1, Math.min(totalLines, target.line));
    const pre = preRef.current;
    const prePadTop = pre && typeof window !== "undefined" ? Number.parseFloat(window.getComputedStyle?.(pre)?.paddingTop ?? "") || 0 : 0;
    const targetTop = prePadTop + (clampedLine - 1) * lineHeightRef.current;
    const nextScrollTop = Math.max(0, targetTop - (viewport.clientHeight - lineHeightRef.current) / 2);
    viewport.scrollTop = nextScrollTop;

    if (virtualized) {
      setRange(computeVirtualRange(totalLines, nextScrollTop, viewport.clientHeight, lineHeightRef.current));
    }
  }, [code, totalLines, virtualized, target?.line, target?.requestId, active]);

  // 后台 Worker 增量语法高亮：仅当新到的分块与当前渲染窗口重叠时才触发重渲染
  const highlightKey = `${language}\0${code}`;
  const cachedTokens = useMemo(
    () => (isPlainHighlightLanguage(language) ? undefined : getCachedHighlight(code, language, DEFAULT_HIGHLIGHT_THEMES)),
    [code, language],
  );
  const tokensStoreRef = useRef<{ key: string; lines: (HighlightLine | undefined)[] }>({
    key: highlightKey,
    lines: cachedTokens ? [...cachedTokens] : [],
  });
  if (tokensStoreRef.current.key !== highlightKey) {
    tokensStoreRef.current = {
      key: highlightKey,
      lines: cachedTokens ? [...cachedTokens] : [],
    };
  }
  const [, setTokenVersion] = useState(0);

  useEffect(() => {
    if (!active || cachedTokens || isPlainHighlightLanguage(language) || !code) return;
    const store = tokensStoreRef.current;
    const cancel = requestHighlight({
      code,
      lines,
      language,
      themes: DEFAULT_HIGHLIGHT_THEMES,
      onChunk: (startLine, chunkLines) => {
        if (tokensStoreRef.current !== store) return;
        for (let i = 0; i < chunkLines.length; i++) {
          store.lines[startLine + i] = chunkLines[i];
        }
        const chunkEnd = startLine + chunkLines.length - 1;
        const { start, end } = rangeRef.current;
        // 仅当分块覆盖到当前已渲染窗口时刷新视图，后台其余分块零重渲染开销
        if (chunkEnd >= start && startLine <= end) {
          setTokenVersion((v) => v + 1);
        }
      },
    });
    return cancel;
  }, [active, cachedTokens, code, lines, language]);

  const activeTokens = cachedTokens ?? tokensStoreRef.current.lines;
  const renderStart = virtualized ? Math.min(range.start, Math.max(0, totalLines - 1)) : 0;
  const renderEnd = virtualized ? Math.min(range.end, Math.max(0, totalLines - 1)) : Math.max(0, totalLines - 1);
  const paddingTop = virtualized ? renderStart * lineHeight : 0;
  const paddingBottom = virtualized ? Math.max(0, totalLines - 1 - renderEnd) * lineHeight : 0;
  const selectedStart = target?.line;
  const selectedEnd = target?.line ? (target.endLine ?? target.line) : undefined;

  const visibleNodes = [];
  for (let index = renderStart; index <= renderEnd; index++) {
    const lineNumber = index + 1;
    const selected = Boolean(selectedStart && selectedEnd && lineNumber >= selectedStart && lineNumber <= selectedEnd);
    const rawLine = lines[index] ?? "";
    const tokenLine = activeTokens[index];
    visibleNodes.push(
      <span key={index}>
        <span
          className="line"
          data-file-line={lineNumber}
          data-file-selected={selected ? "true" : undefined}
        >
          {renderHighlightLine(tokenLine, rawLine)}
        </span>
        {index < renderEnd ? "\n" : ""}
      </span>,
    );
  }

  return (
    <CodeContextMenu path={path} relativePath={relativePath}>
      <div
        ref={containerRef}
        tabIndex={0}
        className="q-workspace-file-content focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <div className="aui-shiki-base min-h-full">
          <pre
            ref={preRef}
            className="shiki m-0 overflow-x-auto rounded-none border-0 bg-transparent px-3 py-2.5 text-xs leading-relaxed"
          >
            <code
              className="block"
              style={virtualized ? { paddingTop, paddingBottom } : undefined}
            >
              {visibleNodes}
            </code>
          </pre>
        </div>
      </div>
    </CodeContextMenu>
  );
});
