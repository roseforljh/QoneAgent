import { useContext, type ComponentProps, type CSSProperties } from "react";
import { useStore } from "../../store";
import { fileReferenceLabel, type MarkdownFileReference } from "../../lib/markdown-file-reference";
import { markdownFileIcon } from "../../lib/markdown-file-icon";
import { openWorkspaceFile, resolveFileReferencePath } from "../../lib/workspace-file-navigation";
import { FileReferenceContext } from "../../lib/file-reference-context";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import "./markdown-file-link.css";

export function MarkdownFileLink({ reference, children, className, style, ...props }: Omit<ComponentProps<"a">, "href" | "onClick" | "title"> & { reference: MarkdownFileReference }) {
  const sessionId = useStore((state) => state.currentSessionId);
  const workspace = useStore((state) => {
    const workspaceId = state.sessions.find((session) => session.id === state.currentSessionId)?.workspaceId;
    return state.workspaces.find((item) => item.id === workspaceId);
  });
  const context = useContext(FileReferenceContext);
  const fullPath = resolveFileReferencePath(reference.path, context?.directory ?? workspace?.path, context?.root);
  const enabled = Boolean(fullPath && (context || sessionId || workspace));
  const label = fileReferenceLabel({ ...reference, path: fullPath ?? reference.path });
  const navigate = () => {
    if (!enabled || !fullPath) return;
    openWorkspaceFile({ ...reference, sessionId: context?.sessionId ?? sessionId, workspaceId: context?.workspaceId ?? workspace?.id, path: fullPath });
  };
  return <TooltipProvider><Tooltip><TooltipTrigger asChild>
    <a {...props} role="button" tabIndex={enabled ? 0 : -1} aria-disabled={!enabled || undefined}
      data-file-reference={reference.path} className={cn("q-markdown-file-link", className)}
      style={{ ...style, "--q-file-link-icon": `url("${markdownFileIcon(reference.path)}")` } as CSSProperties}
      onClick={(event) => { event.preventDefault(); navigate(); }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault(); navigate();
      }}
    >{children}</a>
  </TooltipTrigger><TooltipContent sideOffset={6} className="max-w-[min(36rem,calc(100vw-24px))] break-all rounded-xl border border-border/40 bg-popover text-popover-foreground shadow-lg [&>svg]:hidden">
    {label}
  </TooltipContent></Tooltip></TooltipProvider>;
}
