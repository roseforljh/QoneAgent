import { useEffect, useRef } from "react";
import type { DockFileTarget } from "../../lib/dock-state";
import { SyntaxHighlighter } from "./elements/shiki-highlighter";
import { CodeContextMenu } from "./dock-context-menu";
import "./workspace-file-content.css";

/** Scroll only the file viewport; never pull the conversation along with it. */
export function locateFileLines(container: HTMLElement, target?: Pick<DockFileTarget, "line" | "endLine">): void {
  const lines = container.querySelectorAll<HTMLElement>("[data-file-line]");
  let selected: HTMLElement | undefined;
  for (const element of lines) {
    const line = Number(element.dataset.fileLine);
    const match = Boolean(target?.line && line >= target.line && line <= (target.endLine ?? target.line));
    if (match) { element.dataset.fileSelected = "true"; selected ??= element; }
    else delete element.dataset.fileSelected;
  }
  const viewport = container.closest<HTMLElement>("[data-file-viewport]");
  if (!selected || !viewport) return;
  const lineRect = selected.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  viewport.scrollTop = Math.max(0, viewport.scrollTop + lineRect.top - viewportRect.top - (viewport.clientHeight - lineRect.height) / 2);
}

export function WorkspaceFileContent({ code, language, target, active, path, relativePath }: {
  code: string;
  language: string;
  target?: DockFileTarget;
  active: boolean;
  path?: string;
  relativePath?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = ref.current;
    if (!container || !active) return;
    locateFileLines(container, target);
    // Shiki settles asynchronously. Reapply once its DOM replaces the plain lines.
    const observer = new MutationObserver(() => locateFileLines(container, target));
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [code, language, target?.requestId, active]);
  return <CodeContextMenu path={path} relativePath={relativePath}><div ref={ref} tabIndex={0} className="q-workspace-file-content focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
    <SyntaxHighlighter code={code} language={language} preserveWhitespace lineMarkers
      className="min-h-full [&_pre]:m-0! [&_pre]:rounded-none! [&_pre]:border-0! [&_pre]:bg-transparent! [&_pre]:px-3! [&_pre]:py-2.5! [&_pre]:text-xs! [&_pre]:leading-relaxed" />
  </div></CodeContextMenu>;
}
