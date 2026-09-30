import { memo, useCallback, useState } from "react";
import { useAuiState, useThreadViewportStore, type ReasoningMessagePartComponent } from "@assistant-ui/react";
import ReactMarkdown from "react-markdown";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { CodexChevronRightIcon } from "./execution-icons";
import { MeasuredCollapse } from "./elements/measured-collapse";
import { FadeScroll, regionViewport, ShimmerLabel } from "./elements/surfaces";
import { useLocale } from "../../localization";
import "./reasoning.css";

// Disclosure and fade state changes must not reparse the entire reasoning text.
const ReasoningText = memo(function ReasoningText({ text }: { text: string }) {
  return <ReactMarkdown allowedElements={["p", "br"]} unwrapDisallowed skipHtml>{text}</ReactMarkdown>;
});

export const Reasoning: ReasoningMessagePartComponent = () => {
  const { t } = useLocale();
  const threadViewportStore = useThreadViewportStore({ optional: true });
  const part = useAuiState((s) => s.part.type === "reasoning" ? s.part : null);
  const messageRunning = useAuiState((s) => s.message.status?.type === "running");
  const running = messageRunning && part?.status.type === "running";
  const [choice, setChoice] = useState<{ running: boolean; open: boolean }>();
  // A block transition restores automatic state; no inactivity timeout guesses.
  const open = choice?.running === running ? choice.open : running;

  const getScrollViewport = useCallback(
    () => threadViewportStore?.getState().element.viewport ?? null,
    [threadViewportStore],
  );

  if (!part?.text.trim()) return null;

  return <Collapsible open={open} onOpenChange={(next) => {
    setChoice({ running, open: next });
  }} className="q-reasoning" data-slot="reasoning" data-running={running}>
    <CollapsibleTrigger className="q-reasoning-trigger group/reasoning">
      <ShimmerLabel active={running}>{t(running ? "chat.reasoningActive" : "chat.reasoning")}</ShimmerLabel>
      <CodexChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 group-data-[state=open]/reasoning:rotate-90 motion-reduce:transition-none" />
    </CollapsibleTrigger>
    <MeasuredCollapse open={open}>
      <FadeScroll
        className={`q-reasoning-content ${regionViewport}`}
        role="region"
        aria-label={t("chat.reasoning")}
        tabIndex={0}
        autoScrollToBottom={running}
        getScrollViewport={getScrollViewport}
      >
        <ReasoningText text={part.text} />
      </FadeScroll>
    </MeasuredCollapse>
  </Collapsible>;
};
