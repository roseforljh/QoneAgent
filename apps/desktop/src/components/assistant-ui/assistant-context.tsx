import { useConversationStore } from "../../lib/conversation-context";
import { useEffect, useState, type FC } from "react";
import { ComposerContext } from "./elements/composer";
import { MemoryChips, type MemoryChip } from "./elements/memory-chips";
import { useLocale } from "../../localization";

const PROFILE_KEY = "qone-personalization-profile";
type Profile = { nickname?: string; occupation?: string; details?: string; memoryEnabled?: boolean };

function readProfile(): Profile {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(PROFILE_KEY) ?? "null");
    return value && typeof value === "object" ? value as Profile : {};
  } catch { return {}; }
}

function writeProfile(profile: Profile) {
  window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export const AssistantMemoryChips: FC<{ visible: boolean }> = ({ visible }) => {
  const { t } = useLocale();
  const [profile, setProfile] = useState(readProfile);
  if (!visible || profile.memoryEnabled === false) return null;

  const chips: MemoryChip[] = (["nickname", "occupation", "details"] as const)
    .filter((key) => typeof profile[key] === "string" && profile[key]!.trim())
    .map((key) => ({ id: key, text: `${t(`personalization.${key}`)}: ${profile[key]}`, change: "existing" }));
  if (chips.length === 0) return null;

  return <MemoryChips
    chips={chips}
    label={t("personalization.usedInReply")}
    forgetLabel={(text) => t("personalization.clearProfileField", { text })}
    onForget={(id) => {
      if (id !== "nickname" && id !== "occupation" && id !== "details") return;
      const next = { ...profile, [id]: "" };
      writeProfile(next);
      setProfile(next);
    }}
    className="mt-3 max-w-none"
  />;
};

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
