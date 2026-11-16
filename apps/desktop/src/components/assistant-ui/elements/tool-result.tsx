import { useLocale } from "../../../localization";
"use client";

import { lazy, Suspense, type FC } from "react";
import { Check, CircleSlash, LoaderCircle, X } from "lucide-react";
import { Image } from "./image";
import { cn } from "../../../lib/utils";
import { DiffViewer } from "./diff-viewer";
import { EllipsisDots } from "./surfaces";
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

function TerminalResult({ presentation, emptyText, running }: { presentation: Extract<ToolPresentation, { kind: "terminal" }>; emptyText?: string; running?: boolean }) {
  const { t } = useLocale();
  const output = presentation.output.trim();
  return (
    <div data-slot="tool-terminal-result" className="overflow-hidden rounded-xl border border-foreground/10 bg-background/45">
      <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground/75 [overflow-wrap:anywhere]">
        {output ? presentation.output : presentation.command?.trim() ? (
          <span data-slot="tool-terminal-command" className="text-foreground/75">{presentation.command}</span>
        ) : !running && <span className="text-foreground/45">{emptyText}</span>}
      </pre>
      {presentation.stderr && <div className="border-t border-foreground/10 px-3 py-2 text-rose-700 dark:text-rose-300"><span className="text-[10px]">{t("servers.view.stderr")}</span><pre className="whitespace-pre-wrap break-words font-mono">{presentation.stderr}</pre></div>}
      {(presentation.exitCode !== undefined || presentation.timedOut || presentation.truncated) && <div className="flex flex-wrap gap-3 border-t border-foreground/10 px-3 py-1.5 text-[10px] text-foreground/45">
        {presentation.exitCode !== undefined && <span>{t("servers.view.exit", { code: presentation.exitCode })}</span>}
        {presentation.timedOut && <span className="text-destructive">{t("servers.view.timeout")}</span>}
        {presentation.truncated && <span>{t("servers.view.truncated")}</span>}
      </div>}
      {!output && running && <div role="status" className="flex items-center gap-1 px-3 pb-2.5 text-foreground/45">
        {emptyText}<EllipsisDots />
      </div>}
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

const Highlighter = lazy(async () => ({ default: (await import("./shiki-highlighter")).SyntaxHighlighter }));
const STATUS_ICON = { running: LoaderCircle, ok: Check, error: X, cancelled: CircleSlash } as const;

/** codemode: the script, a live list of the tools it called, then its output. */
function ScriptResult({ presentation, running }: { presentation: Extract<ToolPresentation, { kind: "script" }>; running?: boolean }) {
  const { t } = useLocale();
  const output = presentation.output.trim();
  return (
    <div data-slot="tool-script-result" className="overflow-hidden rounded-xl border border-foreground/10 bg-background/45">
      {presentation.code && (
        <details className="group border-b border-foreground/10" open={!output && !presentation.calls.length}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-foreground/50 hover:text-foreground/75">
            <span className="font-mono text-[11px] uppercase tracking-wide">JavaScript</span>
            <span className="truncate font-mono text-foreground/40 group-open:hidden">{presentation.code.split("\n").find((line) => line.trim() && !line.startsWith("// @options"))?.trim()}</span>
          </summary>
          <div className="max-h-72 overflow-auto px-3 pb-2.5 text-xs [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0">
            <Suspense fallback={<pre className="font-mono">{presentation.code}</pre>}><Highlighter code={presentation.code} language="javascript" /></Suspense>
          </div>
        </details>
      )}
      {presentation.calls.length > 0 && (
        <ol className="divide-y divide-foreground/[0.06] border-b border-foreground/10">
          {presentation.calls.map((call) => {
            const Icon = STATUS_ICON[call.status];
            return (
              <li key={call.id} className="flex min-w-0 items-center gap-2 px-3 py-1.5" title={call.error ?? call.args}>
                <Icon size={12} className={cn("shrink-0", call.status === "running" && "animate-spin text-foreground/45", call.status === "ok" && "text-emerald-500", call.status === "error" && "text-destructive", call.status === "cancelled" && "text-foreground/35")} />
                <span className="shrink-0 font-mono text-foreground/80">{call.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground/40">{call.error ?? call.args}</span>
                {call.durationMs !== undefined && <span className="shrink-0 tabular-nums text-foreground/35">{call.durationMs < 1000 ? `${call.durationMs}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {output ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground/75 [overflow-wrap:anywhere]">{presentation.output}</pre>
        : running && <div role="status" className="flex items-center gap-1 px-3 py-2.5 text-foreground/45">{t("tool.scriptRunning")}<EllipsisDots /></div>}
      {presentation.images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pb-3">
          {presentation.images.map((item, index) => <div key={index} className="max-w-full overflow-hidden rounded-lg border border-foreground/10"><ToolImage image={item.src} /></div>)}
        </div>
      )}
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

export function ToolResultView({ presentation, className, emptyText, running = false }: { presentation: ToolPresentation; className?: string; emptyText?: string; running?: boolean }) {
  return (
    <ResultFrame className={className}>
      {presentation.kind === "diff" && <DiffResult presentation={presentation} />}
      {presentation.kind === "file" && <FileResult presentation={presentation} />}
      {presentation.kind === "terminal" && <TerminalResult presentation={presentation} emptyText={emptyText} running={running} />}
      {presentation.kind === "search" && <SearchResult presentation={presentation} />}
      {presentation.kind === "image" && <ImageResult presentation={presentation} />}
      {presentation.kind === "text" && <TextResult presentation={presentation} />}
      {presentation.kind === "script" && <ScriptResult presentation={presentation} running={running} />}
      {presentation.kind === "unknown" && <ToolFallback presentation={presentation} />}
    </ResultFrame>
  );
}
