import { useConversationStore } from "../../lib/conversation-context";
import { motion } from "motion/react";
import { useMemo } from "react";
import { useLocale } from "../../localization";
import { openRunChanges } from "../../lib/run-changes-navigation";
import { ChangeCounts } from "./elements/change-counts";
import { collectRunFileChanges } from "./run-file-changes";

/** Codex-style current-run summary shown directly above the composer. */
export function RunFileChangesSummary() {
  const { t } = useLocale();
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const activeRunId = useConversationStore((state) => state.activeRunId);
  const running = useConversationStore((state) => state.running);
  const calls = useConversationStore((state) => state.toolCalls);
  const messages = useConversationStore((state) => state.messages);
  const changes = useMemo(() => activeRunId ? collectRunFileChanges(activeRunId, calls, messages) : undefined, [activeRunId, calls, messages]);

  if (!sessionId || !running || !activeRunId || !changes?.nodes.length) return null;

  const openChanges = () => openRunChanges({ sessionId, runId: activeRunId, changes });
  const label = t("chat.filesChanged", { count: changes.nodes.length });

  return (
    <div data-slot="run-file-changes-summary" className="mx-auto mb-2 flex w-full q-thread-content min-w-0 justify-center">
      <motion.div
        layout
        initial={{ opacity: 0, y: 4, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 35 }}
        className="relative w-fit max-w-full min-w-0 overflow-hidden rounded-3xl"
      >
        <button
          type="button"
          aria-label={t("chat.viewChangedFiles")}
          title={label}
          onClick={openChanges}
          className="flex w-max max-w-full min-w-0 items-center gap-2 rounded-3xl border border-border/80 bg-secondary px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="truncate">{label}</span>
          <ChangeCounts additions={changes.totalAdditions} deletions={changes.totalDeletions} />
        </button>
      </motion.div>
    </div>
  );
}
