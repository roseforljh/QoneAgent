import { lazy, Suspense, type FC } from "react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { useAuiState } from "@assistant-ui/react";

const Shiki = lazy(async () => ({ default: (await import("./elements/shiki-highlighter.aui")).SyntaxHighlighter }));
const Prism = lazy(async () => ({ default: (await import("./elements/syntax-highlighter")).SyntaxHighlighter }));
const Mermaid = lazy(async () => ({ default: (await import("./elements/mermaid-diagram.aui")).MermaidDiagram }));
const GenerativeUI = lazy(async () => ({ default: (await import("./generative-ui-block")).GenerativeUIBlock }));

const Fallback: FC<SyntaxHighlighterProps> = ({ code }) => <pre className="aui-md-pre max-h-[46dvh] overflow-auto rounded-b-xl border border-border/50 bg-muted/30 p-3.5 text-[13px]"><code>{code}</code></pre>;

export const ShikiCode: FC<SyntaxHighlighterProps> = (props) => <Suspense fallback={<Fallback {...props} />}><Shiki {...props} /></Suspense>;
export const PrismCode: FC<SyntaxHighlighterProps> = (props) => {
  const streaming = useAuiState((state) => state.optional.part?.status.type === "running");
  return streaming ? <Fallback {...props} /> : <Suspense fallback={<Fallback {...props} />}><Prism {...props} /></Suspense>;
};
export const MermaidCode: FC<SyntaxHighlighterProps> = (props) => <Suspense fallback={<Fallback {...props} />}><Mermaid {...props} /></Suspense>;
export const GenerativeUICode: FC<SyntaxHighlighterProps> = (props) => {
  const streaming = useAuiState((state) => state.optional.part?.status.type === "running");
  return streaming ? <Fallback {...props} /> : <Suspense fallback={<Fallback {...props} />}><GenerativeUI {...props} /></Suspense>;
};
