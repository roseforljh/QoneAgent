import { useConversationStore } from "../../lib/conversation-context";
import { useEffect, type FC } from "react";
import { ComposerContext } from "./elements/composer";
import { useLocale } from "../../localization";

export const AssistantContext: FC = () => {
  const { t } = useLocale();
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const modelConfigs = useConversationStore((state) => state.modelConfigs);
  const selectedModelId = useConversationStore((state) => state.selectedModelId);
  const selectedModel = modelConfigs.find((config) => config.id === selectedModelId);
  const connected = useConversationStore((state) => state.connected);
  const running = useConversationStore((state) => state.running);
  const loadingSessionId = useConversationStore((state) => state.messagesLoadingSessionId);
  const latestMessageId = useConversationStore((state) => state.messages.at(-1)?.id);
  const compacting = useConversationStore((state) => Boolean(state.currentSessionId && state.compactionStatuses[state.currentSessionId]));
  const contextUsage = useConversationStore((state) => state.contextUsage);
  const refreshContextUsage = useConversationStore((state) => state.refreshContextUsage);

  // Idle snapshots restore history/model changes; context.usage events update active runs.
  useEffect(() => {
    if (connected && sessionId && selectedModelId && !running && !compacting && loadingSessionId !== sessionId) refreshContextUsage();
  }, [connected, sessionId, selectedModelId, selectedModel?.updatedAt, running, loadingSessionId, latestMessageId, compacting, refreshContextUsage]);

  if (!sessionId || !selectedModelId) return null;
  return <ComposerContext
    usage={contextUsage && contextUsage.sessionId === sessionId && contextUsage.model === selectedModelId
      ? { used: contextUsage.tokens, total: contextUsage.contextWindow }
      : undefined}
    label={t("chat.context")}
    triggerLabel={t("chat.contextUsage")}
  />;
};
