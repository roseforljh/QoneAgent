import { localizeError } from "../../lib/error-localization";
import { subagentProfileCopy } from "../../lib/subagent-profile-copy";
import { detectImageModel, isBuiltinSubagentId, modelListUrl, modelNamesEqual, REMOVED_BUILTIN_SUBAGENT_IDS, supportsExtendedImageQuality, type ImageApiFormat, type ProviderApiType } from "@qone/protocol";
import { NumberField } from "@base-ui/react/number-field";
import { Switch } from "@base-ui/react/switch";
import { PROVIDERS_STORAGE_KEY, ACTIVE_PROVIDER_STORAGE_KEY, MODEL_CONFIG_CHANGE_EVENT, providerProfilesFromModelConfigs } from "../../lib/model-picker-data";
import { fetchProviderModelCatalog } from "../../lib/provider-model-catalog";
import { capabilities, defaultModelSettings, mergeFetchedModel, normalizeThinkingLevel, parseModelsResponse, thinkingLevelOptionsForApi, withProviderInputDefaults, withResolvedModelSettings, type Capability, type ImageGenerationSettings, type ModelSettingField, type ModelSettings, type ProviderModel, type ProviderProfile, type ThinkingLevel } from "../../lib/model-settings";
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { hasTauriBridge, requestModelMetadata } from "../../store";
import { MemoryChips, type MemoryChip } from "../assistant-ui/elements/memory-chips";
import { QoneSelect } from "../ui/Select";
import { Slider } from "../ui/Slider";
import {
  Bot,
  BrainCircuit,
  BotMessageSquare,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleUserRound,
  Command,
  CircleHelp,
  Globe2,
  LoaderCircle,
  Mail,
  MonitorCog,
  Plus,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { confirmDestructiveAction, getConfirmationRequest } from "../../lib/confirm-action";
import { saveLanguageSetting, useLocale, type LanguageSetting, type LocalizedMessage, type MessageKey } from "../../localization";
import mcpLogo from "@lobehub/icons-static-svg/icons/mcp.svg";
import cloudflareLogo from "@lobehub/icons-static-svg/icons/cloudflare-color.svg";
import notionLogo from "@lobehub/icons-static-svg/icons/notion.svg";
import githubLogo from "@lobehub/icons-static-svg/icons/github.svg";
import context7Logo from "../../assets/context7-logo.svg";
import playwrightLogo from "../../assets/playwright-logo.svg";
import outlookLogo from "../../assets/outlook-logo.svg";
import gmailLogo from "../../assets/gmail-logo.svg";
import qqmailLogo from "../../assets/qqmail-logo.svg";
import neteaseMailLogo from "../../assets/netease-mail-logo.svg";
import firecrawlLogo from "@lobehub/icons-static-svg/icons/firecrawl-color.svg";
import exaLogo from "@lobehub/icons-static-svg/icons/exa-color.svg";
import tavilyLogo from "@lobehub/icons-static-svg/icons/tavily-color.svg";
import braveLogo from "@lobehub/icons-static-svg/icons/brave-color.svg";
import perplexityLogo from "@lobehub/icons-static-svg/icons/perplexity-color.svg";
import { ModelCard } from "./ModelCard";
import { ProviderLogo } from "./ProviderLogo";
import { SkillsSection } from "./SkillsSection";
import { SubagentRuntimeSettings } from "./SubagentRuntimeSettings";
import { SubagentTemporarySettings } from "./SubagentTemporarySettings";
import { AppearanceOptions } from "./AppearanceOptions";
import { normalizeSubagentLogos, SubagentLogo } from "./subagent-logo";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import "./model-layout.css";

type SettingsSectionId = "general" | "personalization" | "configuration" | "models" | "mcp" | "skills" | "subagents" | "compaction";

type SettingsSection = {
  id: SettingsSectionId;
  labelKey: `nav.${SettingsSectionId}`;
  icon: typeof Settings2;
};

const ORDER_STORAGE_KEY = "qone-settings-section-order";
const LONG_PRESS_MS = 280;

const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "general", labelKey: "nav.general", icon: Settings2 },
  { id: "personalization", labelKey: "nav.personalization", icon: CircleUserRound },
  { id: "configuration", labelKey: "nav.configuration", icon: MonitorCog },
  { id: "models", labelKey: "nav.models", icon: Bot },
  { id: "mcp", labelKey: "nav.mcp", icon: Command },
  { id: "skills", labelKey: "nav.skills", icon: BrainCircuit },
  { id: "subagents", labelKey: "nav.subagents", icon: BotMessageSquare },
  { id: "compaction", labelKey: "nav.compaction", icon: SlidersHorizontal },
];

const DEFAULT_ORDER = SETTINGS_SECTIONS.map((section) => section.id);

function loadSectionOrder(): SettingsSectionId[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_ORDER;
    const validIds = new Set(DEFAULT_ORDER);
    const validOrder = parsed.filter(
      (id): id is SettingsSectionId => typeof id === "string" && validIds.has(id as SettingsSectionId),
    );
    return validOrder.length === DEFAULT_ORDER.length && new Set(validOrder).size === DEFAULT_ORDER.length
      ? validOrder
      : DEFAULT_ORDER;
  } catch {
    return DEFAULT_ORDER;
  }
}

function SectionHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="settings-dialog-heading">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}

const providerApiLabelKeys = {
  "openai-compatible": "provider.openaiCompatible",
  codex: "provider.codex",
  claude: "provider.claude",
  google: "provider.google",
} as const;
function loadProviderProfiles(): ProviderProfile[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PROVIDERS_STORAGE_KEY) ?? "[]") as ProviderProfile[];
    return Array.isArray(saved) ? saved.filter((item) => item && typeof item.id === "string" && typeof item.name === "string") : [];
  } catch {
    return [];
  }
}

function saveProviderProfiles(profiles: ProviderProfile[]) {
  window.localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(profiles));
  window.dispatchEvent(new Event(MODEL_CONFIG_CHANGE_EVENT));
}

function providerId(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || `provider-${Date.now()}`;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function modelsEndpoint(apiType: ProviderApiType, baseUrl: string) {
  if (!baseUrl.trim()) return "";
  try { return modelListUrl(apiType, baseUrl); } catch { return ""; }
}

async function resolveModelSettings(provider: ProviderProfile, models: ProviderModel[]): Promise<ProviderModel[]> {
  if (!models.length) return models;
  const resolved = [] as Awaited<ReturnType<typeof requestModelMetadata>>;
  const byApiType = new Map<ProviderApiType, ProviderModel[]>();
  for (const model of models) {
    const apiType = model.settings?.apiType ?? provider.apiType;
    byApiType.set(apiType, [...(byApiType.get(apiType) ?? []), model]);
  }
  for (const [apiType, apiModels] of byApiType) {
    for (let start = 0; start < apiModels.length; start += 200) {
      resolved.push(...await requestModelMetadata({ provider: provider.id, apiType, baseUrl: provider.baseUrl, models: apiModels.slice(start, start + 200).map((model) => ({ id: model.id, metadata: model.settings?.modelMetadata })) }));
    }
  }
  const byId = new Map(resolved.map((item) => [item.id, item]));
  return models.map((model) => {
    const item = byId.get(model.id);
    return item ? withResolvedModelSettings(model, item.metadata, item.sources) : model;
  });
}

type SettingsChoice = { value: string; label: string; description?: string };

function SettingsSelect({ value, options, onChange, prefix }: { value: string; options: SettingsChoice[]; onChange: (value: string) => void; prefix?: ReactNode }) {
  const { t } = useLocale();
  return <QoneSelect value={value} options={options} onChange={onChange} prefix={prefix} className="settings-select-wrap" triggerClassName="settings-value-button" menuClassName="settings-dropdown" align="end" ariaLabel={t("accessibility.option")} />;
}

function GeneralSection() {
  const { t, languageSetting } = useLocale();
  const [updateStatus, setUpdateStatus] = useState<LocalizedMessage | null>(null);
  const [checking, setChecking] = useState(false);

  const checkForUpdates = async () => {
    setChecking(true);
    setUpdateStatus({ key: "general.checking" });
    try {
      const update = await check({ timeout: 10_000 });
      if (!update) {
        setUpdateStatus({ key: "general.latest" });
        return;
      }
      setUpdateStatus({ key: "general.foundUpdate", values: { version: update.version } });
      await update.downloadAndInstall();
      setUpdateStatus({ key: "general.installed" });
    } catch (error) {
      setUpdateStatus({ key: "general.updateFailed", values: { error: localizeError(error) } });
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <SectionHeader eyebrow={t("general.eyebrow")} title={t("general.title")}>{t("general.description")}</SectionHeader>
      <div className="settings-general-options">
        <AppearanceOptions />
        <div className="settings-option-row">
          <strong>{t("general.language")}</strong>
          <SettingsSelect value={languageSetting} onChange={(value) => saveLanguageSetting(value as LanguageSetting)} options={[{ value: "auto", label: t("general.auto") }, { value: "zh-CN", label: t("general.chinese") }, { value: "en", label: "English" }]} />
        </div>
      </div>
      <div className="settings-preference-row">
        <div><strong>{t("general.updates")}</strong><span>{t("general.updateDescription")}</span></div>
        <button className="settings-secondary-action" type="button" disabled={checking} onClick={checkForUpdates}>
          {checking ? t("general.checking") : t("general.checkForUpdates")}
        </button>
      </div>
      {updateStatus && <p className="settings-inline-status" role="status">{t(updateStatus.key, updateStatus.values)}</p>}
    </>
  );
}

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

function PersonalizationSection() {
  const { t } = useLocale();
  const [profile, setProfile] = useState<PersonalizationProfile>(loadPersonalizationProfile);
  const [showMemoryInfo, setShowMemoryInfo] = useState(false);
  const globalPrompt = useStore((state) => state.globalPrompt);
  const globalPromptPath = useStore((state) => state.globalPromptPath);
  const globalPromptLoaded = useStore((state) => state.globalPromptLoaded);
  const send = useStore((state) => state.send);
  const [globalPromptDraft, setGlobalPromptDraft] = useState(globalPrompt);

  useEffect(() => {
    if (globalPromptLoaded) setGlobalPromptDraft(globalPrompt);
  }, [globalPrompt, globalPromptLoaded]);

  useEffect(() => {
    if (!globalPromptLoaded || globalPromptDraft === globalPrompt) return;
    const timer = window.setTimeout(() => {
      void send({ type: "global-prompt.set", requestId: crypto.randomUUID(), content: globalPromptDraft });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [globalPrompt, globalPromptDraft, globalPromptLoaded, send]);

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
      <SectionHeader eyebrow={t("personalization.eyebrow")} title={t("personalization.title")}>{t("personalization.description")}</SectionHeader>
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
        <div className="settings-global-prompt-heading">
          <div><h3>{t("personalization.globalPrompt")}</h3><p>{t("personalization.globalPromptDescription")}</p></div>
          <button type="button" className="settings-global-prompt-link" onClick={openGlobalPromptDirectory} disabled={!globalPromptPath} title={globalPromptPath}>Qone.md</button>
        </div>
        <textarea
          className="settings-global-prompt-input"
          rows={7}
          value={globalPromptDraft}
          disabled={!globalPromptLoaded}
          onChange={(event) => setGlobalPromptDraft(event.target.value)}
          placeholder={t("personalization.globalPromptPlaceholder")}
          aria-label={t("personalization.globalPrompt")}
        />
        <p className="settings-global-prompt-hint">{t("personalization.globalPromptHint")}</p>
      </section>
      <section className="settings-memory-section">
        <div className="settings-memory-heading"><h3>{t("personalization.memory")}</h3><CircleHelp size={18} /></div>
        <div className="settings-memory-row">
          <div><strong>{t("personalization.enableMemory")}</strong><p>{t("personalization.memoryDescription")}<button type="button" className="settings-learn-more" onClick={() => setShowMemoryInfo((current) => !current)}>{t("personalization.learnMore")}</button></p>{showMemoryInfo && <p className="settings-memory-info">{t("personalization.memoryInfo")}</p>}</div>
          <button type="button" role="switch" aria-label={t("personalization.enableMemory")} aria-checked={profile.memoryEnabled} className={cn("settings-switch", profile.memoryEnabled && "is-on")} onClick={() => updateProfile("memoryEnabled", !profile.memoryEnabled)}><span /></button>
        </div>
      </section>
    </>
  );
}

function ModelSyncDialog({ open, fetched, existing, onClose, onAdd, onRemove }: { open: boolean; fetched: ProviderModel[]; existing: ProviderModel[]; onClose: () => void; onAdd: (models: ProviderModel[]) => void; onRemove: (ids: string[]) => void }) {
  const { t } = useLocale();
  const [tab, setTab] = useState<"new" | "missing">("new");
  // New models start selected (adding is the common case); missing ones start unselected because selecting removes them.
  const [unselectedNew, setUnselectedNew] = useState<Set<string>>(new Set());
  const [selectedMissing, setSelectedMissing] = useState<Set<string>>(new Set());
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setTab("new");
    setUnselectedNew(new Set());
    setSelectedMissing(new Set());
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (getConfirmationRequest()) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); onClose(); }
      if (event.key === "Tab") {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => { window.removeEventListener("keydown", handleKey, true); previous?.focus(); };
  }, [open]);
  if (!open) return null;
  const fetchedIds = new Set(fetched.map((model) => model.id));
  const configuredCount = fetched.filter((model) => Object.values(model.settings?.metadataSources ?? {}).includes("provider")).length;
  const newModels = fetched.filter((model) => !existing.some((current) => current.id === model.id));
  const missingModels = existing.filter((model) => !fetchedIds.has(model.id));
  const listed = tab === "new" ? newModels : missingModels;
  const isSelected = (id: string) => tab === "new" ? !unselectedNew.has(id) : selectedMissing.has(id);
  const toggle = (id: string) => (tab === "new" ? setUnselectedNew : setSelectedMissing)((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectedNew = newModels.filter((model) => !unselectedNew.has(model.id));
  const selectedMissingIds = missingModels.filter((model) => selectedMissing.has(model.id)).map((model) => model.id);
  return createPortal(
    <div className="settings-sync-layer">
      <div ref={dialogRef} tabIndex={-1} className="settings-subdialog settings-sync-dialog" role="dialog" aria-modal="true" aria-label={t("provider.sync")}>
        <div className="settings-subdialog-header"><div><span>{t("provider.sync")}</span><h3>{t("provider.providerModels")}</h3></div><button type="button" className="settings-dialog-close" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div>
        <p className="settings-inline-status" role="status">{t("provider.metadataSummary", { count: configuredCount, total: fetched.length })}</p>
        <div className="settings-tabs"><button type="button" className={cn(tab === "new" && "is-active")} onClick={() => setTab("new")}>{t("provider.newModels")} <em>{newModels.length}</em></button><button type="button" className={cn(tab === "missing" && "is-active")} onClick={() => setTab("missing")}>{t("provider.missingModels")} <em>{missingModels.length}</em></button></div>
        <div className="settings-sync-list">
          {listed.map((model) => (
            <button type="button" role="checkbox" aria-checked={isSelected(model.id)} className="settings-sync-row is-selectable" key={model.id} onClick={() => toggle(model.id)}>
              <span className="settings-sync-check" aria-hidden="true">{isSelected(model.id) && <Check size={12} strokeWidth={3} />}</span>
              <span>{model.label}</span>{model.label !== model.id && <code>{model.id}</code>}
            </button>
          ))}
          {listed.length === 0 && <p className="settings-empty">{t(tab === "new" ? "provider.noNewModels" : "provider.noMissingModels")}</p>}
        </div>
        <div className="settings-subdialog-footer">
          <button type="button" className="settings-secondary-action" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="settings-primary-action" onClick={() => { onAdd(selectedNew); onRemove(selectedMissingIds); onClose(); }}><Save size={15} />{t("common.save")}</button>
        </div>
      </div>
    </div>, document.body
  );
}

function ProviderConfigDialog({ open, initial, onClose, onSaved, onDeleted }: { open: boolean; initial?: ProviderProfile; onClose: () => void; onSaved: (profile: ProviderProfile) => void; onDeleted: (profile: ProviderProfile) => void }) {
  const { t } = useLocale();
  const [name, setName] = useState(initial?.name ?? "");
  const [apiType, setApiType] = useState<ProviderApiType>(initial?.apiType ?? "openai-compatible");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [logoUrl, setLogoUrl] = useState(initial?.logoUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ProviderModel[]>(initial?.models ?? []);
  const [fetching, setFetching] = useState(false);
  const [status, setStatus] = useState<LocalizedMessage | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<ProviderModel[]>([]);
  const fetchSequence = useRef(0);
  useEffect(() => {
    fetchSequence.current++;
    if (!open) return;
    setName(initial?.name ?? ""); setApiType(initial?.apiType ?? "openai-compatible"); setBaseUrl(initial?.baseUrl ?? ""); setLogoUrl(initial?.logoUrl ?? ""); setApiKey(""); setModels(initial?.models ?? []); setStatus(null); setSyncOpen(false); setFetchedModels([]); setFetching(false);
  }, [open, initial?.id]);
  if (!open) return null;
  const preview = modelsEndpoint(apiType, baseUrl);

  const fetchModels = async () => {
    if (!preview) { setStatus({ key: "provider.fetchFirst" }); return; }
    const sequence = ++fetchSequence.current;
    setFetching(true); setStatus(null);
    try {
      let result = parseModelsResponse(await fetchProviderModelCatalog(apiType, baseUrl, initial?.id ?? providerId(name), apiKey));
      if (sequence !== fetchSequence.current) return;
      if (!result.length) { setStatus({ key: "provider.noRecognizableModels" }); return; }
      const configuredCount = result.filter((model) => Object.values(model.settings?.metadataSources ?? {}).includes("provider")).length;
      try {
        const existingById = new Map(models.map((model) => [model.id, model]));
        const modelsToResolve = result.map((model) => {
          const existing = existingById.get(model.id);
          if (!existing?.settings?.apiType) return model;
          return { ...model, settings: { ...(model.settings ?? defaultModelSettings()), apiType: existing.settings.apiType, modelMetadata: existing.settings.modelMetadata } };
        });
        result = await resolveModelSettings({ id: initial?.id ?? providerId(name), name, apiType, baseUrl, models: [], updatedAt: 0 }, modelsToResolve);
        if (sequence === fetchSequence.current) setStatus({ key: "provider.metadataSummary", values: { count: configuredCount, total: result.length } });
      } catch (error) {
        if (sequence === fetchSequence.current) setStatus(error instanceof Error && error.message === "MODEL_METADATA_UNSUPPORTED" ? { key: "model.runtimeRestartRequired" } : { key: "provider.metadataFailed", values: { error: localizeError(error) } });
      }
      if (sequence !== fetchSequence.current) return;
      const resolvedById = new Map(result.map((model) => [model.id, model]));
      setFetchedModels(result.map((model) => ({ ...model, settings: withProviderInputDefaults(model.settings ?? defaultModelSettings(apiType), apiType) })));
      setModels((current) => {
        return current.map((model) => {
          const resolved = resolvedById.get(model.id);
          if (!resolved) return model;
          const merged = mergeFetchedModel(model, resolved);
          return { ...merged, settings: withProviderInputDefaults(merged.settings!, apiType) };
        });
      });
      setSyncOpen(true);
    } catch (error) {
      if (sequence === fetchSequence.current) setStatus({ key: "provider.fetchFailed", values: { error: localizeError(error) } });
    } finally { if (sequence === fetchSequence.current) setFetching(false); }
  };

  const save = async () => {
    if (!name.trim() || !baseUrl.trim()) { setStatus({ key: "provider.requiredFields" }); return; }
    const profile: ProviderProfile = { id: initial?.id ?? providerId(name), name: name.trim(), apiType, baseUrl: normalizeBaseUrl(baseUrl), logoUrl: logoUrl.trim() || undefined, models, updatedAt: Date.now() };
    if (apiKey) {
      if (hasTauriBridge()) await invoke("secret_set", { key: `model.apiKey:${profile.id}`, value: apiKey });
      useStore.getState().send({ type: "secret.set", requestId: crypto.randomUUID(), key: `model.apiKey:${profile.id}`, value: apiKey });
    }
    onSaved(profile); onClose();
  };

  const remove = async () => {
    if (!initial) return;
    if (!await confirmDestructiveAction(t("provider.deleteConfirm", { name: initial.name }))) return;
    if (hasTauriBridge()) await invoke("secret_delete", { key: `model.apiKey:${initial.id}` }).catch(() => undefined);
    useStore.getState().send({ type: "secret.delete", requestId: crypto.randomUUID(), key: `model.apiKey:${initial.id}` });
    onDeleted(initial); onClose();
  };

  return (
    <div
      className="settings-subdialog-layer"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="settings-subdialog provider-dialog" role="dialog" aria-modal="true" aria-label={t("provider.newConfiguration")}>
        <div className="settings-subdialog-header"><div><span>{t("provider.configuration")}</span><h3>{initial ? t("provider.editConfiguration") : t("provider.newConfiguration")}</h3></div><button type="button" className="settings-dialog-close" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div>
        <div className="settings-form-grid"><label>{t("provider.name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("provider.namePlaceholder")} /></label><label>{t("provider.apiType")}<QoneSelect value={apiType} onChange={(value) => setApiType(value as ProviderApiType)} options={Object.entries(providerApiLabelKeys).map(([value, key]) => ({ value, label: t(key) }))} ariaLabel={t("provider.apiType")} /></label><label className="is-wide">{t("provider.baseUrl")}<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={t("provider.baseUrlPlaceholder")} /><small className="settings-url-preview">{t("provider.urlPreview", { url: preview || t("provider.waitingForInput") })}</small></label><label className="is-wide">{t("provider.logoUrl")}<input type="url" value={logoUrl} onChange={(event) => setLogoUrl(event.target.value)} placeholder={t("provider.logoUrlPlaceholder")} /><small className="settings-url-preview">{t("provider.logoUrlHint")}</small></label><label className="is-wide">{t("provider.apiKey")}<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t("provider.apiKeyPlaceholder")} /></label></div>
        <div className="settings-provider-actions"><button type="button" className="settings-secondary-action" disabled={fetching} onClick={fetchModels}>{fetching ? <><LoaderCircle size={15} className="settings-spin" />{t("provider.fetching")}</> : <><Globe2 size={15} />{t("provider.fetchModels")}</>}</button><span>{models.length ? t("provider.configuredModels", { count: models.length }) : t("provider.noModels")}</span></div>
        {status && <p className="settings-inline-status" role="status">{t(status.key, status.values)}</p>}
        <div className="settings-subdialog-footer">{initial && <button type="button" className="settings-danger-action" onClick={remove}><Trash2 size={15} />{t("provider.delete")}</button>}<button type="button" className="settings-secondary-action" onClick={onClose}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" onClick={save}><Save size={15} />{t("provider.saveConfiguration")}</button></div>
        <ModelSyncDialog
          open={syncOpen}
          fetched={fetchedModels}
          existing={models}
          onClose={() => setSyncOpen(false)}
          onAdd={(newModels) => setModels((current) => [...current, ...newModels.filter((model) => !current.some((existing) => existing.id === model.id))])}
          onRemove={(ids) => setModels((current) => current.filter((model) => !ids.includes(model.id)))}
        />
      </div>
    </div>
  );
}

function ConfigurationSection() {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const modelConfigs = useStore((state) => state.modelConfigs);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(loadProviderProfiles);
  const [editing, setEditing] = useState<ProviderProfile | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState(() => window.localStorage.getItem(ACTIVE_PROVIDER_STORAGE_KEY) ?? loadProviderProfiles()[0]?.id ?? "");
  useEffect(() => {
    if (profiles.length > 0 || modelConfigs.length === 0) return;
    const recovered = providerProfilesFromModelConfigs(modelConfigs);
    if (recovered.length === 0) return;
    const active = window.localStorage.getItem(ACTIVE_PROVIDER_STORAGE_KEY);
    const nextSelected = recovered.some((profile) => profile.id === active) ? active! : recovered[0].id;
    setProfiles(recovered);
    setSelectedProviderId(nextSelected);
    window.localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(recovered));
    window.localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, nextSelected);
  }, [modelConfigs, profiles.length]);
  const saveProfile = (profile: ProviderProfile) => {
    const next = [...profiles.filter((item) => item.id !== profile.id), profile];
    setProfiles(next);
    window.localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, profile.id);
    saveProviderProfiles(next);
    for (const model of profile.models) send({ type: "model.upsert", requestId: crypto.randomUUID(), config: { id: `${profile.id}/${model.id}`, provider: profile.id, model: model.id, config: { apiType: profile.apiType, baseUrl: profile.baseUrl, ...withProviderInputDefaults(model.settings ?? defaultModelSettings(profile.apiType), model.settings?.apiType ?? profile.apiType) }, enabled: true, updatedAt: Date.now() } });
  };
  const deleteProfile = (profile: ProviderProfile) => {
    const nextProfiles = profiles.filter((item) => item.id !== profile.id);
    setProfiles(nextProfiles);
    if (selectedProviderId === profile.id) {
      const nextSelected = nextProfiles[0]?.id ?? "";
      setSelectedProviderId(nextSelected);
      if (nextSelected) window.localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, nextSelected);
      else window.localStorage.removeItem(ACTIVE_PROVIDER_STORAGE_KEY);
    }
    saveProviderProfiles(nextProfiles);
    for (const model of profile.models) send({ type: "model.delete", requestId: crypto.randomUUID(), id: `${profile.id}/${model.id}` });
  };
  const selectProvider = (id: string) => {
    setSelectedProviderId(id);
    window.localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, id);
    window.dispatchEvent(new Event(MODEL_CONFIG_CHANGE_EVENT));
  };
  const openProvider = (profile: ProviderProfile) => { setEditing(profile); setDialogOpen(true); };
  return <>
    <SectionHeader eyebrow={t("nav.configuration")} title={t("nav.configuration")} />
    <div className="settings-section-toolbar"><div><strong>{t("provider.configuration")}</strong><span>{profiles.length ? t("provider.configuredProviders", { count: profiles.length }) : t("provider.noProviders")}</span></div><button type="button" className="settings-primary-action" onClick={() => { setEditing(undefined); setDialogOpen(true); }}><Plus size={15} />{t("provider.newProvider")}</button></div>
    <div className="settings-provider-grid" role="radiogroup" aria-label={t("provider.configuration")}>{profiles.map((profile) => {
      const selected = profile.id === selectedProviderId;
      return <div
        className={cn("settings-provider-card", selected && "is-selected")}
        key={profile.id}
        role="button"
        tabIndex={0}
        onClick={() => openProvider(profile)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openProvider(profile); } }}
      >
        <div className="settings-provider-edit">
          <ProviderLogo name={profile.name} baseUrl={profile.baseUrl} logoUrl={profile.logoUrl} />
          <span className="settings-provider-copy"><strong>{profile.name}</strong><small>{t(providerApiLabelKeys[profile.apiType])} · {profile.models.length} {t("provider.models")}</small></span>
        </div>
        <button type="button" className="settings-provider-select" onClick={(event) => { event.stopPropagation(); selectProvider(profile.id); }} aria-label={`${t("model.selectProvider")}: ${profile.name}`} aria-pressed={selected}>
          <span className="settings-provider-radio" aria-hidden="true" />
        </button>
      </div>;
    })}{profiles.length === 0 && <p className="settings-empty">{t("provider.noProviders")}</p>}</div>
    <ProviderConfigDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} onSaved={saveProfile} onDeleted={deleteProfile} />
  </>;
}

function ModelSourceSummary({ settings, isImageModel }: { settings: ModelSettings; isImageModel: boolean }) {
  const { t } = useLocale();
  const fields: Array<[ModelSettingField, string]> = [
    ...(!isImageModel ? [["maxOutput", t("model.maxOutput")], ["maxContext", t("model.maxContext")], ["thinking", t("model.thinking")]] as Array<[ModelSettingField, string]> : []),
    ["input", t("model.inputCapabilities")], ["output", t("model.outputCapabilities")],
  ];
  const sourceKeys = { provider: "model.source.provider", pi: "model.source.pi", "models.dev": "model.source.modelsDev", config: "model.source.manual", default: "model.source.default", unknown: "model.source.unknown" } as const;
  return <div className="settings-model-sources" aria-label={t("model.source.title")}>{fields.map(([field, label]) => {
    const source = settings.metadataOverrides?.[field] ? "config" : settings.metadataSources?.[field] ?? "unknown";
    return <span key={field}><strong>{label}</strong>{t(sourceKeys[source])}</span>;
  })}</div>;
}

function ModelEditorDialog({ open, provider, model, onClose, onSaved, onDeleted }: { open: boolean; provider: ProviderProfile; model?: ProviderModel; onClose: () => void; onSaved: (model: ProviderModel, previousId?: string) => void; onDeleted: (model: ProviderModel) => void }) {
  const { t } = useLocale();
  const [name, setName] = useState(model?.id ?? "");
  const [settings, setSettings] = useState<ModelSettings>(() => withProviderInputDefaults(model?.settings ?? defaultModelSettings(provider.apiType), model?.settings?.apiType ?? provider.apiType));
  const [fetching, setFetching] = useState(false);
  const [status, setStatus] = useState<LocalizedMessage | null>(null);
  const fetchSequence = useRef(0);
  useEffect(() => {
    fetchSequence.current++;
    if (!open) return;
    setName(model?.id ?? ""); setSettings(withProviderInputDefaults(model?.settings ?? defaultModelSettings(provider.apiType), model?.settings?.apiType ?? provider.apiType)); setStatus(null); setFetching(false);
  }, [open, model?.id]);
  if (!open) return null;
  const apiType = settings.apiType ?? provider.apiType;
  const detectedImage = detectImageModel({ model: name, provider: provider.id, apiType, imageApiFormat: settings.imageApiFormat, input: settings.input, output: settings.output, manualInput: settings.metadataOverrides?.input === true, manualOutput: settings.metadataOverrides?.output === true, metadata: settings.modelMetadata });
  const isImageModel = detectedImage.isImageModel;
  const imageApiFormat = settings.imageApiFormat ?? detectedImage.format;
  const visibleInput = isImageModel && !settings.metadataOverrides?.input && (settings.metadataSources?.input ?? "default") === "default" ? ["text", "image"] as Capability[] : settings.input;
  const visibleOutput = isImageModel && !settings.metadataOverrides?.output && (settings.metadataSources?.output ?? "default") === "default" ? ["image"] as Capability[] : settings.output;
  const thinkingOptions = thinkingLevelOptionsForApi(apiType);
  const selectedThinking = normalizeThinkingLevel(settings.thinking, apiType);
  const videoApiFormat = settings.videoGeneration?.format ?? (apiType === "google" ? "google-veo" : "");
  const videoApiOptions = [
    ...(apiType === "google" ? [{ value: "google-veo", label: t("model.videoApiGoogleNative") }] : [{ value: "", label: t("model.videoApiUnconfigured") }]),
    { value: "openai-videos", label: "Sora-compatible /videos" },
  ];
  const update = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => setSettings((current) => ({
    ...current,
    [key]: value,
    metadataOverrides: ["maxOutput", "maxContext", "thinking", "input", "output"].includes(String(key))
      ? { ...(current.metadataOverrides ?? {}), [key]: true }
      : current.metadataOverrides,
  }));
  const updateApiType = (value: ProviderApiType) => setSettings((current) => withProviderInputDefaults({
    ...current,
    apiType: value,
    thinking: normalizeThinkingLevel(current.thinking, value),
    videoGeneration: current.videoGeneration?.format === "google-veo" && value !== "google"
      ? { ...current.videoGeneration, format: undefined } : current.videoGeneration,
  }, value));
  const toggleCapability = (kind: "input" | "output", value: Capability) => {
    const selected = kind === "input" ? visibleInput : visibleOutput;
    update(kind, selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  };
  const fetchConfiguration = async () => {
    const modelId = name.trim();
    if (!modelId) { setStatus({ key: "model.fetchNameFirst" }); return; }
    const sequence = ++fetchSequence.current;
    setFetching(true); setStatus(null);
    try {
      const selectedProvider = { ...provider, apiType };
      const merchantModels = await fetchProviderModelCatalog(apiType, provider.baseUrl, provider.id).then(parseModelsResponse).catch(() => []);
      if (sequence !== fetchSequence.current) return;
      const merchant = merchantModels.find((item) => modelNamesEqual(item.id, modelId));
      let resolved: ProviderModel;
      try {
        [resolved] = await resolveModelSettings(selectedProvider, [{ id: modelId, label: modelId, settings: merchant?.settings }]);
      } catch (error) {
        if (!merchant?.settings?.modelMetadata) throw error;
        resolved = merchant;
      }
      if (sequence !== fetchSequence.current) return;
      // Judge by where each field actually came from; modelMetadata only holds the provider's raw entry, not Pi/models.dev results.
      const sources = resolved.settings?.metadataSources ?? {};
      const fetchedFields: Array<[ModelSettingField, string]> = [
        ...(!isImageModel ? [["maxOutput", t("model.maxOutput")], ["maxContext", t("model.maxContext")]] as Array<[ModelSettingField, string]> : []),
        ["input", t("model.inputCapabilities")], ["output", t("model.outputCapabilities")],
      ];
      const found = (field: ModelSettingField) => sources[field] !== undefined && sources[field] !== "default";
      if (!fetchedFields.some(([field]) => found(field))) { setStatus({ key: "model.noConfiguration" }); return; }
      setSettings((current) => withProviderInputDefaults({ ...mergeFetchedModel({ id: modelId, label: modelId, settings: current }, resolved).settings!, apiType }, apiType));
      const missing = fetchedFields.filter(([field]) => !found(field) && !settings.metadataOverrides?.[field]).map(([, label]) => label);
      setStatus(missing.length ? { key: "model.configurationPartial", values: { fields: missing.join(" / ") } } : { key: "model.configurationFetched" });
    } catch (error) { if (sequence === fetchSequence.current) setStatus(error instanceof Error && error.message === "MODEL_METADATA_UNSUPPORTED" ? { key: "model.runtimeRestartRequired" } : { key: "model.fetchConfigurationFailed", values: { error: localizeError(error) } }); }
    finally { if (sequence === fetchSequence.current) setFetching(false); }
  };
  const save = () => {
    if (!name.trim()) return;
    const imageSettings = isImageModel ? { input: visibleInput, output: visibleOutput } : {};
    onSaved({ id: name.trim(), label: name.trim(), settings: withProviderInputDefaults({ ...settings, ...imageSettings, apiType, thinking: selectedThinking }, apiType) }, model?.id);
    onClose();
  };
  const remove = async () => { if (model && await confirmDestructiveAction(t("model.deleteConfirm", { name: model.label }))) { onDeleted(model); onClose(); } };
  return (
    <div
      className="settings-subdialog-layer"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="settings-subdialog model-editor-dialog" role="dialog" aria-modal="true" aria-label={t("model.parameters")}>
        <div className="settings-subdialog-header">
          <div><span>{provider.name}</span><h3>{t("model.parameters")}</h3></div>
          <button type="button" className="settings-dialog-close" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button>
        </div>
        <div className="settings-model-fetch">
          <button type="button" className="settings-secondary-action" disabled={fetching} onClick={fetchConfiguration}>
            {fetching ? <LoaderCircle size={15} className="settings-spin" /> : <Globe2 size={15} />}
            {fetching ? t("provider.fetching") : t("model.fetchConfiguration")}
          </button>
          {status && <p className="settings-inline-status" role="status">{t(status.key, status.values)}</p>}
        </div>
        <ModelSourceSummary settings={settings} isImageModel={isImageModel} />
        <div className="settings-form-grid">
          <label className="is-wide">{t("model.name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("model.namePlaceholder")} /></label>
          <label className="is-wide">{t("model.apiType")}<QoneSelect value={apiType} onChange={(value) => updateApiType(value as ProviderApiType)} options={Object.entries(providerApiLabelKeys).map(([value, key]) => ({ value, label: t(key) }))} ariaLabel={t("model.apiType")} /></label>
          {!isImageModel && <>
            <label>{t("model.maxOutput")}<input type="number" min="1" value={settings.maxOutput} onChange={(event) => update("maxOutput", Math.max(1, Number(event.target.value) || 1))} /></label>
            <label>{t("model.maxContext")}<input type="number" min="1" value={settings.maxContext} onChange={(event) => update("maxContext", Math.max(1, Number(event.target.value) || 1))} /></label>
            <label>{t("model.thinking")}<QoneSelect value={selectedThinking} onChange={(value) => update("thinking", value as ThinkingLevel)} options={thinkingOptions.map((option) => ({ value: option.value, label: t(option.labelKey) }))} ariaLabel={t("model.thinking")} /></label>
          </>}
        </div>
        <div className="settings-capability-grid">
          <CapabilityEditor title={t("model.inputCapabilities")} values={visibleInput} onToggle={(value) => toggleCapability("input", value)} />
          <CapabilityEditor title={t("model.outputCapabilities")} values={visibleOutput} onToggle={(value) => toggleCapability("output", value)} />
        </div>
        {isImageModel && <ImageGenerationEditor format={imageApiFormat ?? "openai-image"} modelName={name} value={settings.imageGeneration} onChange={(imageGeneration) => update("imageGeneration", imageGeneration)} onFormatChange={(format) => update("imageApiFormat", format)} />}
        {!isImageModel && visibleOutput.includes("audio") && (apiType === "openai-compatible" || apiType === "google") && <div className="settings-form-grid">
          <label className="is-wide">{t("model.speechVoice")}<input value={settings.speechGeneration?.voice ?? ""} onChange={(event) => update("speechGeneration", { voice: event.target.value })} placeholder={t("model.speechVoicePlaceholder")} /></label>
        </div>}
        {!isImageModel && visibleOutput.includes("video") && <div className="settings-form-grid">
          <label className="is-wide">{t("model.videoApiFormat")}<QoneSelect value={videoApiFormat} onChange={(value) => update("videoGeneration", { ...settings.videoGeneration, format: value === "openai-videos" || value === "google-veo" ? value : undefined })} options={videoApiOptions} ariaLabel={t("model.videoApiFormat")} /></label>
          {videoApiFormat && <label className="is-wide">{t("model.videoApiBaseUrl")}<input value={settings.videoGeneration?.baseUrl ?? ""} onChange={(event) => update("videoGeneration", { ...settings.videoGeneration, baseUrl: event.target.value })} placeholder={t(videoApiFormat === "google-veo" ? "model.videoApiBaseUrlPlaceholderGoogle" : "model.videoApiBaseUrlPlaceholder")} /></label>}
        </div>}
        <div className="settings-subdialog-footer">
          {model && <button type="button" className="settings-danger-action" onClick={remove}><Trash2 size={15} />{t("model.delete")}</button>}
          <button type="button" className="settings-secondary-action" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="settings-primary-action" onClick={save}><Save size={15} />{t("model.saveParameters")}</button>
        </div>
      </div>
    </div>
  );
}

function ImageGenerationEditor({ format, modelName, value, onChange, onFormatChange }: { format: ImageApiFormat; modelName: string; value?: ImageGenerationSettings; onChange: (value: ImageGenerationSettings) => void; onFormatChange: (value: ImageApiFormat) => void }) {
  const { t } = useLocale();
  const current = value ?? {};
  const commonSizes = ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160"];
  const customSize = !commonSizes.includes(current.size ?? "auto");
  const qualityOptions = supportsExtendedImageQuality(modelName)
    ? ["auto", "low", "medium", "high", "xhigh", "max"]
    : ["auto", "low", "medium", "high"];
  const set = <K extends keyof ImageGenerationSettings>(key: K, next: ImageGenerationSettings[K]) => onChange({ ...current, [key]: next });
  const select = (label: string, selected: string, options: readonly string[], change: (next: string) => void) =>
    <QoneSelect value={selected} onChange={change} options={options.map((item) => ({ value: item, label: item }))} ariaLabel={label} />;
  const count = (max?: number) => <label><span>{t("model.imageCount")}</span><QoneSelect value={typeof current.n === "number" ? "manual" : "auto"} onChange={(next) => set("n", next === "auto" ? "auto" : 1)} options={[{ value: "auto", label: "auto" }, { value: "manual", label: t("model.imageManualCount") }]} ariaLabel={t("model.imageCount")} />{typeof current.n === "number" ? <input type="number" min="1" {...(max ? { max } : {})} value={current.n} onChange={(event) => set("n", Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(1, Number(event.target.value) || 1)))} aria-label={t("model.imageManualCount")} /> : <small className="settings-image-field-hint">{t("model.imageAutoCountHint")}</small>}</label>;
  return <div className="settings-form-grid is-wide" aria-label={t("model.imageParameters")}>
    <label className="is-wide"><span>{t("model.imageApiFormat")}</span><QoneSelect value={format} onChange={(next) => onFormatChange(next as ImageApiFormat)} options={[{ value: "openai-image", label: "OpenAI Image" }, { value: "gemini-image", label: "Gemini Image" }, { value: "qwen-image", label: "Qwen Image" }, { value: "seedream-image", label: "Seedream Image" }]} ariaLabel={t("model.imageApiFormat")} /></label>
    {format === "openai-image" && <>
      <label><span>{t("model.imageSize")}</span><QoneSelect value={customSize ? "custom" : current.size ?? "auto"} onChange={(next) => set("size", next === "custom" ? "" : next)} options={[...commonSizes.map((item) => ({ value: item, label: item })), { value: "custom", label: t("model.imageCustomSize") }]} ariaLabel={t("model.imageSize")} />{customSize && <input value={current.size ?? ""} onChange={(event) => set("size", event.target.value)} placeholder="WIDTHxHEIGHT" aria-label={t("model.imageCustomSize")} />}</label>
      <label><span>{t("model.imageQuality")}</span>{select(t("model.imageQuality"), current.quality ?? "auto", qualityOptions, (next) => set("quality", next as ImageGenerationSettings["quality"]))}</label>
      <label><span>{t("model.imageBackground")}</span>{select(t("model.imageBackground"), current.background ?? "auto", ["auto", "opaque", "transparent"], (next) => set("background", next as ImageGenerationSettings["background"]))}</label>
      <label><span>{t("model.imageOutputFormat")}</span>{select(t("model.imageOutputFormat"), current.outputFormat ?? "png", ["png", "jpeg", "webp"], (next) => set("outputFormat", next as ImageGenerationSettings["outputFormat"]))}{(current.outputFormat ?? "png") === "png" && <small className="settings-image-field-hint">{t("model.imageCompressionFormatHint")}</small>}</label>
      {(current.outputFormat === "jpeg" || current.outputFormat === "webp") && <label><span>{t("model.imageCompression")}</span><input type="number" min="0" max="100" value={current.outputCompression ?? ""} onChange={(event) => set("outputCompression", event.target.value === "" ? undefined : Math.min(100, Math.max(0, Number(event.target.value))))} /></label>}
      {count(10)}
    </>}
    {format === "gemini-image" && <>
      <label><span>{t("model.imageAspectRatio")}</span>{select(t("model.imageAspectRatio"), current.aspectRatio ?? "auto", ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"], (next) => set("aspectRatio", next))}</label>
      <label><span>{t("model.imageSize")}</span>{select(t("model.imageSize"), current.imageSize ?? "auto", ["auto", "1K", "2K", "4K"], (next) => set("imageSize", next))}</label>
    </>}
    {format === "qwen-image" && <>
      <label><span>{t("model.imageSize")}</span><input value={current.size ?? "auto"} onChange={(event) => set("size", event.target.value)} placeholder="1328*1328" /></label>
      <label><span>{t("model.imageNegativePrompt")}</span><input value={current.negativePrompt ?? ""} onChange={(event) => set("negativePrompt", event.target.value)} /></label>
      <label><span>{t("model.imageSeed")}</span><input type="number" value={current.seed ?? ""} onChange={(event) => set("seed", event.target.value === "" ? undefined : Number(event.target.value))} /></label>
      <label><span>{t("model.imageTransport")}</span><QoneSelect value={current.transport ?? "openai-compatible"} onChange={(next) => set("transport", next as ImageGenerationSettings["transport"])} options={[{ value: "openai-compatible", label: "OpenAI compatible" }, { value: "dashscope", label: "DashScope" }]} ariaLabel={t("model.imageTransport")} /></label>
      <label><span>{t("model.imagePromptExtend")}</span>{select(t("model.imagePromptExtend"), String(current.promptExtend ?? true), ["true", "false"], (next) => set("promptExtend", next === "true"))}</label>
      <label><span>{t("model.imagePromptExtendMode")}</span>{select(t("model.imagePromptExtendMode"), current.promptExtendMode ?? "direct", ["direct", "agent"], (next) => set("promptExtendMode", next as ImageGenerationSettings["promptExtendMode"]))}</label>
      <label><span>{t("model.imageThinking")}</span>{select(t("model.imageThinking"), String(current.enableThinking ?? true), ["true", "false"], (next) => set("enableThinking", next === "true"))}</label>
      <label><span>{t("model.imageWatermark")}</span>{select(t("model.imageWatermark"), String(current.watermark ?? false), ["false", "true"], (next) => set("watermark", next === "true"))}</label>
      {count(6)}
      <label><span>{t("model.imageAsync")}</span>{select(t("model.imageAsync"), String(current.async ?? false), ["false", "true"], (next) => set("async", next === "true"))}</label>
    </>}
    {format === "seedream-image" && <>
      <label><span>{t("model.imageSize")}</span><input value={current.size ?? "auto"} onChange={(event) => set("size", event.target.value)} placeholder="2K" /></label>
      <label><span>{t("model.imageResponseFormat")}</span><QoneSelect value={current.responseFormat ?? "url"} onChange={(next) => set("responseFormat", next as ImageGenerationSettings["responseFormat"])} options={[{ value: "url", label: "URL" }, { value: "b64_json", label: "Base64" }]} ariaLabel={t("model.imageResponseFormat")} /></label>
      <label><span>{t("model.imageSequential")}</span>{select(t("model.imageSequential"), current.sequentialImageGeneration ?? "disabled", ["disabled", "auto"], (next) => set("sequentialImageGeneration", next as ImageGenerationSettings["sequentialImageGeneration"]))}</label>
      <label><span>{t("model.imageWatermark")}</span>{select(t("model.imageWatermark"), String(current.watermark ?? false), ["false", "true"], (next) => set("watermark", next === "true"))}</label>
      {count()}
    </>}
  </div>;
}

function CapabilityEditor({ title, values, onToggle }: { title: string; values: Capability[]; onToggle: (value: Capability) => void }) {
  const { t } = useLocale();
  return <div className="settings-capability-group"><strong>{title}</strong><div>{capabilities.map((capability) => {
    const selected = values.includes(capability);
    return <button type="button" key={capability} className={cn("settings-capability-chip", selected && "is-selected")} onClick={() => onToggle(capability)} aria-pressed={selected}>
      <span className="settings-capability-check" aria-hidden="true"><Check size={13} /></span>
      {t(`capability.${capability}`)}
    </button>;
  })}</div></div>;
}

function ModelsSection() {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const modelConfigs = useStore((state) => state.modelConfigs);
  const selectedModelId = useStore((state) => state.selectedModelId);
  const setSelectedModel = useStore((state) => state.setSelectedModel);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(loadProviderProfiles);
  const [selectedProviderId, setSelectedProviderId] = useState(() => window.localStorage.getItem(ACTIVE_PROVIDER_STORAGE_KEY) ?? "");
  const [editing, setEditing] = useState<ProviderModel | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  useEffect(() => { void send({ type: "model.list", requestId: crypto.randomUUID() }); }, [send]);
  useEffect(() => {
    if (profiles.length > 0 || modelConfigs.length === 0) return;
    const recovered = providerProfilesFromModelConfigs(modelConfigs);
    if (recovered.length === 0) return;
    const active = window.localStorage.getItem(ACTIVE_PROVIDER_STORAGE_KEY);
    const nextSelected = recovered.some((profile) => profile.id === active) ? active! : recovered[0].id;
    setProfiles(recovered);
    setSelectedProviderId(nextSelected);
    window.localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(recovered));
    window.localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, nextSelected);
  }, [modelConfigs, profiles.length]);
  const provider = profiles.find((item) => item.id === selectedProviderId) ?? profiles[0];
  const models = provider?.models ?? modelConfigs.filter((config) => config.provider === provider?.id).map((config) => ({ id: config.model, label: config.model, settings: config.config as unknown as ModelSettings }));
  const saveModel = async (model: ProviderModel, previousId?: string) => {
    if (!provider) return;
    const nextProfiles = profiles.map((item) => item.id === provider.id ? { ...item, models: [...item.models.filter((current) => current.id !== model.id), model], updatedAt: Date.now() } : item);
    setProfiles(nextProfiles); saveProviderProfiles(nextProfiles);
    if (previousId && previousId !== model.id && await confirmDestructiveAction(t("model.renameCleanupConfirm", { name: previousId }))) send({ type: "model.delete", requestId: crypto.randomUUID(), id: `${provider.id}/${previousId}` });
    send({ type: "model.upsert", requestId: crypto.randomUUID(), config: { id: `${provider.id}/${model.id}`, provider: provider.id, model: model.id, config: { apiType: provider.apiType, baseUrl: provider.baseUrl, ...model.settings }, enabled: true, updatedAt: Date.now() } });
  };
  const deleteModel = (model: ProviderModel) => {
    const nextProfiles = profiles.map((item) => item.id === provider?.id ? { ...item, models: item.models.filter((current) => current.id !== model.id), updatedAt: Date.now() } : item);
    setProfiles(nextProfiles); saveProviderProfiles(nextProfiles);
    send({ type: "model.delete", requestId: crypto.randomUUID(), id: `${provider?.id}/${model.id}` });
  };
  const selectProvider = (id: string) => { setSelectedProviderId(id); window.localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, id); window.dispatchEvent(new Event(MODEL_CONFIG_CHANGE_EVENT)); };
  return <>
    <SectionHeader eyebrow="Models" title={t("model.title")} />
    <div className="settings-model-toolbar"><label>{t("model.currentProvider")}<QoneSelect value={provider?.id ?? ""} onChange={selectProvider} placeholder={t("model.selectProvider")} options={profiles.map((item) => ({ value: item.id, label: item.name }))} ariaLabel={t("model.currentProvider")} /></label><button type="button" className="settings-secondary-action" disabled={!provider} onClick={() => { setEditing(undefined); setEditorOpen(true); }}><Plus size={15} />{t("model.manualAdd")}</button></div>
    {provider ? <><div className="settings-section-toolbar settings-model-summary"><div><strong>{provider.name}</strong><span>{t(providerApiLabelKeys[provider.apiType])} · {models.length} {t("provider.models")}</span></div></div><div className="settings-model-grid" role="group" aria-label={`${provider.name} ${t("model.title")}`}>
      {models.map((model) => {
        const modelConfigId = `${provider.id}/${model.id}`;
        const selected = selectedModelId === modelConfigId;
        return <ModelCard
          key={model.id}
          id={modelConfigId}
          label={model.label}
          description={t(providerApiLabelKeys[model.settings?.apiType ?? provider.apiType])}
          selected={selected}
          onEdit={() => { setEditing(model); setEditorOpen(true); }}
          onSelect={() => setSelectedModel(modelConfigId)}
        />;
      })}
      {models.length === 0 && <p className="settings-empty">{t("model.noModels")}</p>}
    </div></> : <p className="settings-empty">{t("model.addProviderFirst")}</p>}
    {provider && <ModelEditorDialog open={editorOpen} provider={provider} model={editing} onClose={() => setEditorOpen(false)} onSaved={saveModel} onDeleted={deleteModel} />}
  </>;
}

type SubagentProfile = import("@qone/protocol").SubagentProfileInfo;
const SUBAGENTS_STORAGE_KEY = "qone-subagents";

function dedupeSubagents(profiles: SubagentProfile[]): SubagentProfile[] {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    if (!profile || typeof profile.id !== "string" || REMOVED_BUILTIN_SUBAGENT_IDS.includes(profile.id) || seen.has(profile.id)) return false;
    seen.add(profile.id);
    return true;
  });
}

function loadSubagents(): SubagentProfile[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SUBAGENTS_STORAGE_KEY) ?? "[]") as SubagentProfile[];
    if (!Array.isArray(saved)) return [];
    return normalizeSubagentLogos(dedupeSubagents(saved));
  } catch {
    return [];
  }
}

function SubagentEditorDialog({ open, initial, modelOptions, onClose, onSaved }: { open: boolean; initial?: SubagentProfile; modelOptions: { id: string; label: string }[]; onClose: () => void; onSaved: (profile: SubagentProfile) => void }) {
  const { t, locale } = useLocale();
  const copy = initial ? subagentProfileCopy(initial, locale) : undefined;
  const [name, setName] = useState(copy?.name ?? "");
  const [instructions, setInstructions] = useState(copy?.instructions ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? modelOptions[0]?.id ?? "");
  const [tools, setTools] = useState(initial?.tools?.join(", ") ?? "");
  const [permissionMode, setPermissionMode] = useState<SubagentProfile["permissionMode"]>(initial?.permissionMode ?? "ask");
  useEffect(() => {
    if (!open) return;
    setName(copy?.name ?? ""); setInstructions(copy?.instructions ?? ""); setModelId(initial?.modelId ?? modelOptions[0]?.id ?? ""); setTools(initial?.tools?.join(", ") ?? ""); setPermissionMode(initial?.permissionMode ?? "ask");
  }, [open, initial?.id, modelOptions[0]?.id]);
  const save = () => {
    if (!name.trim() || !instructions.trim() || (!modelId && !isBuiltinSubagentId(initial?.id ?? ""))) return;
    onSaved({ id: initial?.id ?? `subagent-${Date.now()}`, name: name.trim(), instructions: instructions.trim(), nameKey: name.trim() === copy?.name ? initial?.nameKey : undefined, instructionsKey: instructions.trim() === copy?.instructions ? initial?.instructionsKey : undefined, modelId, logo: initial?.logo, tools: tools.split(",").map((item) => item.trim()).filter(Boolean), permissionMode, enabled: initial?.enabled ?? true, updatedAt: Date.now() });
    onClose();
  };
  if (!open) return null;
  return <div className="settings-subdialog-layer"><div className="settings-subdialog model-editor-dialog" role="dialog" aria-modal="true" aria-label={t("subagent.create")}><div className="settings-subdialog-header"><div><span>{t("nav.subagents")}</span><h3>{initial ? t("subagent.edit") : t("subagent.create")}</h3></div><button type="button" className="settings-dialog-close" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div><div className="settings-form-grid"><label className="is-wide">{t("subagent.name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("subagent.namePlaceholder")} /></label><label className="is-wide">{t("subagent.driverModel")}<QoneSelect value={modelId} onChange={setModelId} placeholder={t("subagent.selectModel")} options={modelOptions.map((model) => ({ value: model.id, label: model.label }))} ariaLabel={t("subagent.driverModel")} /></label><label>{t("subagent.permissionMode")}<QoneSelect value={permissionMode ?? "ask"} onChange={(value) => setPermissionMode(value as SubagentProfile["permissionMode"])} options={[{ value: "ask", label: t("composer.permissionAsk") }, { value: "auto", label: t("composer.permissionAuto") }, { value: "full", label: t("composer.permissionFull") }]} ariaLabel={t("subagent.permissionMode")} /></label><label className="is-wide">{t("subagent.toolAllowList")}<input value={tools} onChange={(event) => setTools(event.target.value)} placeholder={t("subagent.toolAllowListPlaceholder")} /><small>{t("subagent.toolAllowListDescription")}</small></label><label className="is-wide">{t("subagent.systemPrompt")}<textarea className="settings-subagent-prompt" rows={7} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={t("subagent.promptPlaceholder")} /></label></div><div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" onClick={onClose}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={!name.trim() || !instructions.trim() || (!modelId && !isBuiltinSubagentId(initial?.id ?? ""))} onClick={save}><Save size={15} />{t("subagent.save")}</button></div></div></div>;
}

function CompactionSection() {
  const { t } = useLocale();
  const enabled = useStore((state) => state.autoCompactionEnabled);
  const threshold = useStore((state) => state.compactionThreshold);
  const [draftThreshold, setDraftThreshold] = useState<number | null>(threshold);
  const setCompactionSettings = useStore((state) => state.setCompactionSettings);
  const update = (next: Partial<{ autoCompactionEnabled: boolean; compactionThreshold: number }>) => {
    setCompactionSettings({ autoCompactionEnabled: next.autoCompactionEnabled ?? enabled, compactionThreshold: next.compactionThreshold ?? threshold });
  };
  useEffect(() => setDraftThreshold(threshold), [threshold]);
  const commitThreshold = (value: number | null) => {
    const next = value === null || !Number.isFinite(value) ? threshold : Math.min(95, Math.max(50, Math.round(value)));
    setDraftThreshold(next);
    if (next !== threshold) update({ compactionThreshold: next });
  };

  return (
    <>
      <SectionHeader eyebrow={t("compaction.eyebrow")} title={t("compaction.title")} />
      <section className="settings-compaction-section">
        <div className="settings-compaction-row">
          <div>
            <strong>{t("compaction.autoTitle")}</strong>
            <p>{t("compaction.autoDescription")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={t("compaction.autoTitle")}
            aria-checked={enabled}
            className={cn("settings-switch", enabled && "is-on")}
            onClick={() => {
              setDraftThreshold(threshold);
              update({ autoCompactionEnabled: !enabled });
            }}
          ><span /></button>
        </div>
        <div className={cn("settings-compaction-threshold", !enabled && "is-disabled")}>
          <div className="settings-compaction-threshold-heading">
            <strong>{t("compaction.thresholdTitle")}</strong>
            <NumberField.Root
              className="settings-compaction-value"
              value={draftThreshold}
              min={50}
              max={95}
              step={1}
              allowOutOfRange
              disabled={!enabled}
              onValueChange={(value) => {
                setDraftThreshold(value);
                if (value !== null && Number.isInteger(value) && value >= 50 && value <= 95) {
                  update({ compactionThreshold: value });
                }
              }}
              onValueCommitted={commitThreshold}
            >
              <NumberField.Input className="settings-compaction-input" aria-label={t("compaction.thresholdTitle")} inputMode="numeric" />
              <span aria-hidden="true">%</span>
            </NumberField.Root>
          </div>
          <Slider
            value={threshold}
            min={50}
            max={95}
            ariaLabel={t("compaction.thresholdTitle")}
            disabled={!enabled}
            onValueChange={(value) => update({ compactionThreshold: value })}
          />
          <p>{t("compaction.thresholdDescription")}</p>
        </div>
      </section>
    </>
  );
}

function SubagentsSection() {
  const { t, locale } = useLocale();
  const modelConfigs = useStore((state) => state.modelConfigs);
  const runtimeSubagentConfig = useStore((state) => state.subagentConfig);
  const send = useStore((state) => state.send);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(loadProviderProfiles);
  const [agents, setAgents] = useState<SubagentProfile[]>(loadSubagents);
  const [runtime, setRuntime] = useState(runtimeSubagentConfig.runtime);
  const [editing, setEditing] = useState<SubagentProfile | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [view, setView] = useState<"overview" | "runtime" | "temporary">("overview");
  const modelOptions = Array.from(new Map([
    ...modelConfigs.map((model) => [`${model.provider}/${model.model}`, { id: model.id, label: `${model.provider} / ${model.model}` }] as const),
    ...profiles.flatMap((provider) => provider.models.map((model) => [`${provider.id}/${model.id}`, { id: `${provider.id}/${model.id}`, label: `${provider.name} / ${model.label}` }] as const)),
  ]).values());
  useEffect(() => {
    if (runtimeSubagentConfig.updatedAt <= 0) return;
    const normalized = normalizeSubagentLogos(dedupeSubagents(runtimeSubagentConfig.profiles));
    setAgents(normalized);
    setRuntime(runtimeSubagentConfig.runtime);
    window.localStorage.setItem(SUBAGENTS_STORAGE_KEY, JSON.stringify(normalized));
  }, [runtimeSubagentConfig.updatedAt]);
  const saveAgents = (next: SubagentProfile[]) => {
    const normalized = normalizeSubagentLogos(dedupeSubagents(next));
    const config = { profiles: normalized, routing: runtimeSubagentConfig.routing, runtime, updatedAt: Date.now() };
    setAgents(normalized);
    window.localStorage.setItem(SUBAGENTS_STORAGE_KEY, JSON.stringify(normalized));
    void send({ type: "subagent.sync", requestId: crypto.randomUUID(), config });
  };
  const saveAgent = (agent: SubagentProfile) => saveAgents(
    agents.some((item) => item.id === agent.id)
      ? agents.map((item) => item.id === agent.id ? agent : item)
      : [...agents, agent],
  );
  const saveRuntime = (next: typeof runtime) => {
    setRuntime(next);
    const config = { profiles: dedupeSubagents(agents), routing: runtimeSubagentConfig.routing, runtime: next, updatedAt: Date.now() };
    void send({ type: "subagent.sync", requestId: crypto.randomUUID(), config });
  };
  const deleteAgent = async (agent: SubagentProfile) => { if (await confirmDestructiveAction(t("subagent.deleteConfirm", { name: subagentProfileCopy(agent, locale).name }))) saveAgents(agents.filter((item) => item.id !== agent.id)); };
  const temporaryModelLabel = runtime.temporaryModelId
    ? modelOptions.find((model) => model.id === runtime.temporaryModelId)?.label ?? runtime.temporaryModelId
    : t("subagent.followMainModel");
  if (view === "temporary") return <>
    <button type="button" className="settings-subagent-back" onClick={() => setView("overview")}>
      <ArrowLeft size={14} aria-hidden="true" />
      {t("subagent.temporaryBack")}
    </button>
    <SectionHeader eyebrow={t("subagent.eyebrow")} title={t("subagent.temporaryTitle")}>
      {t("subagent.temporaryDescription")}
    </SectionHeader>
    <SubagentTemporarySettings value={runtime.temporaryModelId} modelOptions={modelOptions} onChange={(temporaryModelId) => saveRuntime({ ...runtime, temporaryModelId })} />
  </>;
  if (view === "runtime") return <>
    <button type="button" className="settings-subagent-back" onClick={() => setView("overview")}>
      <ArrowLeft size={14} aria-hidden="true" />
      {t("subagent.runtimeBack")}
    </button>
    <SectionHeader eyebrow={t("subagent.eyebrow")} title={t("subagent.runtimeTitle")}>
      {t("subagent.runtimeDescription")}
    </SectionHeader>
    <SubagentRuntimeSettings value={runtime} onChange={saveRuntime} />
  </>;
  return <>
    <SectionHeader eyebrow={t("subagent.eyebrow")} title={t("subagent.title")} />
    <div className="settings-section-toolbar"><div><strong>{t("subagent.mine")}</strong><span>{t("subagent.count", { count: agents.length })}</span></div><button type="button" className="settings-primary-action" onClick={() => { setEditing(undefined); setDialogOpen(true); }}><Plus size={15} />{t("subagent.new")}</button></div>
    <div className="settings-subagent-list">{agents.map((agent) => { const builtin = isBuiltinSubagentId(agent.id); const display = subagentProfileCopy(agent, locale); const openEditor = () => { setEditing(agent); setDialogOpen(true); }; return <div className={cn("settings-subagent-card", "is-actionable", !agent.enabled && "is-disabled")} key={agent.id} role="button" tabIndex={0} aria-label={`${display.name} · ${t("common.edit")}`} onClick={openEditor} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openEditor(); } }}><div className="settings-subagent-card-main"><SubagentLogo logo={agent.logo} name={display.name} size={36} /><div><strong>{display.name}</strong><small>{modelOptions.find((model) => model.id === agent.modelId)?.label ?? (agent.modelId ? agent.modelId : t("subagent.followMainModel"))} · {builtin ? t("subagent.builtIn") : agent.enabled ? t("subagent.enabled") : t("subagent.disabled")}</small></div></div><div className="settings-subagent-actions"><Switch.Root checked={agent.enabled} aria-label={t(agent.enabled ? "subagent.disable" : "subagent.enable")} className={cn("settings-switch", agent.enabled && "is-on")} onClick={(event) => event.stopPropagation()} onCheckedChange={(checked) => { saveAgents(agents.map((item) => item.id === agent.id ? { ...item, enabled: checked, updatedAt: Date.now() } : item)); }}><Switch.Thumb /></Switch.Root>{!builtin && <button type="button" aria-label={t("subagent.delete", { name: agent.name })} onClick={(event) => { event.stopPropagation(); void deleteAgent(agent); }}><Trash2 size={14} /></button>}</div></div>; })}{agents.length === 0 && <div className="settings-empty-card"><BotMessageSquare size={22} /><p>{t("subagent.noAgents")}</p></div>}</div>
    <button type="button" className="settings-subagent-settings-card" onClick={() => setView("temporary")}>
      <span className="settings-subagent-settings-icon"><BotMessageSquare size={17} aria-hidden="true" /></span>
      <span className="settings-subagent-settings-copy"><strong>{t("subagent.temporaryTitle")}</strong><small>{temporaryModelLabel}</small></span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
    <button type="button" className="settings-subagent-settings-card" onClick={() => setView("runtime")}>
      <span className="settings-subagent-settings-icon"><SlidersHorizontal size={17} aria-hidden="true" /></span>
      <span className="settings-subagent-settings-copy"><strong>{t("subagent.runtimeTitle")}</strong><small>{t("subagent.runtimeDescription")}</small></span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
    <SubagentEditorDialog open={dialogOpen} initial={editing} modelOptions={modelOptions} onClose={() => setDialogOpen(false)} onSaved={saveAgent} />
  </>;
}

// 官方 MCP 预设：stdio 走 npx、远程走 Streamable HTTP，点开关即启用（关闭 = mcp.delete 移除）。
// 带 tokenEnv/env 的项需要对应环境变量存在才能连上，描述里已注明。
const MCP_PRESETS: { id: string; name: string; descKey: MessageKey; logo: string; mono?: boolean; lightBadge?: boolean; config: { command?: string; args?: string[]; url?: string; tokenEnv?: string; env?: Record<string, string>; authMode?: "oauth" } }[] = [
  { id: "mcp-playwright", name: "Playwright", descKey: "mcp.presetPlaywright", logo: playwrightLogo, lightBadge: true, config: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } },
  { id: "mcp-context7", name: "Context7", descKey: "mcp.presetContext7", logo: context7Logo, lightBadge: true, config: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } },
  { id: "mcp-cloudflare-docs", name: "Cloudflare", descKey: "mcp.presetCloudflare", logo: cloudflareLogo, config: { url: "https://mcp.cloudflare.com/mcp", authMode: "oauth" } },
  { id: "mcp-notion", name: "Notion", descKey: "mcp.presetNotion", logo: notionLogo, mono: true, lightBadge: true, config: { url: "https://mcp.notion.com/mcp", authMode: "oauth" } },
  { id: "mcp-github", name: "GitHub", descKey: "mcp.presetGitHub", logo: githubLogo, mono: true, lightBadge: true, config: { url: "https://api.githubcopilot.com/mcp/" } },
];

const configuredGithubClientId = import.meta.env.VITE_GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";

// 邮箱预设：收发件必须填凭证，开关点开的是预填好 IMAP/SMTP 的添加对话框，而不是直接连。
const EMAIL_PRESETS: { id: string; name: string; nameKey?: MessageKey; descKey: MessageKey; logo?: string; mono?: boolean; badgeStyle?: CSSProperties; lucide?: typeof Mail; prefill: { command: string; args: string; env: string } }[] = [
  { id: "mcp-outlook-mail", name: "Outlook Mail", nameKey: "mcp.outlookName", descKey: "mcp.presetOutlook", logo: outlookLogo, prefill: { command: "npx", args: "-y mcp-email-server", env: "EMAIL_ADDRESS=\nEMAIL_PASSWORD=\nIMAP_HOST=outlook.office365.com\nIMAP_PORT=993\nSMTP_HOST=smtp.office365.com\nSMTP_PORT=587" } },
  { id: "mcp-gmail", name: "Gmail", descKey: "mcp.presetGmail", logo: gmailLogo, prefill: { command: "npx", args: "-y mcp-email-server", env: "EMAIL_ADDRESS=\nEMAIL_PASSWORD=\nIMAP_HOST=imap.gmail.com\nIMAP_PORT=993\nSMTP_HOST=smtp.gmail.com\nSMTP_PORT=465" } },
  { id: "mcp-qqmail", name: "QQ Mail", nameKey: "mcp.qqName", descKey: "mcp.presetQqMail", logo: qqmailLogo, prefill: { command: "npx", args: "-y mcp-email-server", env: "EMAIL_ADDRESS=\nEMAIL_PASSWORD=\nIMAP_HOST=imap.qq.com\nIMAP_PORT=993\nSMTP_HOST=smtp.qq.com\nSMTP_PORT=465" } },
  { id: "mcp-netease-mail", name: "NetEase Mail", nameKey: "mcp.neteaseName", descKey: "mcp.presetNetEase", logo: neteaseMailLogo, mono: true, badgeStyle: { background: "#d43c33", color: "#fff" }, prefill: { command: "npx", args: "-y mcp-email-server", env: "EMAIL_ADDRESS=\nEMAIL_PASSWORD=\nIMAP_HOST=imap.163.com\nIMAP_PORT=993\nSMTP_HOST=smtp.163.com\nSMTP_PORT=465" } },
  { id: "mcp-custom-mail", name: "Custom Mail", nameKey: "mcp.customMailName", descKey: "mcp.presetCustomMail", lucide: Mail, prefill: { command: "npx", args: "-y mcp-email-server", env: "EMAIL_ADDRESS=\nEMAIL_PASSWORD=\nIMAP_HOST=\nIMAP_PORT=993\nSMTP_HOST=\nSMTP_PORT=465" } },
];

// 填 key 即用的网络服务预设：Key 存在系统凭据中，MCP 配置只保存凭据引用。
const KEY_PRESETS: { id: string; name: string; nameKey?: MessageKey; descKey: MessageKey; logo?: string; mono?: boolean; badgeStyle?: CSSProperties; lucide?: typeof Mail; prefill: { command: string; args: string; env: string } }[] = [
  { id: "mcp-firecrawl", name: "Firecrawl", descKey: "mcp.presetFirecrawl", logo: firecrawlLogo, prefill: { command: "npx", args: "-y firecrawl-mcp", env: "FIRECRAWL_API_KEY=" } },
  { id: "mcp-exa", name: "Exa", descKey: "mcp.presetExa", logo: exaLogo, prefill: { command: "npx", args: "-y exa-mcp-server", env: "EXA_API_KEY=" } },
  { id: "mcp-tavily", name: "Tavily", descKey: "mcp.presetTavily", logo: tavilyLogo, prefill: { command: "npx", args: "-y tavily-mcp", env: "TAVILY_API_KEY=" } },
  { id: "mcp-brave-search", name: "Brave Search", descKey: "mcp.presetBrave", logo: braveLogo, prefill: { command: "npx", args: "-y @brave/brave-search-mcp-server --transport stdio", env: "BRAVE_API_KEY=" } },
  { id: "mcp-perplexity", name: "Perplexity", descKey: "mcp.presetPerplexity", logo: perplexityLogo, prefill: { command: "npx", args: "-y server-perplexity-ask", env: "PERPLEXITY_API_KEY=" } },
];

function McpSection() {
  const { t } = useLocale();
  const { isCopied: isDeviceCodeCopied, copyToClipboard } = useCopyToClipboard();
  const send = useStore((state) => state.send);
  const servers = useStore((state) => state.mcpServers);
  const lastError = useStore((state) => state.lastError);
  const connectingIds = useStore((state) => state.mcpConnectingIds);
  const oauthAuthorization = useStore((state) => state.oauthAuthorization);
  const githubDeviceAuthorization = useStore((state) => state.githubDeviceAuthorization);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [args, setArgs] = useState("");
  const [tokenEnv, setTokenEnv] = useState("");
  const [envText, setEnvText] = useState("");
  const [prefillId, setPrefillId] = useState<string>();
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState("");
  const [oauthTokenUrl, setOauthTokenUrl] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [pendingOn, setPendingOn] = useState<ReadonlySet<string>>(new Set());
  // 卡片操作对话框：点卡片（开关以外区域）弹出，按钮按服务类型区分。
  const presetName = (preset: { name: string; nameKey?: MessageKey }) => preset.nameKey ? t(preset.nameKey) : preset.name;
  const [actionCard, setActionCard] = useState<{ name: string; icon: ReactNode; status: string; statusError?: boolean; actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] } | null>(null);
  const [githubLoginOpen, setGithubLoginOpen] = useState(false);
  const [githubClientId, setGithubClientId] = useState(configuredGithubClientId);
  const [githubSaving, setGithubSaving] = useState(false);
  const [query, setQuery] = useState("");
  // 填 key 即用的小对话框：只留 key 输入框，粘贴后直连。
  const [keyDialog, setKeyDialog] = useState<{ preset: (typeof KEY_PRESETS)[number]; fields: { key: string; value: string }[] } | null>(null);
  const [keySaving, setKeySaving] = useState(false);

  useEffect(() => {
    send({ type: "mcp.list", requestId: crypto.randomUUID() });
  }, [send]);

  // connect 是异步的（npx 首次还要下包），开关先乐观亮起，服务进列表后清掉 pending。
  useEffect(() => {
    setPendingOn((current) => {
      if (!current.size) return current;
      const next = new Set(current);
      for (const server of servers) next.delete(server.id);
      return next.size === current.size ? current : next;
    });
  }, [servers]);

  // 用户在设置页主动操作 = 已授权，先下发 allow 跳过聊天页审批卡。
  const connectAsUser = async (config: { id: string; name: string; command?: string; url?: string; args?: string[]; tokenEnv?: string; env?: Record<string, string>; authMode?: "oauth" | "github-device"; oauthClientId?: string; oauth?: { authorizationUrl: string; tokenUrl: string; clientId: string; tokenSecretKey?: string } }) => {
    // Wait until the permission command has been written to the sidecar before
    // dispatching connect; otherwise the two Tauri invokes can arrive out of order.
    const allowed = await send({ type: "permission.set", requestId: crypto.randomUUID(), subjectId: `mcp:${config.id}`, permission: "mcp.connect", decision: "allow" });
    const sent = allowed && await send({ type: "mcp.connect", requestId: crypto.randomUUID(), config });
    if (!sent) setPendingOn((current) => { const next = new Set(current); next.delete(config.id); return next; });
    return Boolean(sent);
  };

  const deleteServer = async (server: { id: string; oauth?: { tokenSecretKey?: string }; env?: Record<string, string> }) => {
    try {
      if (hasTauriBridge()) {
        const oauthKeys = [server.oauth?.tokenSecretKey ?? `mcp.oauth:${server.id}`, `mcp.oauth:${server.id}.client`, `mcp.oauth:${server.id}.tokens`];
        await Promise.all(oauthKeys.map((key) => invoke("secret_delete", { key }).catch(() => undefined)));
        const envKeys = Object.values(server.env ?? {}).filter((value) => value.startsWith("$mcp.env:")).map((value) => value.slice(1));
        for (const key of envKeys) {
          if (await invoke<string | null>("secret_get", { key }) !== null) await invoke("secret_delete", { key });
        }
      }
      await send({ type: "mcp.delete", requestId: crypto.randomUUID(), serverId: server.id });
    } catch (error) {
      useStore.setState({ lastError: localizeError(error) });
    }
  };

  const connectGitHub = async () => {
    const clientId = githubClientId.trim() || configuredGithubClientId;
    if (!clientId) return;
    setGithubSaving(true);
    try {
      setGithubLoginOpen(false);
      setPendingOn((current) => new Set(current).add("mcp-github"));
      await connectAsUser({ id: "mcp-github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authMode: "github-device", oauthClientId: clientId });
    } catch (error) {
      useStore.setState({ lastError: localizeError(error) });
    } finally {
      setGithubSaving(false);
    }
  };

  const togglePreset = (preset: (typeof MCP_PRESETS)[number], enabled: boolean) => {
    if (pendingOn.has(preset.id) && !servers.some((server) => server.id === preset.id)) return;
    if (enabled) {
      const server = servers.find((item) => item.id === preset.id);
      if (server) void deleteServer(server);
      return;
    }
    if (preset.id === "mcp-github") { setGithubLoginOpen(true); return; }
    setPendingOn((current) => new Set(current).add(preset.id));
    void connectAsUser({ id: preset.id, name: presetName(preset), ...preset.config });
  };

  const openAdd = (preset?: { id: string; name: string; prefill: { command: string; args: string; env: string } }) => {
    setPrefillId(preset?.id);
    setName(preset?.name ?? "");
    setCommand(preset?.prefill.command ?? "");
    setUrl("");
    setArgs(preset?.prefill.args ?? "");
    setTokenEnv("");
    setEnvText(preset?.prefill.env ?? "");
    setOauthAuthorizationUrl(""); setOauthTokenUrl(""); setOauthClientId("");
    setAddOpen(true);
  };

  const openEdit = (server: (typeof servers)[number]) => {
    setPrefillId(server.id);
    setName(server.name);
    setCommand(server.command ?? "");
    setUrl(server.url ?? "");
    setArgs((server.args ?? []).join(" "));
    setTokenEnv(server.tokenEnv ?? "");
    setEnvText(Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"));
    setOauthAuthorizationUrl(server.oauth?.authorizationUrl ?? "");
    setOauthTokenUrl(server.oauth?.tokenUrl ?? "");
    setOauthClientId(server.oauth?.clientId ?? "");
    setAddOpen(true);
  };

  // 邮箱项需要凭证，开关 = 打开预填好的添加对话框；已添加的服务按预设 id 显示为开启。
  const toggleEmailPreset = (preset: { id: string; name: string; prefill: { command: string; args: string; env: string } }, enabled: boolean) => {
    if (enabled) {
      send({ type: "mcp.delete", requestId: crypto.randomUUID(), serverId: preset.id });
      return;
    }
    openAdd(preset);
  };

  const customServers = servers.filter((server) => !MCP_PRESETS.some((preset) => preset.id === server.id) && !EMAIL_PRESETS.some((preset) => preset.id === server.id) && !KEY_PRESETS.some((preset) => preset.id === server.id));

  // 填 key 即用：开关点开只有 key 输入框的小窗，保存凭据后立即连接。
  const openKeyDialog = (preset: (typeof KEY_PRESETS)[number]) => {
    setKeyDialog({
      preset,
      fields: preset.prefill.env.split("\n").map((line) => {
        const i = line.indexOf("=");
        return { key: (i >= 0 ? line.slice(0, i) : line).trim(), value: i >= 0 ? line.slice(i + 1).trim() : "" };
      }).filter((field) => field.key),
    });
  };

  const submitKeyDialog = async () => {
    if (!keyDialog || keySaving || keyDialog.fields.some((field) => !field.value.trim())) return;
    const { preset } = keyDialog;
    setKeySaving(true);
    try {
      const env = Object.fromEntries(keyDialog.fields.map((field) => [field.key, `$mcp.env:${preset.id}/${field.key}`]));
      for (const field of keyDialog.fields) {
        const key = `mcp.env:${preset.id}/${field.key}`;
        await invoke("secret_set", { key, value: field.value.trim() });
        const sent = await send({ type: "secret.set", requestId: crypto.randomUUID(), key, value: field.value.trim() });
        if (!sent) throw new Error(t("error.mcpKeySendFailed"));
      }
      setPendingOn((current) => new Set(current).add(preset.id));
      if (await connectAsUser({ id: preset.id, name: presetName(preset), command: preset.prefill.command, args: preset.prefill.args.trim().split(/\s+/), env })) setKeyDialog(null);
    } catch (error) {
      useStore.setState({ lastError: localizeError(error) });
    } finally {
      setKeySaving(false);
    }
  };

  const toggleKeyPreset = (preset: (typeof KEY_PRESETS)[number], enabled: boolean) => {
    if (enabled) {
      const server = servers.find((item) => item.id === preset.id);
      if (server) void deleteServer(server);
      return;
    }
    openKeyDialog(preset);
  };

  const openKeyActions = (preset: (typeof KEY_PRESETS)[number], icon: ReactNode, status: string, statusError: boolean) => {
    const server = servers.find((item) => item.id === preset.id);
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = server
      ? [
          { label: t("mcp.reconnect"), primary: true, onClick: () => { setActionCard(null); setPendingOn((current) => new Set(current).add(preset.id)); void connectAsUser(server); } },
          { label: t("mcp.editKey"), onClick: () => { setActionCard(null); openKeyDialog(preset); } },
          { label: t("mcp.remove"), danger: true, onClick: () => { setActionCard(null); void deleteServer(server); } },
        ]
      : [{ label: t("mcp.fillKey"), primary: true, onClick: () => { setActionCard(null); openKeyDialog(preset); } }];
    setActionCard({ name: presetName(preset), icon, status, statusError, actions });
  };

  // 预设卡操作框：OAuth/GitHub 类出登录/退出登录，stdio 类出重连/移除。
  const openPresetActions = (preset: (typeof MCP_PRESETS)[number], icon: ReactNode, status: string, statusError: boolean) => {
    const server = servers.find((item) => item.id === preset.id);
    const isGithub = preset.id === "mcp-github";
    const isAccount = preset.config.authMode === "oauth" || isGithub;
    const needsUpgrade = Boolean(server && ((preset.config.authMode === "oauth" && (server.authMode !== "oauth" || server.url !== preset.config.url)) || (isGithub && server.tokenEnv === "GITHUB_TOKEN")));
    const startConnect = () => {
      setActionCard(null);
      if (isGithub) { setGithubLoginOpen(true); return; }
      setPendingOn((current) => new Set(current).add(preset.id));
      void connectAsUser({ id: preset.id, name: presetName(preset), ...preset.config });
    };
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = [{ label: needsUpgrade ? t("mcp.upgradeAccount") : server ? (isAccount ? t("mcp.relogin") : t("mcp.reconnect")) : (isAccount ? t("mcp.signIn") : t("mcp.connect")), primary: true, onClick: startConnect }];
    if (server) actions.push({ label: isAccount ? t("mcp.logout") : t("mcp.remove"), danger: true, onClick: () => { setActionCard(null); void deleteServer(server); } });
    setActionCard({ name: presetName(preset), icon, status, statusError, actions });
  };

  // 凭证类卡操作框：凭证即配置，所以给"修改账号配置"入口；已添加的再给重连和移除。
  const openEmailActions = (preset: { id: string; name: string; prefill: { command: string; args: string; env: string } }, icon: ReactNode, status: string, statusError: boolean) => {
    const server = servers.find((item) => item.id === preset.id);
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = server
      ? [
          { label: t("mcp.reconnect"), primary: true, onClick: () => { setActionCard(null); setPendingOn((current) => new Set(current).add(preset.id)); void connectAsUser(server); } },
          { label: t("mcp.editAccount"), onClick: () => { setActionCard(null); openAdd(preset); } },
          { label: t("mcp.remove"), danger: true, onClick: () => { setActionCard(null); void deleteServer(server); } },
        ]
      : [{ label: t("mcp.configureAccount"), primary: true, onClick: () => { setActionCard(null); openAdd(preset); } }];
    setActionCard({ name: presetName(preset), icon, status, statusError, actions });
  };

  // 自定义服务操作框：重连、OAuth 授权（如有）、删除。
  const openCustomActions = (server: (typeof servers)[number]) => {
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[] = [
      { label: t("mcp.reconnect"), primary: true, onClick: () => { setActionCard(null); void connectAsUser(server); } },
      { label: t("mcp.editService"), onClick: () => { setActionCard(null); openEdit(server); } },
      ...(server.oauth ? [{ label: t("mcp.authorize"), onClick: () => { setActionCard(null); void send({ type: "mcp.oauth.begin", requestId: crypto.randomUUID(), serverId: server.id }); } }] : []),
      { label: t("mcp.remove"), danger: true, onClick: async () => { if (!await confirmDestructiveAction(t("mcp.deleteConfirm", { name: server.name }))) return; setActionCard(null); await deleteServer(server); } },
    ];
    const connecting = connectingIds.includes(server.id);
    setActionCard({ name: server.name, icon: <span className="settings-provider-icon"><Command size={16} /></span>, status: connecting ? t("mcp.connectingStatus") : server.connected ? t("mcp.connectedStatus") : t("mcp.disconnectedStatus"), statusError: !connecting && !server.connected, actions });
  };

  const connect = () => {
    if (!name.trim() || (!command.trim() && !url.trim())) return;
    if (command.trim() && url.trim()) return;
    const id = name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || `mcp-${Date.now()}`;
    void connectAsUser({
      id: prefillId ?? id,
      name: name.trim(),
      command: command.trim() || undefined,
      url: url.trim() || undefined,
      tokenEnv: tokenEnv.trim() || undefined,
      args: args.trim() ? args.trim().split(/\s+/) : [],
      env: envText.trim() ? Object.fromEntries(envText.split("\n").map((line) => line.trim()).filter((line) => line && line.includes("=")).map((line) => { const i = line.indexOf("="); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; })) : undefined,
      oauth: oauthAuthorizationUrl.trim() && oauthTokenUrl.trim() && oauthClientId.trim() ? { authorizationUrl: oauthAuthorizationUrl.trim(), tokenUrl: oauthTokenUrl.trim(), clientId: oauthClientId.trim(), tokenSecretKey: `mcp.oauth:${id}` } : undefined,
    });
    setName(""); setCommand(""); setUrl(""); setArgs(""); setTokenEnv(""); setEnvText(""); setPrefillId(undefined); setOauthAuthorizationUrl(""); setOauthTokenUrl(""); setOauthClientId("");
  };

  return (
    <>
      <SectionHeader eyebrow={t("mcp.eyebrow")} title={t("mcp.title")} />
      {lastError === t("mcp.nodeRequired") && <div className="error-banner" role="alert">
        <span>{lastError}</span>
        <div className="settings-toolbar-actions">
          <button type="button" className="settings-secondary-action" onClick={() => void openUrl("https://nodejs.org/en/download")}>{t("mcp.downloadNode")}</button>
          <button type="button" className="icon-button" aria-label={t("common.close")} onClick={() => useStore.setState({ lastError: undefined })}><X size={15} /></button>
        </div>
      </div>}
      <div className="settings-section-toolbar"><div><strong>{t("mcp.addService")}</strong><span>{t("mcp.addDescription")}</span></div><div className="settings-toolbar-actions"><label className="settings-search"><Search size={13} /><input type="search" placeholder={t("common.search")} value={query} onChange={(event) => setQuery(event.target.value)} /></label><button type="button" className="settings-primary-action" onClick={() => openAdd()}><Plus size={15} />{t("mcp.add")}</button></div></div>
      <div className="settings-mcp-list">{MCP_PRESETS.filter((preset) => { const q = query.trim().toLowerCase(); return !q || presetName(preset).toLowerCase().includes(q) || t(preset.descKey).toLowerCase().includes(q); }).map((preset) => {
        const server = servers.find((item) => item.id === preset.id);
        const connecting = pendingOn.has(preset.id) || connectingIds.includes(preset.id);
        // 已配置但掉线（登录态丢失/连接失败）：开关回落为关 + 卡片爆红提示，点开=重连。
        const failed = Boolean(server && !server.connected && !connecting);
        const enabled = connecting || Boolean(server?.connected);
        const authorization = oauthAuthorization?.serverId === preset.id ? oauthAuthorization : undefined;
        const device = githubDeviceAuthorization?.serverId === preset.id ? githubDeviceAuthorization : undefined;
        const detail = connecting
          ? authorization ? t("mcp.waitingForLogin") : device ? t("mcp.githubCode", { code: device.userCode }) : t("mcp.connectingStatus")
          : server?.connected
            ? `${server.toolCount ?? 0} ${t("mcp.tools")} · ${t("mcp.connectedStatus")}`
            : server ? t("mcp.disconnectedStatus") : t(preset.descKey);
        const icon = <span className="settings-provider-icon" style={preset.lightBadge ? { background: "#fff", color: "#0f0f0f" } : undefined}>
          {preset.mono ? <span className="settings-mcp-logo settings-mcp-logo-mono" aria-hidden="true" style={{ maskImage: `url("${preset.logo}")`, WebkitMaskImage: `url("${preset.logo}")` }} /> : <img className="settings-mcp-logo" src={preset.logo} alt="" aria-hidden="true" draggable={false} />}
        </span>;
        return <div className={cn("settings-mcp-card", "is-actionable", failed && "is-error")} key={preset.id} role="button" tabIndex={0} onClick={() => openPresetActions(preset, icon, detail, failed)} onKeyDown={(event) => { if (event.key === "Enter") openPresetActions(preset, icon, detail, failed); }}>
          {icon}
          <div><strong>{presetName(preset)}</strong><small className="settings-mcp-status" role="status">{connecting && <LoaderCircle size={13} className="settings-spin" aria-hidden="true" />}<span>{detail}</span></small>{device && <button type="button" className="settings-mcp-device-code" title={t("mcp.copyDeviceCode")} aria-label={t("mcp.copyDeviceCode")} onClick={(event) => { event.stopPropagation(); copyToClipboard(device.userCode); }}>{isDeviceCodeCopied ? t("mcp.deviceCodeCopied") : device.userCode}</button>}{authorization && <button type="button" className="settings-mcp-auth-link" onClick={(event) => { event.stopPropagation(); void openUrl(authorization.url); }}>{t("mcp.openLogin")}</button>}{device && <button type="button" className="settings-mcp-auth-link" onClick={(event) => { event.stopPropagation(); void openUrl(device.verificationUri); }}>{t("mcp.openLogin")}</button>}</div>
          <button type="button" role="switch" aria-checked={enabled} aria-busy={connecting} aria-label={presetName(preset)} disabled={connecting && !authorization && !device} className={cn("settings-switch", enabled && "is-on")} onClick={(event) => { event.stopPropagation(); togglePreset(preset, enabled); }}>
            <span />
          </button>
        </div>;
      })}</div>
      <div className="settings-mcp-list">{[...KEY_PRESETS, ...EMAIL_PRESETS].filter((preset) => { const q = query.trim().toLowerCase(); return !q || presetName(preset).toLowerCase().includes(q) || t(preset.descKey).toLowerCase().includes(q); }).map((preset) => {
        const server = servers.find((item) => item.id === preset.id);
        const connecting = connectingIds.includes(preset.id) || pendingOn.has(preset.id);
        const failed = Boolean(server && !server.connected && !connecting);
        const enabled = connecting || Boolean(server?.connected);
        const detail = connecting
          ? t("mcp.connectingStatus")
          : server?.connected
            ? `${server.toolCount ?? 0} ${t("mcp.tools")} · ${t("mcp.connectedStatus")}`
            : server ? t("mcp.disconnectedStatus") : t(preset.descKey);
        const LucideIcon = preset.lucide;
        const icon = <span className="settings-provider-icon" style={preset.badgeStyle}>
          {LucideIcon ? <LucideIcon size={16} /> : preset.mono ? <span className="settings-mcp-logo settings-mcp-logo-mono" aria-hidden="true" style={{ maskImage: `url("${preset.logo}")`, WebkitMaskImage: `url("${preset.logo}")` }} /> : <img className="settings-mcp-logo" src={preset.logo} alt="" aria-hidden="true" draggable={false} />}
        </span>;
        const isKeyPreset = KEY_PRESETS.some((item) => item.id === preset.id);
        return <div className={cn("settings-mcp-card", "is-actionable", failed && "is-error")} key={preset.id} role="button" tabIndex={0} onClick={() => isKeyPreset ? openKeyActions(preset, icon, detail, failed) : openEmailActions(preset, icon, detail, failed)} onKeyDown={(event) => { if (event.key === "Enter") isKeyPreset ? openKeyActions(preset, icon, detail, failed) : openEmailActions(preset, icon, detail, failed); }}>
          {icon}
          <div><strong>{presetName(preset)}</strong><small className="settings-mcp-status" role="status">{connecting && <LoaderCircle size={13} className="settings-spin" aria-hidden="true" />}<span>{detail}</span></small></div>
          <button type="button" role="switch" aria-checked={enabled} aria-busy={connecting} aria-label={presetName(preset)} disabled={connecting} className={cn("settings-switch", enabled && "is-on")} onClick={(event) => { event.stopPropagation(); isKeyPreset ? toggleKeyPreset(preset, enabled) : toggleEmailPreset(preset, enabled); }}>
            <span />
          </button>
        </div>;
      })}</div>
      {customServers.length > 0 && <div className="settings-mcp-list">{customServers.filter((server) => { const q = query.trim().toLowerCase(); return !q || server.name.toLowerCase().includes(q) || (server.command ?? server.url ?? "").toLowerCase().includes(q); }).map((server) => {
        const connecting = connectingIds.includes(server.id);
        const status = connecting ? t("mcp.connectingStatus") : server.connected ? `${server.toolCount ?? 0} ${t("mcp.tools")}` : t("mcp.disconnectedStatus");
        return <div className="settings-mcp-card is-actionable" key={server.id} role="button" tabIndex={0} onClick={() => openCustomActions(server)} onKeyDown={(event) => { if (event.key === "Enter") openCustomActions(server); }}>
          <span className="settings-provider-icon"><Command size={16} /></span>
          <div><strong>{server.name}</strong><small className="settings-mcp-status" role="status">{connecting && <LoaderCircle size={13} className="settings-spin" aria-hidden="true" />}<span>{server.command ?? server.url} · {status}</span></small></div>
          <em className={server.connected ? "is-connected" : "is-disconnected"}>{connecting ? t("mcp.connectingStatus") : server.connected ? t("mcp.connectedStatus") : t("mcp.disconnectedStatus")}</em>
        </div>;
      })}</div>}
      {addOpen && (
        <div className="settings-subdialog-layer">
          <div className="settings-subdialog" role="dialog" aria-modal="true" aria-label={t("mcp.addService")}>
            <div className="settings-subdialog-header"><div><span>MCP</span><h3>{t("mcp.addService")}</h3></div><button type="button" className="settings-dialog-close" onClick={() => setAddOpen(false)} aria-label={t("common.close")}><X size={17} /></button></div>
            <div className="settings-form-grid"><label className="is-wide">{t("mcp.name")}<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("mcp.namePlaceholder")} /></label><label>{t("mcp.command")}<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></label><label>{t("mcp.arguments")}<input value={args} onChange={(event) => setArgs(event.target.value)} placeholder={t("mcp.argumentsPlaceholder")} /></label><label className="is-wide">{t("mcp.httpUrl")}<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label><label>{t("mcp.tokenEnv")}<input value={tokenEnv} onChange={(event) => setTokenEnv(event.target.value)} placeholder={t("mcp.optional")} /></label><label className="is-wide">{t("mcp.envVars")}<textarea rows={4} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={t("mcp.envVarsPlaceholder")} /></label></div>
            <div className="settings-form-grid"><label>{t("mcp.oauthAuthorization")}<input value={oauthAuthorizationUrl} onChange={(event) => setOauthAuthorizationUrl(event.target.value)} placeholder={t("mcp.optional")} /></label><label>{t("mcp.oauthToken")}<input value={oauthTokenUrl} onChange={(event) => setOauthTokenUrl(event.target.value)} placeholder={t("mcp.optional")} /></label><label>{t("mcp.oauthClient")}<input value={oauthClientId} onChange={(event) => setOauthClientId(event.target.value)} placeholder={t("mcp.optional")} /></label></div>
            <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" onClick={() => setAddOpen(false)}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={!name.trim() || (!command.trim() && !url.trim()) || Boolean(command.trim() && url.trim())} onClick={() => { connect(); setAddOpen(false); }}><Plus size={15} />{t("mcp.connect")}</button></div>
          </div>
        </div>
      )}
      {githubLoginOpen && <div className="settings-subdialog-layer"><div className="settings-subdialog" role="dialog" aria-modal="true" aria-label={t("mcp.githubLoginTitle")}>
        <div className="settings-subdialog-header"><div><span>GitHub MCP</span><h3>{t("mcp.githubLoginTitle")}</h3></div><button type="button" className="settings-dialog-close" onClick={() => setGithubLoginOpen(false)} aria-label={t("common.close")}><X size={17} /></button></div>
        <p>{configuredGithubClientId ? t("mcp.githubOAuthConfigured") : t("mcp.githubLoginHelp")}</p>
        {!configuredGithubClientId && <div className="settings-form-grid"><label className="is-wide">{t("mcp.githubClientId")}<input value={githubClientId} onChange={(event) => setGithubClientId(event.target.value)} placeholder={t("mcp.required")} /></label></div>}
        <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" onClick={() => setGithubLoginOpen(false)}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={githubSaving || !githubClientId.trim()} onClick={() => void connectGitHub()}>{t("mcp.githubSignIn")}</button></div>
      </div></div>}
      {keyDialog && (
        <div className="settings-subdialog-layer" onClick={(event) => { if (!keySaving && event.target === event.currentTarget) setKeyDialog(null); }}>
          <div className="settings-subdialog settings-mcp-action-dialog" role="dialog" aria-modal="true" aria-label={presetName(keyDialog.preset)}>
            <div className="settings-subdialog-header"><div><span>MCP</span><h3>{presetName(keyDialog.preset)}</h3></div><button type="button" className="settings-dialog-close" disabled={keySaving} onClick={() => setKeyDialog(null)} aria-label={t("common.close")}><X size={17} /></button></div>
            <div className="settings-form-grid">{keyDialog.fields.map((field, index) => <label key={field.key} className="is-wide">{field.key}<input type="password" autoComplete="off" autoFocus={index === 0} disabled={keySaving} value={field.value} onChange={(event) => setKeyDialog({ ...keyDialog, fields: keyDialog.fields.map((item, i) => i === index ? { ...item, value: event.target.value } : item) })} placeholder={t("mcp.pasteKey")} /></label>)}</div>
            <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" disabled={keySaving} onClick={() => setKeyDialog(null)}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={keySaving || keyDialog.fields.some((field) => !field.value.trim())} onClick={() => void submitKeyDialog()}>{t("mcp.connect")}</button></div>
          </div>
        </div>
      )}
      {actionCard && (
        <div className="settings-subdialog-layer" onClick={(event) => { if (event.target === event.currentTarget) setActionCard(null); }}>
          <div className="settings-subdialog settings-mcp-action-dialog" role="dialog" aria-modal="true" aria-label={actionCard.name}>
            <div className="settings-subdialog-header"><div><span>MCP</span><h3>{actionCard.name}</h3></div><button type="button" className="settings-dialog-close" onClick={() => setActionCard(null)} aria-label={t("common.close")}><X size={17} /></button></div>
            <div className="settings-mcp-action-hero">{actionCard.icon}<div><strong>{actionCard.name}</strong><small className={cn("settings-mcp-status", actionCard.statusError && "is-error")} role="status"><span>{actionCard.status}</span></small></div></div>
            <div className="settings-mcp-actions">{actionCard.actions.map((action) => <button key={action.label} type="button" className={action.danger ? "settings-mcp-action-danger" : action.primary ? "settings-primary-action" : "settings-secondary-action"} onClick={() => void action.onClick()}>{action.label}</button>)}</div>
          </div>
        </div>
      )}
    </>
  );
}


function SectionContent({ activeSection }: { activeSection: SettingsSectionId }) {
  switch (activeSection) {
    case "general": return <GeneralSection />;
    case "personalization": return <PersonalizationSection />;
    case "configuration": return <ConfigurationSection />;
    case "models": return <ModelsSection />;
    case "mcp": return <McpSection />;
    case "skills": return <SkillsSection />;
    case "subagents": return <SubagentsSection />;
    case "compaction": return <CompactionSection />;
  }
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("general");
  const [sectionOrder, setSectionOrder] = useState<SettingsSectionId[]>(loadSectionOrder);
  const [draggingId, setDraggingId] = useState<SettingsSectionId | null>(null);
  const [dragPoint, setDragPoint] = useState({ x: 0, y: 0 });
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const dragIdRef = useRef<SettingsSectionId | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const pointerDownRef = useRef(false);
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const dragPointRef = useRef({ x: 0, y: 0 });
  const dragOriginOrderRef = useRef<SettingsSectionId[] | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(sectionOrder));
  }, [sectionOrder]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !getConfirmationRequest() && !(event.target instanceof Element && event.target.closest('[role="alertdialog"]'))) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const clearInteraction = () => {
    clearLongPress();
    pointerDownRef.current = false;
    const wasDragging = Boolean(dragIdRef.current);
    if (wasDragging) {
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    dragIdRef.current = null;
    dragPointerIdRef.current = null;
    dragOriginOrderRef.current = null;
    setDraggingId(null);
  };

  const cancelDrag = () => {
    if (dragIdRef.current && dragOriginOrderRef.current) setSectionOrder(dragOriginOrderRef.current);
    clearInteraction();
  };

  const activateDrag = (id: SettingsSectionId, point = pointerStartRef.current) => {
    clearLongPress();
    dragIdRef.current = id;
    dragOriginOrderRef.current = [...sectionOrder];
    dragPointRef.current = point;
    setDragPoint(point);
    setDraggingId(id);
    navigator.vibrate?.(20);
  };

  const beginLongPress = (id: SettingsSectionId, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    clearLongPress();
    pointerDownRef.current = true;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    dragPointerIdRef.current = event.pointerId;
    longPressTimerRef.current = window.setTimeout(() => {
      activateDrag(id, pointerStartRef.current);
    }, LONG_PRESS_MS);
  };

  const getPreviewOrder = (order: SettingsSectionId[], dragging: SettingsSectionId, dropY: number) => {
    const remaining = order.filter((id) => id !== dragging);
    const insertIndex = remaining.findIndex((id) => {
      const element = document.querySelector<HTMLElement>(`[data-settings-nav-id="${id}"]`);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return dropY < rect.top + rect.height / 2;
    });
    const nextOrder = [...remaining];
    nextOrder.splice(insertIndex < 0 ? remaining.length : insertIndex, 0, dragging);
    return nextOrder;
  };

  const commitDrop = (dropY: number, pointerId?: number) => {
    if (pointerId !== undefined && dragPointerIdRef.current !== null && pointerId !== dragPointerIdRef.current) return;
    const dragging = dragIdRef.current;
    if (!dragging) {
      clearInteraction();
      return;
    }
    setSectionOrder((currentOrder) => getPreviewOrder(currentOrder, dragging, dropY));
    clearInteraction();
  };

  const handleButtonPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragIdRef.current) commitDrop(event.clientY, event.pointerId);
    else clearInteraction();
  };

  useEffect(() => {
    const cancelPendingPointer = () => {
      if (dragIdRef.current) return;
      clearInteraction();
    };
    window.addEventListener("pointerup", cancelPendingPointer);
    window.addEventListener("pointercancel", cancelPendingPointer);
    return () => {
      window.removeEventListener("pointerup", cancelPendingPointer);
      window.removeEventListener("pointercancel", cancelPendingPointer);
    };
  }, []);

  useEffect(() => {
    if (!draggingId) return;
    const handleWindowPointerMove = (event: PointerEvent) => {
      if (dragPointerIdRef.current !== null && event.pointerId !== dragPointerIdRef.current) return;
      event.preventDefault();
      const point = { x: event.clientX, y: event.clientY };
      dragPointRef.current = point;
      setDragPoint(point);
      const dragging = dragIdRef.current;
      if (dragging) setSectionOrder((currentOrder) => getPreviewOrder(currentOrder, dragging, event.clientY));
    };
    const handleWindowPointerUp = (event: PointerEvent) => commitDrop(event.clientY, event.pointerId);
    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", cancelDrag);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", cancelDrag);
    };
  }, [draggingId]);

  const handlePointerMoveBeforeDrag = (id: SettingsSectionId, event: ReactPointerEvent<HTMLButtonElement>) => {
    const distance = Math.hypot(event.clientX - pointerStartRef.current.x, event.clientY - pointerStartRef.current.y);
    if (pointerDownRef.current && !dragIdRef.current && distance > 7) {
      event.preventDefault();
      activateDrag(id, { x: event.clientX, y: event.clientY });
    }
  };

  const moveSectionByKeyboard = (id: SettingsSectionId, direction: -1 | 1) => {
    setSectionOrder((currentOrder) => {
      const currentIndex = currentOrder.indexOf(id);
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= currentOrder.length) return currentOrder;
      const nextOrder = [...currentOrder];
      [nextOrder[currentIndex], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[currentIndex]];
      return nextOrder;
    });
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="settings-dialog-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          <button className="settings-dialog-backdrop" type="button" aria-label={t("common.closeSettings")} onClick={onClose} />
          <motion.div className={cn("settings-dialog", (activeSection === "models" || activeSection === "configuration") && "is-model-page", draggingId && "is-dragging")} role="dialog" aria-modal="true" aria-label={t("common.settings")} initial={{ opacity: 0, scale: 0.975, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: 8 }} transition={{ type: "spring", stiffness: 430, damping: 35 }}>
            <button ref={closeButtonRef} className="settings-dialog-close" type="button" onClick={onClose} aria-label={t("common.closeSettings")}><X size={18} /></button>
            <aside className="settings-dialog-sidebar">
              <nav className={cn("settings-dialog-nav", draggingId && "is-dragging-nav")} aria-label={t("accessibility.settings")}>
                {sectionOrder.map((id) => {
                  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === id)!;
                  const Icon = section.icon;
                  return (
                    <motion.div key={id} layout transition={{ type: "spring", stiffness: 520, damping: 38 }}>
                      <button
                        type="button"
                        data-settings-nav-id={id}
                        className={cn("settings-dialog-nav-item", activeSection === id && "is-active", draggingId === id && "is-dragging")}
                        aria-current={activeSection === id ? "page" : undefined}
                        aria-label={`${t(section.labelKey)}. ${t("nav.dragHint")}`}
                        onClick={() => {
                          if (!suppressClickRef.current) setActiveSection(id);
                        }}
                        onPointerDown={(event) => beginLongPress(id, event)}
                        onPointerMove={(event) => handlePointerMoveBeforeDrag(id, event)}
                        onPointerUp={handleButtonPointerUp}
                        onPointerCancel={cancelDrag}
                        onKeyDown={(event) => {
                          if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                          event.preventDefault();
                          moveSectionByKeyboard(id, event.key === "ArrowUp" ? -1 : 1);
                        }}
                      >
                        <Icon size={17} />
                        <span><strong>{t(section.labelKey)}</strong></span>
                      </button>
                    </motion.div>
                  );
                })}
              </nav>
            </aside>
            <main className="settings-dialog-content" aria-live="polite">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={activeSection} className="settings-dialog-section" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -5 }} transition={{ duration: 0.14 }}>
                  <SectionContent activeSection={activeSection} />
                </motion.div>
              </AnimatePresence>
            </main>
          </motion.div>
          {draggingId && (() => {
            const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === draggingId)!;
            const Icon = section.icon;
            return <motion.div className="settings-drag-preview" style={{ left: dragPoint.x + 12, top: dragPoint.y }} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}><Icon size={17} /><strong>{t(section.labelKey)}</strong></motion.div>;
          })()}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
