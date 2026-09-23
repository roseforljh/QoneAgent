import { useMemo, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
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
  const parts = useAuiState((state) => state.message.parts);
  const modelConfigs = useStore((state) => state.modelConfigs);
  const selectedModelId = useStore((state) => state.selectedModelId);
  const usage = useMemo(() => {
    const textChars = parts.reduce((total, part) => {
      if (part.type === "text") return total + part.text.length;
      if (part.type === "tool-call") return total + part.argsText.length + JSON.stringify(part.result ?? "").length;
      return total;
    }, 0);
    const selected = modelConfigs.find((config) => config.id === selectedModelId);
    const config = selected?.config ?? {};
    const metadata = config.modelMetadata;
    const maxContext = typeof config.maxContext === "number"
      ? config.maxContext
      : metadata && typeof metadata === "object" && typeof (metadata as { contextWindow?: unknown }).contextWindow === "number"
        ? (metadata as { contextWindow: number }).contextWindow
        : 128_000;
    return {
      messages: textChars / 4 / 1000,
      tools: parts.filter((part) => part.type === "tool-call").length * 0.1,
      total: maxContext / 1000,
    };
  }, [modelConfigs, parts, selectedModelId]);

  if (!visible) return null;
  return <ComposerContext
    usage={usage}
    label={t("chat.context")}
    triggerLabel={t("chat.contextUsage")}
    note={t("chat.contextEstimate")}
  />;
};
