import { useLocale } from "../../../localization";
"use client";

import { type ComponentProps, memo, useEffect, useMemo, useRef, useState } from "react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { cva, type VariantProps } from "class-variance-authority";
import { createTwoFilesPatch } from "diff";
import parseDiff from "parse-diff";

import {
  DEFAULT_HIGHLIGHT_THEMES,
  getCachedHighlight,
  isPlainHighlightLanguage,
  renderHighlightLine,
  requestHighlight,
  type HighlightLine,
} from "../../../lib/shiki-highlight";
import { cn } from "../../../lib/utils";

type DiffLineType = "add" | "del" | "normal" | "skip";

interface ParsedLine {
  type: DiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface ParsedFile {
  oldName?: string | undefined;
  newName?: string | undefined;
  lines: ParsedLine[];
  additions: number;
  deletions: number;
}

interface SplitLinePair {
  left: ParsedLine | null;
  right: ParsedLine | null;
}

function parsePatch(patch: string): ParsedFile[] {
  const files = parseDiff(patch);
  return files.map((file) => {
    const lines: ParsedLine[] = [];
    let additions = 0;
    let deletions = 0;
    let previousOldEnd = 1;
    for (const chunk of file.chunks) {
      if (chunk.oldStart > previousOldEnd) {
        lines.push({ type: "skip", content: "" });
      }
      let oldLine = chunk.oldStart;
      let newLine = chunk.newStart;
      for (const change of chunk.changes) {
        if (change.type === "add") {
          additions++;
          lines.push({
            type: "add",
            content: change.content.slice(1),
            newLineNumber: newLine++,
          });
        } else if (change.type === "del") {
          deletions++;
          lines.push({
            type: "del",
            content: change.content.slice(1),
            oldLineNumber: oldLine++,
          });
        } else {
          lines.push({
            type: "normal",
            content: change.content.slice(1),
            oldLineNumber: oldLine++,
            newLineNumber: newLine++,
          });
        }
      }
      previousOldEnd = oldLine;
    }
    return {
      oldName: file.from,
      newName: file.to,
      lines,
      additions,
      deletions,
    };
  });
}

function computeDiff(
  oldContent: string,
  newContent: string,
): { lines: ParsedLine[]; additions: number; deletions: number } {
  const file = parsePatch(createTwoFilesPatch("old", "new", oldContent, newContent))[0];
  return file ?? { lines: [], additions: 0, deletions: 0 };
}

function pairLinesForSplit(lines: ParsedLine[]): SplitLinePair[] {
  const pairs: SplitLinePair[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === "normal" || line.type === "skip") {
      pairs.push({ left: line, right: line });
      i++;
    } else if (line.type === "del") {
      const deletions: ParsedLine[] = [];
      while (i < lines.length && lines[i]!.type === "del") {
        deletions.push(lines[i]!);
        i++;
      }
      const additions: ParsedLine[] = [];
      while (i < lines.length && lines[i]!.type === "add") {
        additions.push(lines[i]!);
        i++;
      }
      const maxLen = Math.max(deletions.length, additions.length);
      for (let j = 0; j < maxLen; j++) {
        pairs.push({
          left: deletions[j] ?? null,
          right: additions[j] ?? null,
        });
      }
    } else {
      pairs.push({ left: null, right: line });
      i++;
    }
  }
  return pairs;
}

const diffViewerVariants = cva(
  "aui-diff-viewer overflow-hidden font-mono leading-relaxed [font-variant-ligatures:none]",
  {
    variants: {
      variant: {
        default:
          "border-foreground/10 bg-foreground/[0.025] dark:bg-foreground/[0.04] border",
        ghost: "bg-transparent",
        muted:
          "border-foreground/10 bg-foreground/[0.06] dark:bg-foreground/[0.08] border",
      },
      size: {
        sm: "text-xs",
        default: "text-[12.5px]",
        lg: "text-[13.5px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const diffLineVariants = cva("flex", {
  variants: {
    type: {
      add: "bg-[var(--diff-add-bg,var(--_diff-add-bg))] shadow-[inset_2px_0_0_var(--diff-add-rule,var(--color-green-500))] [--_diff-add-bg:color-mix(in_oklab,var(--color-green-500)_8%,transparent)] dark:[--_diff-add-bg:color-mix(in_oklab,var(--color-green-500)_15%,transparent)]",
      del: "bg-[var(--diff-del-bg,var(--_diff-del-bg))] shadow-[inset_2px_0_0_var(--diff-del-rule,var(--color-red-500))] [--_diff-del-bg:color-mix(in_oklab,var(--color-red-500)_8%,transparent)] dark:[--_diff-del-bg:color-mix(in_oklab,var(--color-red-500)_15%,transparent)]",
      normal: "",
      skip: "text-foreground/35",
      empty: "",
    },
  },
  defaultVariants: {
    type: "normal",
  },
});

const diffLineTextVariants = cva("", {
  variants: {
    type: {
      add: "text-[var(--diff-add-text,var(--color-green-600))] dark:text-[var(--diff-add-text-dark,var(--color-green-400))]",
      del: "text-[var(--diff-del-text,var(--color-red-600))] dark:text-[var(--diff-del-text-dark,var(--color-red-400))]",
      normal: "",
      skip: "text-foreground/35",
      empty: "",
    },
  },
  defaultVariants: {
    type: "normal",
  },
});

function getFileExtension(filename?: string): string {
  const ext = filename?.split(".").pop()?.toLowerCase();
  if (!ext) return "";
  return ext.toUpperCase();
}

function DiffViewerFileBadge({ filename }: { filename?: string | undefined }) {
  const ext = getFileExtension(filename);
  if (!ext) return null;

  return (
    <span
      data-slot="diff-viewer-file-badge"
      className="border-foreground/15 text-muted-foreground/70 inline-flex h-4 shrink-0 items-center border px-1 text-[9px] leading-none font-medium tracking-wide"
    >
      {ext}
    </span>
  );
}

function DiffViewerStats({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span
      data-slot="diff-viewer-stats"
      className="flex shrink-0 gap-1.5 text-xs tabular-nums"
    >
      <span className="text-green-600 dark:text-green-400">+{additions}</span>
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  );
}

function DiffViewerFile({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="diff-viewer-file" className={cn(className)} {...props} />
  );
}

function DiffViewerContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="diff-viewer-content"
      className={cn("overflow-x-auto", className)}
      {...props}
    />
  );
}

interface DiffViewerHeaderProps extends ComponentProps<"div"> {
  oldName?: string | undefined;
  newName?: string | undefined;
  additions?: number;
  deletions?: number;
  showIcon?: boolean;
  showStats?: boolean;
}

function DiffViewerHeader({
  oldName,
  newName,
  additions = 0,
  deletions = 0,
  showIcon = false,
  showStats = true,
  className,
  ...props
}: DiffViewerHeaderProps) {
  if (!oldName && !newName) return null;

  const displayName = newName || oldName;

  return (
    <div
      data-slot="diff-viewer-header"
      className={cn(
        "border-foreground/10 text-muted-foreground flex h-9 items-center gap-2 border-b ps-3.5 pe-3 text-xs font-medium tracking-wide",
        className,
      )}
      {...props}
    >
      {showIcon && <DiffViewerFileBadge filename={displayName} />}
      <span className="min-w-0 flex-1 truncate">
        {oldName && newName && oldName !== newName ? (
          <>
            <span className="text-muted-foreground/60">{oldName}</span>
            <span className="text-muted-foreground/50">{" → "}</span>
            <span className="text-foreground/80">{newName}</span>
          </>
        ) : (
          displayName
        )}
      </span>
      {showStats && (additions > 0 || deletions > 0) && (
        <DiffViewerStats additions={additions} deletions={deletions} />
      )}
    </div>
  );
}

interface DiffViewerLineProps extends ComponentProps<"div"> {
  line: ParsedLine;
  showLineNumbers?: boolean;
  language?: string;
  tokens?: HighlightLine;
}

function DiffViewerLine({
  line,
  showLineNumbers = true,
  language: _language,
  tokens,
  className,
  ...props
}: DiffViewerLineProps) {
  const indicator = line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "skip" ? "…" : " ";

  return (
    <div
      data-slot="diff-viewer-line"
      data-type={line.type}
      className={cn(diffLineVariants({ type: line.type }), className)}
      {...props}
    >
      {showLineNumbers && (
        <span
          data-slot="diff-viewer-line-number"
          className="text-muted-foreground/40 w-10 shrink-0 px-2 text-end tabular-nums select-none"
        >
          {line.type === "skip"
            ? ""
            : line.type === "del"
            ? line.oldLineNumber
            : line.type === "add"
              ? line.newLineNumber
              : line.oldLineNumber}
        </span>
      )}
      <span
        data-slot="diff-viewer-indicator"
        className={cn(
          "w-4 shrink-0 text-center select-none",
          diffLineTextVariants({ type: line.type }),
        )}
      >
        {indicator}
      </span>
      <span
        data-slot="diff-viewer-content"
        className="flex-1 pe-3.5 break-all whitespace-pre-wrap"
      >
        {line.type === "skip" ? "" : renderHighlightLine(tokens, line.content)}
      </span>
    </div>
  );
}

interface DiffViewerSplitLineProps extends ComponentProps<"div"> {
  pair: SplitLinePair;
  showLineNumbers?: boolean;
  language?: string;
  leftTokens?: HighlightLine;
  rightTokens?: HighlightLine;
}

function DiffViewerSplitLine({
  pair,
  showLineNumbers = true,
  language: _language,
  leftTokens,
  rightTokens,
  className,
  ...props
}: DiffViewerSplitLineProps) {
  const { left, right } = pair;

  return (
    <div
      data-slot="diff-viewer-split-line"
      className={cn("flex", className)}
      {...props}
    >
      <div
        data-slot="diff-viewer-split-left"
        data-type={left?.type ?? "empty"}
        className={cn(
          "border-foreground/10 flex w-1/2 border-e",
          diffLineVariants({ type: left?.type ?? "empty" }),
        )}
      >
        {showLineNumbers && (
          <span className="text-muted-foreground/40 w-10 shrink-0 px-2 text-end tabular-nums select-none">
            {left?.type === "skip" ? "" : left?.oldLineNumber ?? ""}
          </span>
        )}
        <span
          className={cn(
            "w-4 shrink-0 text-center select-none",
            diffLineTextVariants({ type: left?.type ?? "empty" }),
          )}
        >
          {left ? (left.type === "skip" ? "…" : left.type === "del" ? "-" : " ") : ""}
        </span>
        <span className="flex-1 pe-3.5 break-all whitespace-pre-wrap">
          {left && left.type !== "skip" ? renderHighlightLine(leftTokens, left.content) : ""}
        </span>
      </div>
      <div
        data-slot="diff-viewer-split-right"
        data-type={right?.type ?? "empty"}
        className={cn(
          "flex w-1/2",
          diffLineVariants({ type: right?.type ?? "empty" }),
        )}
      >
        {showLineNumbers && (
          <span className="text-muted-foreground/40 w-10 shrink-0 px-2 text-end tabular-nums select-none">
            {right?.type === "skip" ? "" : right?.newLineNumber ?? ""}
          </span>
        )}
        <span
          className={cn(
            "w-4 shrink-0 text-center select-none",
            diffLineTextVariants({ type: right?.type ?? "empty" }),
          )}
        >
          {right ? (right.type === "skip" ? "…" : right.type === "add" ? "+" : " ") : ""}
        </span>
        <span className="flex-1 pe-3.5 break-all whitespace-pre-wrap">
          {right && right.type !== "skip" ? renderHighlightLine(rightTokens, right.content) : ""}
        </span>
      </div>
    </div>
  );
}

const DIFF_CHUNK_SIZE = 50;

/** 按文件整体在 Shiki Worker 中分块高亮，避免为每一行单独注册 hook 导致 N 倍阻塞 */
function useDiffFileTokens(lines: readonly ParsedLine[], language: string | undefined): ReadonlyMap<ParsedLine, HighlightLine> | undefined {
  const lang = language ?? "text";
  const rawLines = useMemo(() => lines.map((line) => (line.type === "skip" ? "" : line.content)), [lines]);
  const joinedCode = useMemo(() => (isPlainHighlightLanguage(lang) ? "" : rawLines.join("\n")), [lang, rawLines]);
  const cached = useMemo(
    () => (joinedCode ? getCachedHighlight(joinedCode, lang, DEFAULT_HIGHLIGHT_THEMES) : undefined),
    [joinedCode, lang],
  );
  const key = `${lang}\0${joinedCode}`;
  const bufferRef = useRef<{ key: string; lines: (HighlightLine | undefined)[] }>({
    key,
    lines: cached ? [...cached] : [],
  });
  if (bufferRef.current.key !== key) {
    bufferRef.current = { key, lines: cached ? [...cached] : [] };
  }
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (cached || !joinedCode || isPlainHighlightLanguage(lang)) return;
    const buffer = bufferRef.current;
    return requestHighlight({
      code: joinedCode,
      lines: rawLines,
      language: lang,
      themes: DEFAULT_HIGHLIGHT_THEMES,
      onChunk: (startLine, chunkLines) => {
        if (bufferRef.current !== buffer) return;
        for (let i = 0; i < chunkLines.length; i++) {
          buffer.lines[startLine + i] = chunkLines[i];
        }
        setVersion((v) => v + 1);
      },
    });
  }, [cached, joinedCode, lang, rawLines]);

  return useMemo(() => {
    const source = cached ?? bufferRef.current.lines;
    if (!source.length) return undefined;
    const map = new Map<ParsedLine, HighlightLine>();
    for (let i = 0; i < lines.length; i++) {
      const tokenLine = source[i];
      if (tokenLine) map.set(lines[i]!, tokenLine);
    }
    return map;
    // version 用于触发分块到达后的 Map 重建
  }, [cached, lines, version]);
}

const DiffViewerFileSection = memo(function DiffViewerFileSection({
  file,
  splitPairs,
  viewMode,
  showHeader,
  showIcon,
  showStats,
  showLineNumbers,
  language,
}: {
  file: ParsedFile;
  splitPairs: SplitLinePair[];
  viewMode: "split" | "unified";
  showHeader: boolean;
  showIcon: boolean;
  showStats: boolean;
  showLineNumbers: boolean;
  language?: string;
}) {
  const tokenMap = useDiffFileTokens(file.lines, language);
  const items = viewMode === "split" ? splitPairs : file.lines;
  const chunked = items.length > 80;

  return (
    <div
      data-slot="diff-viewer-file"
      className="border-foreground/10 [contain-intrinsic-size:auto_240px] [content-visibility:auto] not-first:border-t"
    >
      {showHeader && <DiffViewerHeader
        oldName={file.oldName}
        newName={file.newName}
        additions={file.additions}
        deletions={file.deletions}
        showIcon={showIcon}
        showStats={showStats}
      />}
      <div data-slot="diff-viewer-content" className="overflow-x-auto py-2">
        {!chunked
          ? (viewMode === "split"
              ? splitPairs.map((pair, pairIndex) => (
                  <DiffViewerSplitLine
                    key={pairIndex}
                    pair={pair}
                    showLineNumbers={showLineNumbers}
                    language={language}
                    leftTokens={pair.left ? tokenMap?.get(pair.left) : undefined}
                    rightTokens={pair.right ? tokenMap?.get(pair.right) : undefined}
                  />
                ))
              : file.lines.map((line, lineIndex) => (
                  <DiffViewerLine
                    key={lineIndex}
                    line={line}
                    showLineNumbers={showLineNumbers}
                    language={language}
                    tokens={tokenMap?.get(line)}
                  />
                )))
          : Array.from({ length: Math.ceil(items.length / DIFF_CHUNK_SIZE) }, (_, chunkIndex) => {
              const start = chunkIndex * DIFF_CHUNK_SIZE;
              const end = Math.min(items.length, start + DIFF_CHUNK_SIZE);
              return (
                <div
                  key={chunkIndex}
                  className="[contain-intrinsic-size:auto_1000px] [content-visibility:auto]"
                >
                  {viewMode === "split"
                    ? splitPairs.slice(start, end).map((pair, offset) => (
                        <DiffViewerSplitLine
                          key={start + offset}
                          pair={pair}
                          showLineNumbers={showLineNumbers}
                          language={language}
                          leftTokens={pair.left ? tokenMap?.get(pair.left) : undefined}
                          rightTokens={pair.right ? tokenMap?.get(pair.right) : undefined}
                        />
                      ))
                    : file.lines.slice(start, end).map((line, offset) => (
                        <DiffViewerLine
                          key={start + offset}
                          line={line}
                          showLineNumbers={showLineNumbers}
                          language={language}
                          tokens={tokenMap?.get(line)}
                        />
                      ))}
                </div>
              );
            })}
      </div>
    </div>
  );
});

export type DiffViewerProps = Partial<SyntaxHighlighterProps> &
  VariantProps<typeof diffViewerVariants> & {
    patch?: string;
    oldFile?: { content: string; name?: string };
    newFile?: { content: string; name?: string };
    viewMode?: "split" | "unified";
    showLineNumbers?: boolean;
    showIcon?: boolean;
    showStats?: boolean;
    /** Off when an enclosing row already names the file and its counts. */
    showHeader?: boolean;
    className?: string;
  };

function DiffViewer({
  code,
  patch,
  oldFile,
  newFile,
  viewMode = "unified",
  showLineNumbers = true,
  showIcon = false,
  showStats = true,
  showHeader = true,
  language,
  variant,
  size,
  className,
}: DiffViewerProps) {
  const { t } = useLocale();
  const diffPatch = patch ?? code;
  const oldContent = oldFile?.content;
  const oldName = oldFile?.name;
  const newContent = newFile?.content;
  const newName = newFile?.name;

  const parsedFiles = useMemo<ParsedFile[]>(() => {
    if (diffPatch) {
      return parsePatch(diffPatch);
    }
    if (oldContent !== undefined && newContent !== undefined) {
      const { lines, additions, deletions } = computeDiff(
        oldContent,
        newContent,
      );
      return [
        {
          oldName,
          newName,
          lines,
          additions,
          deletions,
        },
      ];
    }
    return [];
  }, [diffPatch, oldContent, oldName, newContent, newName]);

  const splitLinePairs = useMemo<SplitLinePair[][]>(() => {
    if (viewMode !== "split") return [];
    return parsedFiles.map((file) => pairLinesForSplit(file.lines));
  }, [parsedFiles, viewMode]);

  if (parsedFiles.length === 0) {
    return (
      <pre
        data-slot="diff-viewer"
        className={cn(
          "border-foreground/10 bg-foreground/[0.025] dark:bg-foreground/[0.04] text-muted-foreground border px-3.5 py-3 font-mono text-xs",
          className,
        )}
      >{t("code.noDiff")}</pre>
    );
  }

  return (
    <div
      data-slot="diff-viewer"
      data-view-mode={viewMode}
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      className={cn(diffViewerVariants({ variant, size }), className)}
    >
      {parsedFiles.map((file, fileIndex) => (
        <DiffViewerFileSection
          key={fileIndex}
          file={file}
          splitPairs={splitLinePairs[fileIndex] ?? []}
          viewMode={viewMode}
          showHeader={showHeader}
          showIcon={showIcon}
          showStats={showStats}
          showLineNumbers={showLineNumbers}
          language={language}
        />
      ))}
    </div>
  );
}

DiffViewer.displayName = "DiffViewer";

export type { ParsedLine, ParsedFile, SplitLinePair };

export {
  DiffViewer,
  DiffViewerFile,
  DiffViewerHeader,
  DiffViewerContent,
  DiffViewerLine,
  DiffViewerSplitLine,
  DiffViewerFileBadge,
  DiffViewerStats,
  diffViewerVariants,
  diffLineVariants,
  diffLineTextVariants,
  parsePatch,
  computeDiff,
};
