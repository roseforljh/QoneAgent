import { useEffect, useState, type FC } from "react";
import { ComposerContext } from "./elements/composer";
import { MemoryChips, type MemoryChip } from "./elements/memory-chips";
import { useStore } from "../../store";
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

export const AssistantContext: FC<{ visible: boolean }> = ({ visible }) => {
  const { t } = useLocale();
  const sessionId = useStore((state) => state.currentSessionId);
  const modelConfigs = useStore((state) => state.modelConfigs);
  const selectedModelId = useStore((state) => state.selectedModelId);
  const selectedModel = modelConfigs.find((config) => config.id === selectedModelId);
  const connected = useStore((state) => state.connected);
  const running = useStore((state) => state.running);
  const loadingSessionId = useStore((state) => state.messagesLoadingSessionId);
  const latestMessageId = useStore((state) => state.messages.at(-1)?.id);
  const compactionPhase = useStore((state) => state.compactionStatus?.phase);
  const contextUsage = useStore((state) => state.contextUsage);
  const refreshContextUsage = useStore((state) => state.refreshContextUsage);

  useEffect(() => {
    if (visible && connected && sessionId && selectedModelId && !running && compactionPhase !== "running" && loadingSessionId !== sessionId) refreshContextUsage();
  }, [visible, connected, sessionId, selectedModelId, selectedModel?.updatedAt, running, loadingSessionId, latestMessageId, compactionPhase, refreshContextUsage]);

  if (!visible) return null;
  return <ComposerContext
    usage={contextUsage && contextUsage.sessionId === sessionId && contextUsage.model === selectedModelId
      ? { used: contextUsage.tokens, total: contextUsage.contextWindow }
      : undefined}
    label={t("chat.context")}
    triggerLabel={t("chat.contextUsage")}
    note={t("chat.contextEstimate")}
    modelName={typeof selectedModel?.config.displayName === "string" ? selectedModel.config.displayName : selectedModel?.model}
  />;
};
