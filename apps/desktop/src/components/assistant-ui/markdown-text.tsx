import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useRef, useState, type ComponentProps } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "../../lib/utils";

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
    <figure className="border-foreground/10 rounded-xl my-3 border">
      <div className="border-foreground/10 bg-foreground/[0.025] dark:bg-foreground/[0.04] rounded-t-xl flex h-9 items-center justify-between border-b px-3">
        <span className="text-muted-foreground font-mono text-[11px] [font-variant-ligatures:none]">table</span>
        <button type="button" onClick={copy} aria-label="Copy table as markdown" className="text-muted-foreground hover:text-foreground rounded-md grid size-6 place-items-center transition-colors">
          {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table ref={ref} className={cn("aui-md-table w-full border-separate border-spacing-0 text-[13px]", className)} {...props}>
          {children}
        </table>
      </div>
    </figure>
  );
}

const remarkPlugins = [remarkGfm];

const MarkdownTextImpl = () => {
  return <MarkdownTextPrimitive remarkPlugins={remarkPlugins} className="aui-md" components={defaultComponents} defer />;
};

export const MarkdownText = memo(MarkdownTextImpl);

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => <h1 className={cn("aui-md-h1 mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0", className)} {...props} />,
  h2: ({ className, ...props }) => <h2 className={cn("aui-md-h2 mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0", className)} {...props} />,
  h3: ({ className, ...props }) => <h3 className={cn("aui-md-h3 mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0", className)} {...props} />,
  h4: ({ className, ...props }) => <h4 className={cn("aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0", className)} {...props} />,
  h5: ({ className, ...props }) => <h5 className={cn("aui-md-h5 mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0", className)} {...props} />,
  h6: ({ className, ...props }) => <h6 className={cn("aui-md-h6 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0", className)} {...props} />,
  p: ({ className, ...props }) => <p className={cn("aui-md-p my-3 leading-relaxed first:mt-0 last:mb-0", className)} {...props} />,
  a: ({ className, ...props }) => <a className={cn("aui-md-a text-primary hover:text-primary/80 underline underline-offset-2", className)} {...props} />,
  blockquote: ({ className, ...props }) => <blockquote className={cn("aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-3 border-s-2 ps-4", className)} {...props} />,
  ul: ({ className, ...props }) => <ul className={cn("aui-md-ul marker:text-muted-foreground my-3 ms-5 list-disc [&>li]:mt-1", className)} {...props} />,
  ol: ({ className, ...props }) => <ol className={cn("aui-md-ol marker:text-muted-foreground my-3 ms-5 list-decimal [&>li]:mt-1", className)} {...props} />,
  hr: ({ className, ...props }) => <hr className={cn("aui-md-hr border-muted-foreground/20 my-3", className)} {...props} />,
  table: ({ className, ...props }) => <MarkdownTable className={className} {...props} />,
  th: ({ className, ...props }) => <th className={cn("aui-md-th border-foreground/10 border-b px-3 py-1.5 text-start font-medium [[align=center]]:text-center [[align=right]]:text-right", className)} {...props} />,
  td: ({ className, ...props }) => <td className={cn("aui-md-td border-foreground/10 border-b px-3 py-1.5 text-start [[align=center]]:text-center [[align=right]]:text-right", className)} {...props} />,
  tr: ({ className, ...props }) => <tr className={cn("aui-md-tr m-0 p-0", className)} {...props} />,
  li: ({ className, ...props }) => <li className={cn("aui-md-li leading-relaxed", className)} {...props} />,
  strong: ({ className, ...props }) => <strong className={cn("aui-md-strong font-semibold", className)} {...props} />,
  sup: ({ className, ...props }) => <sup className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)} {...props} />,
  pre: ({ className, ...props }) => <pre className={cn("aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-b-xl border border-t-0 p-3.5 text-[13px] leading-relaxed", className)} {...props} />,
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return <code className={cn(!isCodeBlock && "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]", className)} {...props} />;
  },
});
