import { useState, type ComponentProps } from "react";
import { openBrowserInDock } from "../../lib/browser-dock";
import { useStore } from "../../store";
import { InlineCitation } from "./elements/inline-citation";
import { parseMarkdownFileReference } from "../../lib/markdown-file-reference";
import { MarkdownFileLink } from "./markdown-file-link";
import { MarkdownWebLink } from "./markdown-web-link";

export function citationSource(href: string | undefined, label: unknown, title?: string) {
  if (typeof label !== "string") return null;
  const match = /^\[?(\d{1,3})\]?$/.exec(label.trim());
  if (!match || !href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return { domain: url.hostname, title: title || undefined, url: url.href, label: match[1] };
  } catch { return null; }
}

function CitationLink({ source }: { source: NonNullable<ReturnType<typeof citationSource>> }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const openSource = (url: string) => {
    openBrowserInDock(url, useStore.getState().currentSessionId);
  };
  return <InlineCitation sources={[source]} openIndex={openIndex} onOpenIndexChange={setOpenIndex} onOpenSource={openSource} />;
}

export function MarkdownLink({ className, href, title, children, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  const source = citationSource(href, children, title);
  if (source) return <CitationLink source={source} />;
  const reference = parseMarkdownFileReference(href);
  if (reference) return <MarkdownFileLink reference={reference} className={className} {...props}>{children}</MarkdownFileLink>;
  return <MarkdownWebLink href={href} title={title} className={className} {...props}>{children}</MarkdownWebLink>;
}

