import { memo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useAuiState, type ReasoningMessagePartComponent } from "@assistant-ui/react";
import ReactMarkdown from "react-markdown";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { CodexChevronRightIcon } from "./execution-icons";
import { MeasuredCollapse } from "./elements/measured-collapse";
import { FadeScroll, ShimmerLabel } from "./elements/surfaces";
import { OverflowFade } from "./elements/overflow-fade";
import { latestReasoningText } from "./reasoning-preview";
import { useLocale } from "../../localization";
import "./reasoning.css";

// Disclosure and fade state changes must not reparse the entire reasoning text.
const ReasoningText = memo(function ReasoningText({ text }: { text: string }) {
  return <ReactMarkdown allowedElements={["p", "br"]} unwrapDisallowed skipHtml>{text}</ReactMarkdown>;
});

export const Reasoning: ReasoningMessagePartComponent = () => {
  const { t } = useLocale();
  const reduceMotion = useReducedMotion();
  const part = useAuiState((s) => s.part.type === "reasoning" ? s.part : null);
  const messageRunning = useAuiState((s) => s.message.status?.type === "running");
  const running = messageRunning && part?.status.type === "running";
  const [open, setOpen] = useState(false);

  if (!part?.text.trim()) return null;
  const preview = latestReasoningText(part.text);

  return <Collapsible open={open} onOpenChange={setOpen} className="q-reasoning" data-slot="reasoning" data-running={running}>
    <CollapsibleTrigger title={preview} className="q-reasoning-trigger group/reasoning">
      <OverflowFade className="q-reasoning-preview">
        <ShimmerLabel active={running}>{preview}</ShimmerLabel>
      </OverflowFade>
      <CodexChevronRightIcon className="q-reasoning-chevron size-3.5 shrink-0" />
    </CollapsibleTrigger>
    <MeasuredCollapse open={open}>
      <motion.div
        initial={false}
        animate={{ y: open || reduceMotion ? 0 : -4 }}
        transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.32, 0.72, 0, 1] }}
      >
        <FadeScroll
          className="q-reasoning-content"
          role="region"
          aria-label={t("chat.reasoning")}
          tabIndex={0}
          autoScrollToBottom={running}
        >
          <ReasoningText text={part.text} />
        </FadeScroll>
      </motion.div>
    </MeasuredCollapse>
  </Collapsible>;
};
