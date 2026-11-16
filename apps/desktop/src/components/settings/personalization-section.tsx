import { useEffect, useRef, useState } from "react";
import { ClaudeCodeSyncButton } from "./ClaudeCodeSyncButton";
import { useStore } from "../../store";
import { revealItemInDir } from "../../lib/desktop-bridge";
import { useLocale } from "../../localization";
import { MemoryChips, type MemoryChip } from "../assistant-ui/elements/memory-chips";
import { SectionHeader, SettingsPageHeader } from "./settings-chrome";

type PersonalizationProfile = {
  nickname: string;
  occupation: string;
  details: string;
  memoryEnabled: boolean;
};

const PERSONALIZATION_STORAGE_KEY = "qone-personalization-profile";
const DEFAULT_PERSONALIZATION_PROFILE: PersonalizationProfile = {
  nickname: "",
  occupation: "",
  details: "",
  memoryEnabled: true,
};

function loadPersonalizationProfile(): PersonalizationProfile {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PERSONALIZATION_STORAGE_KEY) ?? "null") as Partial<PersonalizationProfile> | null;
    return { ...DEFAULT_PERSONALIZATION_PROFILE, ...(saved ?? {}) };
  } catch {
    return DEFAULT_PERSONALIZATION_PROFILE;
  }
}

export function PersonalizationSection() {
  const { t } = useLocale();
  const [profile, setProfile] = useState<PersonalizationProfile>(loadPersonalizationProfile);
  const globalPrompt = useStore((state) => state.globalPrompt);
  const globalPromptPath = useStore((state) => state.globalPromptPath);
  const globalPromptLoaded = useStore((state) => state.globalPromptLoaded);
  const send = useStore((state) => state.send);
  const [globalPromptDraft, setGlobalPromptDraft] = useState(globalPrompt);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setSyncBusy = (busy: boolean) => {
    syncingRef.current = busy;
    setSyncing(busy);
    if (busy) clearTimeout(saveTimer.current);
  };

  useEffect(() => {
    if (globalPromptLoaded) setGlobalPromptDraft(globalPrompt);
  }, [globalPrompt, globalPromptLoaded]);

  useEffect(() => {
    if (!globalPromptLoaded || syncing || globalPromptDraft === globalPrompt) return;
    saveTimer.current = setTimeout(() => {
      if (!syncingRef.current) void send({ type: "global-prompt.set", requestId: crypto.randomUUID(), content: globalPromptDraft });
    }, 350);
    return () => clearTimeout(saveTimer.current);
  }, [globalPrompt, globalPromptDraft, globalPromptLoaded, send, syncing]);

  // revealItemInDir is covered by opener:default; openPath would need an extra opener:allow-open-path scope.
  const openGlobalPromptDirectory = () => {
    if (!globalPromptPath) return;
    void revealItemInDir(globalPromptPath).catch((error) => console.error("reveal Qone.md failed", error));
  };

  const updateProfile = <K extends keyof PersonalizationProfile>(key: K, value: PersonalizationProfile[K]) => {
    setProfile((current) => {
      const next = { ...current, [key]: value };
      window.localStorage.setItem(PERSONALIZATION_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };
  const chips: MemoryChip[] = (["nickname", "occupation", "details"] as const)
    .filter((key) => profile[key].trim())
    .map((key) => ({ id: key, text: `${t(`personalization.${key}`)}: ${profile[key]}`, change: "existing" }));

  return (
    <>
      <SettingsPageHeader><SectionHeader eyebrow={t("personalization.eyebrow")} title={t("personalization.title")}>{t("personalization.description")}</SectionHeader></SettingsPageHeader>
      <div className="settings-profile-form">
        <label>{t("personalization.nickname")}<input value={profile.nickname} onChange={(event) => updateProfile("nickname", event.target.value)} /></label>
        <label>{t("personalization.occupation")}<input value={profile.occupation} onChange={(event) => updateProfile("occupation", event.target.value)} /></label>
        <label>{t("personalization.details")}<textarea rows={3} value={profile.details} onChange={(event) => updateProfile("details", event.target.value)} /></label>
      </div>
      {chips.length > 0 && <MemoryChips
        chips={chips}
        label={t("personalization.savedProfile")}
        forgetLabel={(text) => t("personalization.clearProfileField", { text })}
        onForget={(id) => {
          if (id === "nickname" || id === "occupation" || id === "details") updateProfile(id, "");
        }}
        className="mb-4 max-w-none"
      />}
      <section className="settings-global-prompt-section">
        <div className="settings-global-prompt-heading flex-wrap">
          <div><h3>{t("personalization.globalPrompt")}</h3><p>{t("personalization.globalPromptDescription")}</p></div>
          <div className="settings-toolbar-actions flex-wrap"><ClaudeCodeSyncButton target="prompt" disabled={!globalPromptLoaded} onBusyChange={setSyncBusy} onSynced={() => setGlobalPromptDraft(useStore.getState().globalPrompt)} /><button type="button" className="settings-global-prompt-link" onClick={openGlobalPromptDirectory} disabled={!globalPromptPath} title={globalPromptPath}>Qone.md</button></div>
        </div>
        <textarea
          className="settings-global-prompt-input"
          rows={7}
          value={globalPromptDraft}
          disabled={!globalPromptLoaded || syncing}
          onChange={(event) => setGlobalPromptDraft(event.target.value)}
          placeholder={t("personalization.globalPromptPlaceholder")}
          aria-label={t("personalization.globalPrompt")}
        />
        <p className="settings-global-prompt-hint">{t("personalization.globalPromptHint")}</p>
      </section>
    </>
  );
}