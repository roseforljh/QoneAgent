import type { FC } from "react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { renderGenerativeUI } from "@assistant-ui/react-generative-ui";
import { styledGenerativeUILibrary } from "./elements/generative-ui";
import { cn } from "../../lib/utils";

export const GenerativeUISurface: FC<{ spec: unknown; embedded?: boolean }> = ({ spec, embedded = false }) => (
  <div data-slot="generative-ui-block" data-aui="root" className={cn(
    "max-h-[46dvh] overflow-auto border border-border/50 p-3",
    embedded ? "rounded-b-xl border-t-0" : "my-3 rounded-xl",
  )}>
    {renderGenerativeUI(spec, styledGenerativeUILibrary)}
  </div>
);

export const GenerativeUIBlock: FC<SyntaxHighlighterProps> = ({ code }) => {
  let spec: unknown;
  try {
    spec = JSON.parse(code) as unknown;
    if (!spec || typeof spec !== "object") throw new Error("Invalid UI spec");
  } catch {
    return <pre className="overflow-auto rounded-b-xl bg-muted/30 p-3 text-xs"><code>{code}</code></pre>;
  }
  return <GenerativeUISurface spec={spec} embedded />;
};
