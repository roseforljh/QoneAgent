import { useLocale } from "../../../localization";
"use client";

import type { FC } from "react";
import { Image } from "./image";
import { cn } from "../../../lib/utils";
import { DiffViewer } from "./diff-viewer";
import type { ToolPresentation } from "../tool-presentation";

const ToolImage = Image as unknown as FC<{ image: string; filename?: string }>;

function ResultFrame({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div data-slot="tool-result" className={cn("min-w-0 text-xs", className)}>{children}</div>;
}

function DiffResult({ presentation }: { presentation: Extract<ToolPresentation, { kind: "diff" }> }) {
  return (
    <div className="rounded-xl">
      <DiffViewer
        patch={presentation.patch}
        oldFile={presentation.oldFile}
        newFile={presentation.newFile}
        showIcon
        showStats
        size="default"
        className="min-w-full"
      />
    </div>
  );
}

function FileResult({ presentation }: { presentation: Extract<ToolPresentation, { kind: "file" }> }) {
  return (
    <div data-slot="tool-file-result" className="overflow-hidden rounded-xl border border-foreground/10 bg-background/40">
      {presentation.name && (
        <div className="border-b border-foreground/10 px-3 py-2 font-mono text-xs text-foreground/50">
          {presentation.name}
        </div>
      )}
      <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground/80 [overflow-wrap:anywhere]">
        {presentation.content}
      </pre>
    </div>
  );
}

function TerminalResult({ presentation, emptyText }: { presentation: Extract<ToolPresentation, { kind: "terminal" }>; emptyText?: string }) {
  return (
    <div data-slot="tool-terminal-result" className="overflow-hidden rounded-xl border border-foreground/10 bg-background/45">
      <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground/75 [overflow-wrap:anywhere]">
        {presentation.output.trim() ? presentation.output : <span className="text-foreground/45">{emptyText}</span>}
      </pre>
    </div>
  );
}

function SearchResult({ presentation }: { presentation: Extract<ToolPresentation, { kind: "search" }> }) {
  const { t } = useLocale();
  return (
    <div data-slot="tool-search-result" className="overflow-hidden rounded-xl border border-foreground/10 bg-background/40">
      {presentation.query && <div className="border-b border-foreground/10 px-3 py-2 font-mono text-xs text-foreground/50">{presentation.query}</div>}
      {presentation.items.length > 0 ? (
        <ul className="divide-y divide-foreground/[0.06]">
          {presentation.items.map((item, index) => (
            <li key={`${item.path ?? "result"}-${item.line ?? index}-${index}`} className="flex min-w-0 gap-2 px-3 py-1.5 font-mono text-xs leading-relaxed">
              {item.path && <span className="shrink-0 text-foreground/50">{item.path}{item.line !== undefined ? `:${item.line}` : ""}</span>}
              <span className="min-w-0 whitespace-pre-wrap break-words text-foreground/75 [overflow-wrap:anywhere]">{item.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2.5 text-foreground/70">{presentation.text ?? t("chat.noToolResults")}</p>
      )}
    </div>
  );
}

function ImageResult({ presentation }: { presentation: Extract<ToolPresentation, { kind: "image" }> }) {
  return (
    <div data-slot="tool-image-result" className="max-w-full overflow-hidden rounded-xl border border-foreground/10 bg-background/40">
      <ToolImage image={presentation.src} filename={presentation.name} />
    </div>
  );
}

function TextResult({ presentation }: { presentation: Extract<ToolPresentation, { kind: "text" }> }) {
  return (
    <p data-slot="tool-text-result" className="whitespace-pre-wrap break-words px-1 py-1 leading-relaxed text-foreground/80 [overflow-wrap:anywhere]">
      {presentation.text}
    </p>
  );
}

export function ToolFallback({ presentation }: { presentation: Extract<ToolPresentation, { kind: "unknown" }> }) {
  const { t } = useLocale();
  return (
    <details data-slot="tool-fallback" className="rounded-xl border border-foreground/10 bg-background/35 px-3 py-2">
      <summary className="cursor-pointer text-xs text-foreground/50">{t("chat.debugFallback")}</summary>
      {presentation.text && <p className="mt-2 whitespace-pre-wrap break-words text-foreground/75">{presentation.text}</p>}
      <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/60 [overflow-wrap:anywhere]">
        {presentation.debugJson}
      </pre>
    </details>
  );
}

export function ToolResultView({ presentation, className, emptyText }: { presentation: ToolPresentation; className?: string; emptyText?: string }) {
  return (
    <ResultFrame className={className}>
      {presentation.kind === "diff" && <DiffResult presentation={presentation} />}
      {presentation.kind === "file" && <FileResult presentation={presentation} />}
      {presentation.kind === "terminal" && <TerminalResult presentation={presentation} emptyText={emptyText} />}
      {presentation.kind === "search" && <SearchResult presentation={presentation} />}
      {presentation.kind === "image" && <ImageResult presentation={presentation} />}
      {presentation.kind === "text" && <TextResult presentation={presentation} />}
      {presentation.kind === "unknown" && <ToolFallback presentation={presentation} />}
    </ResultFrame>
  );
}
