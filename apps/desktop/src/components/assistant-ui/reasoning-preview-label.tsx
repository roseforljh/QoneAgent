import { memo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { OverflowFade } from "./elements/overflow-fade";
import type { ReasoningPreview } from "./reasoning-preview";

export const ReasoningPreviewLabel = memo(function ReasoningPreviewLabel({ preview, running }: {
  preview: ReasoningPreview;
  running: boolean;
}) {
  const reduceMotion = useReducedMotion();
  return <span className="q-reasoning-preview relative block min-w-0 overflow-hidden" aria-hidden="true">
    {running && !reduceMotion ? <AnimatePresence initial={false} mode="popLayout">
      <motion.span key={preview.start} className="block"
        initial={{ y: "100%", opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: "-100%", opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}>
        <OverflowFade>{preview.text}</OverflowFade>
      </motion.span>
    </AnimatePresence> : <OverflowFade>{preview.text}</OverflowFade>}
  </span>;
});
