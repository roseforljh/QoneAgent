import { unstable_memoizeMarkdownComponents as memoizeMarkdownComponents, useIsMarkdownCodeBlock } from "@assistant-ui/react-markdown";
import { memo, useRef, useState, type ComponentProps } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { openBrowserInDock } from "../../lib/browser-dock";
import { InlineCitation } from "./elements/inline-citation";
import { MathBlock } from "./elements/math-block";
import { MarkdownText as OfficialMarkdownText } from "./elements/markdown-text";
import "katex/dist/katex.min.css";

function useCopyToClipboard() {
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    });
  };
  return { isCopied, copyToClipboard };
}

function MarkdownTable({ className, children, ...props }: ComponentProps<"table">) {
  const ref = useRef<HTMLTableElement>(null);
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  const copy = () => {
    const table = ref.current;
    if (!table) return;
    const rows = [...table.querySelectorAll("tr")].map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) =>
        (cell.textContent ?? "").replace(/\s+/g, " ").trim().replace(/[\\|]/g, "\\$&"),
      ),
    );
    if (rows.length === 0) return;
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
    const [header, ...body] = rows;
    copyToClipboard([pad(header!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(pad)].join("\n"));
  };

  return (
    <div className="group/table relative my-3.5 overflow-hidden rounded-lg border border-border/60 dark:border-border/40 bg-card/20 shadow-2xs">
      <button
        type="button"
        onClick={copy}
        aria-label="Copy table as markdown"
        className="absolute top-1.5 right-1.5 z-10 grid size-7 place-items-center rounded-md border border-border/50 bg-background/80 text-muted-foreground opacity-0 backdrop-blur-xs transition-opacity duration-150 hover:bg-muted hover:text-foreground group-hover/table:opacity-100"
      >
        {isCopied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />}
      </button>
      <div className="overflow-x-auto">
        <table ref={ref} className={cn("aui-md-table w-full border-separate border-spacing-0 text-[13.5px]", className)} {...props}>
          {children}
        </table>
      </div>
    </div>
  );
}

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
    openBrowserInDock(url);
  };
  return <InlineCitation sources={[source]} openIndex={openIndex} onOpenIndexChange={setOpenIndex} onOpenSource={openSource} />;
}

export function MathSpan({ className, children, ...props }: ComponentProps<"span">) {
  if (className?.split(/\s+/).includes("katex-display")) return (
    <MathBlock steps={[{ expression: <span className={className} {...props}>{children}</span> }]} visibleSteps={1} className="my-3 max-w-none" />
  );
  return <span className={className} {...props}>{children}</span>;
}

const MarkdownTextImpl = () => {
  return <OfficialMarkdownText components={defaultComponents} />;
};

export const MarkdownText = memo(MarkdownTextImpl);

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => <h1 className={cn("aui-md-h1 mt-6 mb-2.5 scroll-m-20 text-xl font-bold tracking-tight text-foreground first:mt-0 last:mb-0", className)} {...props} />,
  h2: ({ className, ...props }) => <h2 className={cn("aui-md-h2 mt-5 mb-2 scroll-m-20 text-lg font-semibold tracking-tight text-foreground first:mt-0 last:mb-0", className)} {...props} />,
  h3: ({ className, ...props }) => <h3 className={cn("aui-md-h3 mt-4 mb-1.5 scroll-m-20 text-[15.5px] font-semibold text-foreground first:mt-0 last:mb-0", className)} {...props} />,
  h4: ({ className, ...props }) => <h4 className={cn("aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-[14.5px] font-medium text-foreground first:mt-0 last:mb-0", className)} {...props} />,
  h5: ({ className, ...props }) => <h5 className={cn("aui-md-h5 mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0", className)} {...props} />,
  h6: ({ className, ...props }) => <h6 className={cn("aui-md-h6 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0", className)} {...props} />,
  p: ({ className, ...props }) => <p className={cn("aui-md-p my-2.5 text-[15px] leading-[1.72] text-foreground/90 first:mt-0 last:mb-0", className)} {...props} />,
  a: ({ className, href, title, children, ...props }) => {
    const source = citationSource(href, children, title);
    if (source) return <CitationLink source={source} />;
    return <a
      href={href}
      title={title}
      className={cn("aui-md-a text-primary hover:text-primary/80 underline underline-offset-2", className)}
      onClick={(event) => {
        if (!href) return;
        event.preventDefault();
        openBrowserInDock(href);
      }}
      {...props}
    >{children}</a>;
  },
  blockquote: ({ className, ...props }) => <blockquote className={cn("aui-md-blockquote border-s-2 border-primary/50 bg-foreground/[0.02] dark:bg-foreground/[0.04] text-muted-foreground my-3 rounded-r-md py-1.5 ps-3.5 italic", className)} {...props} />,
  ul: ({ className, ...props }) => <ul className={cn("aui-md-ul marker:text-muted-foreground/60 my-2.5 ms-5 list-disc space-y-1 text-[15px] leading-[1.7] text-foreground/90 [&>li]:mt-0.5", className)} {...props} />,
  ol: ({ className, ...props }) => <ol className={cn("aui-md-ol marker:text-muted-foreground/60 my-2.5 ms-5 list-decimal space-y-1 text-[15px] leading-[1.7] text-foreground/90 [&>li]:mt-0.5", className)} {...props} />,
  hr: ({ className, ...props }) => <hr className={cn("aui-md-hr border-border/40 my-4", className)} {...props} />,
  table: ({ className, ...props }) => <MarkdownTable className={className} {...props} />,
  th: ({ className, ...props }) => <th className={cn("aui-md-th bg-muted/40 border-b border-border/50 px-3.5 py-2 text-start font-semibold text-xs text-foreground/85 [[align=center]]:text-center [[align=right]]:text-right", className)} {...props} />,
  td: ({ className, ...props }) => <td className={cn("aui-md-td border-b border-border/30 px-3.5 py-2 text-start text-foreground/80 [[align=center]]:text-center [[align=right]]:text-right", className)} {...props} />,
  tr: ({ className, ...props }) => <tr className={cn("aui-md-tr m-0 p-0 transition-colors hover:bg-foreground/[0.02]", className)} {...props} />,
  li: ({ className, ...props }) => <li className={cn("aui-md-li leading-relaxed", className)} {...props} />,
  strong: ({ className, ...props }) => <strong className={cn("aui-md-strong font-semibold text-foreground", className)} {...props} />,
  span: MathSpan,
  sup: ({ className, ...props }) => <sup className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)} {...props} />,
  pre: ({ className, ...props }) => <pre className={cn("aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-b-xl border border-t-0 p-3.5 text-sm leading-relaxed", className)} {...props} />,
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return <code className={cn(!isCodeBlock && "aui-md-inline-code bg-foreground/[0.05] dark:bg-foreground/[0.08] text-foreground/90 rounded px-1.5 py-0.5 font-mono text-[12.5px] border border-border/30", className)} {...props} />;
  },
});
