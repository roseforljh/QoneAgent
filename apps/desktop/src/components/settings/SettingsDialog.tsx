import { modelListUrl, modelNamesEqual, type ProviderApiType } from "@qone/protocol";
import { PROVIDERS_STORAGE_KEY, ACTIVE_PROVIDER_STORAGE_KEY, MODEL_CONFIG_CHANGE_EVENT } from "../../lib/model-picker-data";
import { fetchProviderModelCatalog } from "../../lib/provider-model-catalog";
import { capabilities, defaultModelSettings, mergeFetchedModel, normalizeThinkingLevel, parseModelsResponse, thinkingLevelOptionsForApi, withResolvedModelSettings, type Capability, type ModelSettingField, type ModelSettings, type ProviderModel, type ProviderProfile, type ThinkingLevel } from "../../lib/model-settings";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { hasTauriBridge, requestModelMetadata } from "../../store";
import { MemoryChips, type MemoryChip } from "../assistant-ui/elements/memory-chips";
import { QoneSelect } from "../ui/Select";
import {
  Bot,
  BrainCircuit,
  BotMessageSquare,
  Check,
  ChevronRight,
  CircleUserRound,
  Command,
  CircleHelp,
  Globe2,
  LoaderCircle,
  MonitorCog,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { confirmDestructiveAction, getConfirmationRequest } from "../../lib/confirm-action";
import { GENERAL_SETTINGS_KEY, readGeneralSettings, saveLanguageSetting, useLocale, type LanguageSetting, type LocalizedMessage } from "../../localization";
import { ModelCard } from "./ModelCard";
import { ProviderLogo } from "./ProviderLogo";
import "./model-layout.css";

type Theme = "light" | "dark";
type SettingsSectionId = "general" | "personalization" | "configuration" | "models" | "mcp" | "skills" | "subagents";

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
];

const DEFAULT_ORDER = SETTINGS_SECTIONS.map((section) => section.id);

type GeneralSettings = { contrast: "enhanced" | "default" | "reduced"; accent: "purple" | "blue" | "green" };
const DEFAULT_GENERAL_SETTINGS: GeneralSettings = { contrast: "default", accent: "purple" };

function loadGeneralSettings(): GeneralSettings {
  try {
    const saved = JSON.parse(window.localStorage.getItem(GENERAL_SETTINGS_KEY) ?? "null") as Partial<GeneralSettings> | null;
    return { ...DEFAULT_GENERAL_SETTINGS, ...(saved ?? {}) };
  } catch { return DEFAULT_GENERAL_SETTINGS; }
}

function saveGeneralSettings(settings: GeneralSettings) {
  window.localStorage.setItem(GENERAL_SETTINGS_KEY, JSON.stringify({ ...readGeneralSettings(), contrast: settings.contrast, accent: settings.accent }));
  document.documentElement.dataset.contrast = settings.contrast;
  document.documentElement.dataset.accent = settings.accent;
}

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
    return item ? withResolvedModelSettings(model, item.metadata, item.thinkingLevels, item.sources) : model;
  });
}

type SettingsChoice = { value: string; label: string; description?: string };

function SettingsSelect({ value, options, onChange, prefix }: { value: string; options: SettingsChoice[]; onChange: (value: string) => void; prefix?: ReactNode }) {
  const { t } = useLocale();
  return <QoneSelect value={value} options={options} onChange={onChange} prefix={prefix} className="settings-select-wrap" triggerClassName="settings-value-button" menuClassName="settings-dropdown" align="end" ariaLabel={t("accessibility.option")} />;
}

function GeneralSection({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const { t, languageSetting } = useLocale();
  const [updateStatus, setUpdateStatus] = useState<LocalizedMessage | null>(null);
  const [checking, setChecking] = useState(false);
  const [settings, setSettings] = useState<GeneralSettings>(loadGeneralSettings);
  const { contrast, accent } = settings;
  useEffect(() => { saveGeneralSettings(settings); }, [settings]);

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
      setUpdateStatus({ key: "general.updateFailed", values: { error: String(error) } });
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <SectionHeader eyebrow={t("general.eyebrow")} title={t("general.title")}>{t("general.description")}</SectionHeader>
      <div className="settings-general-options">
        <div className="settings-option-row">
          <strong>{t("general.appearance")}</strong>
          <SettingsSelect value={theme} onChange={(value) => { if (value !== theme) onToggleTheme(); }} options={[{ value: "light", label: t("general.light") }, { value: "dark", label: t("general.dark") }]} />
        </div>
        <div className="settings-option-row">
          <strong>{t("general.contrast")}</strong>
          <SettingsSelect value={contrast} onChange={(value) => setSettings((current) => ({ ...current, contrast: value as GeneralSettings["contrast"] }))} options={[{ value: "enhanced", label: t("general.enhanced"), description: t("general.enhancedDescription") }, { value: "default", label: t("general.default") }, { value: "reduced", label: t("general.reduced"), description: t("general.reducedDescription") }]} />
        </div>
        <div className="settings-option-row">
          <strong>{t("general.accent")}</strong>
          <SettingsSelect value={accent} onChange={(value) => setSettings((current) => ({ ...current, accent: value as GeneralSettings["accent"] }))} prefix={<i className={cn("settings-accent-dot", `is-${accent}`)} />} options={[{ value: "purple", label: t("general.purple") }, { value: "blue", label: t("general.blue") }, { value: "green", label: t("general.green") }]} />
        </div>
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

function ModelSyncDialog({ open, fetched, existing, onClose, onAdd }: { open: boolean; fetched: ProviderModel[]; existing: ProviderModel[]; onClose: () => void; onAdd: (models: ProviderModel[]) => void }) {
  const { t } = useLocale();
  const [tab, setTab] = useState<"new" | "missing">("new");
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setTab("new");
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
  return createPortal(
    <div className="settings-sync-layer">
      <div ref={dialogRef} tabIndex={-1} className="settings-subdialog settings-sync-dialog" role="dialog" aria-modal="true" aria-label={t("provider.sync")}>
        <div className="settings-subdialog-header"><div><span>{t("provider.sync")}</span><h3>{t("provider.providerModels")}</h3></div><button type="button" className="settings-dialog-close" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div>
        <p className="settings-inline-status" role="status">{t("provider.metadataSummary", { count: configuredCount, total: fetched.length })}</p>
        <div className="settings-tabs"><button type="button" className={cn(tab === "new" && "is-active")} onClick={() => setTab("new")}>{t("provider.newModels")} <em>{newModels.length}</em></button><button type="button" className={cn(tab === "missing" && "is-active")} onClick={() => setTab("missing")}>{t("provider.missingModels")} <em>{missingModels.length}</em></button></div>
        <div className="settings-sync-list">{(tab === "new" ? newModels : missingModels).map((model) => <div className="settings-sync-row" key={model.id}><span>{model.label}</span>{model.label !== model.id && <code>{model.id}</code>}</div>)}{(tab === "new" ? newModels : missingModels).length === 0 && <p className="settings-empty">{t(tab === "new" ? "provider.noNewModels" : "provider.noMissingModels")}</p>}</div>
        <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" onClick={onClose}>{t("common.cancel")}</button>{tab === "new" && <button type="button" className="settings-primary-action" onClick={() => { onAdd(newModels); onClose(); }}><Check size={15} />{t("provider.addNewModels")}</button>}</div>
      </div>
    </div>, document.body
  );
}

function ProviderConfigDialog({ open, initial, onClose, onSaved, onDeleted }: { open: boolean; initial?: ProviderProfile; onClose: () => void; onSaved: (profile: ProviderProfile) => void; onDeleted: (profile: ProviderProfile) => void }) {
  const { t } = useLocale();
  const [name, setName] = useState(initial?.name ?? "");
  const [apiType, setApiType] = useState<ProviderApiType>(initial?.apiType ?? "openai-compatible");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
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
    setName(initial?.name ?? ""); setApiType(initial?.apiType ?? "openai-compatible"); setBaseUrl(initial?.baseUrl ?? ""); setApiKey(""); setModels(initial?.models ?? []); setStatus(null); setSyncOpen(false); setFetchedModels([]); setFetching(false);
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
        if (sequence === fetchSequence.current) setStatus(error instanceof Error && error.message === "MODEL_METADATA_UNSUPPORTED" ? { key: "model.runtimeRestartRequired" } : { key: "provider.metadataFailed", values: { error: String(error) } });
      }
      if (sequence !== fetchSequence.current) return;
      const resolvedById = new Map(result.map((model) => [model.id, model]));
      setFetchedModels(result);
      setModels((current) => {
        return current.map((model) => {
          const resolved = resolvedById.get(model.id);
          if (!resolved) return model;
          const merged = mergeFetchedModel(model, resolved);
          return merged;
        });
      });
      setSyncOpen(true);
    } catch (error) {
      if (sequence === fetchSequence.current) setStatus({ key: "provider.fetchFailed", values: { error: String(error) } });
    } finally { if (sequence === fetchSequence.current) setFetching(false); }
  };

  const save = async () => {
    if (!name.trim() || !baseUrl.trim()) { setStatus({ key: "provider.requiredFields" }); return; }
    const profile: ProviderProfile = { id: initial?.id ?? providerId(name), name: name.trim(), apiType, baseUrl: normalizeBaseUrl(baseUrl), models, updatedAt: Date.now() };
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

  return <div className="settings-subdialog-layer"><div className="settings-subdialog provider-dialog" role="dialog" aria-modal="true" aria-label={t("provider.newConfiguration")}>
    <div className="settings-subdialog-header"><div><span>{t("provider.configuration")}</span><h3>{initial ? t("provider.editConfiguration") : t("provider.newConfiguration")}</h3></div><button type="button" className="settings-dialog-close" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div>
    <div className="settings-form-grid"><label>{t("provider.name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("provider.namePlaceholder")} /></label><label>{t("provider.apiType")}<QoneSelect value={apiType} onChange={(value) => setApiType(value as ProviderApiType)} options={Object.entries(providerApiLabelKeys).map(([value, key]) => ({ value, label: t(key) }))} ariaLabel={t("provider.apiType")} /></label><label className="is-wide">{t("provider.baseUrl")}<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={t("provider.baseUrlPlaceholder")} /><small className="settings-url-preview">{t("provider.urlPreview", { url: preview || t("provider.waitingForInput") })}</small></label><label className="is-wide">{t("provider.apiKey")}<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t("provider.apiKeyPlaceholder")} /></label></div>
    <div className="settings-provider-actions"><button type="button" className="settings-secondary-action" disabled={fetching} onClick={fetchModels}>{fetching ? <><LoaderCircle size={15} className="settings-spin" />{t("provider.fetching")}</> : <><Globe2 size={15} />{t("provider.fetchModels")}</>}</button><span>{models.length ? t("provider.configuredModels", { count: models.length }) : t("provider.noModels")}</span></div>
    {status && <p className="settings-inline-status" role="status">{t(status.key, status.values)}</p>}
    <div className="settings-subdialog-footer">{initial && <button type="button" className="settings-danger-action" onClick={remove}><Trash2 size={15} />{t("provider.delete")}</button>}<button type="button" className="settings-secondary-action" onClick={onClose}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" onClick={save}><Save size={15} />{t("provider.saveConfiguration")}</button></div>
    <ModelSyncDialog
      open={syncOpen}
      fetched={fetchedModels}
      existing={models}
      onClose={() => setSyncOpen(false)}
      onAdd={(newModels) => setModels((current) => [...current, ...newModels.filter((model) => !current.some((existing) => existing.id === model.id))])}
    />
  </div></div>;
}

function ConfigurationSection() {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(loadProviderProfiles);
  const [editing, setEditing] = useState<ProviderProfile | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState(() => window.localStorage.getItem(ACTIVE_PROVIDER_STORAGE_KEY) ?? loadProviderProfiles()[0]?.id ?? "");
  const saveProfile = (profile: ProviderProfile) => {
    const next = [...profiles.filter((item) => item.id !== profile.id), profile];
    setProfiles(next);
    window.localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, profile.id);
    saveProviderProfiles(next);
    for (const model of profile.models) send({ type: "model.upsert", requestId: crypto.randomUUID(), config: { id: `${profile.id}/${model.id}`, provider: profile.id, model: model.id, config: { apiType: profile.apiType, baseUrl: profile.baseUrl, ...(model.settings ?? defaultModelSettings()) }, enabled: true, updatedAt: Date.now() } });
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
          <ProviderLogo name={profile.name} baseUrl={profile.baseUrl} />
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

function ModelSourceSummary({ settings }: { settings: ModelSettings }) {
  const { t } = useLocale();
  const fields: Array<[ModelSettingField, string]> = [
    ["maxOutput", t("model.maxOutput")], ["maxContext", t("model.maxContext")],
    ["thinking", t("model.thinking")], ["input", t("model.inputCapabilities")], ["output", t("model.outputCapabilities")],
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
  const [settings, setSettings] = useState<ModelSettings>(model?.settings ?? defaultModelSettings());
  const [fetching, setFetching] = useState(false);
  const [status, setStatus] = useState<LocalizedMessage | null>(null);
  const fetchSequence = useRef(0);
  useEffect(() => {
    fetchSequence.current++;
    if (!open) return;
    setName(model?.id ?? ""); setSettings(model?.settings ?? defaultModelSettings()); setStatus(null); setFetching(false);
  }, [open, model?.id]);
  if (!open) return null;
  const apiType = settings.apiType ?? provider.apiType;
  const thinkingOptions = thinkingLevelOptionsForApi(apiType, settings.thinkingLevels);
  const update = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => setSettings((current) => ({
    ...current,
    [key]: value,
    metadataOverrides: ["maxOutput", "maxContext", "thinking", "input", "output"].includes(String(key))
      ? { ...(current.metadataOverrides ?? {}), [key]: true }
      : current.metadataOverrides,
  }));
  const updateApiType = (value: ProviderApiType) => setSettings((current) => ({
    ...current,
    apiType: value,
    thinkingLevels: undefined,
    thinking: normalizeThinkingLevel(current.thinking, value),
  }));
  const toggleCapability = (kind: "input" | "output", value: Capability) => update(kind, settings[kind].includes(value) ? settings[kind].filter((item) => item !== value) : [...settings[kind], value]);
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
      if (!resolved.settings?.modelMetadata || Object.keys(resolved.settings.modelMetadata).every((key) => key === "id" || key === "label")) {
        setStatus({ key: "model.noConfiguration" }); return;
      }
      setSettings((current) => ({ ...mergeFetchedModel({ id: modelId, label: modelId, settings: current }, resolved).settings!, apiType }));
      setStatus({ key: "model.configurationFetched" });
    } catch (error) { if (sequence === fetchSequence.current) setStatus(error instanceof Error && error.message === "MODEL_METADATA_UNSUPPORTED" ? { key: "model.runtimeRestartRequired" } : { key: "model.fetchConfigurationFailed", values: { error: String(error) } }); }
    finally { if (sequence === fetchSequence.current) setFetching(false); }
  };
  const save = () => { if (!name.trim()) return; onSaved({ id: name.trim(), label: name.trim(), settings: { ...settings, apiType } }, model?.id); onClose(); };
  const remove = async () => { if (model && await confirmDestructiveAction(t("model.deleteConfirm", { name: model.label }))) { onDeleted(model); onClose(); } };
  return <div className="settings-subdialog-layer"><div className="settings-subdialog model-editor-dialog" role="dialog" aria-modal="true" aria-label={t("model.parameters")}><div className="settings-subdialog-header"><div><span>{provider.name}</span><h3>{t("model.parameters")}</h3></div><button type="button" className="settings-dialog-close" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div><div className="settings-model-fetch"><button type="button" className="settings-secondary-action" disabled={fetching} onClick={fetchConfiguration}>{fetching ? <LoaderCircle size={15} className="settings-spin" /> : <Globe2 size={15} />}{fetching ? t("provider.fetching") : t("model.fetchConfiguration")}</button>{status && <p className="settings-inline-status" role="status">{t(status.key, status.values)}</p>}</div><ModelSourceSummary settings={settings} /><div className="settings-form-grid"><label className="is-wide">{t("model.name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("model.namePlaceholder")} /></label><label className="is-wide">{t("model.apiType")}<QoneSelect value={apiType} onChange={(value) => updateApiType(value as ProviderApiType)} options={Object.entries(providerApiLabelKeys).map(([value, key]) => ({ value, label: t(key) }))} ariaLabel={t("model.apiType")} /></label><label>{t("model.maxOutput")}<input type="number" min="1" value={settings.maxOutput} onChange={(event) => update("maxOutput", Math.max(1, Number(event.target.value) || 1))} /></label><label>{t("model.maxContext")}<input type="number" min="1" value={settings.maxContext} onChange={(event) => update("maxContext", Math.max(1, Number(event.target.value) || 1))} /></label><label>{t("model.thinking")}<QoneSelect value={settings.thinking} onChange={(value) => update("thinking", value as ThinkingLevel)} options={thinkingOptions.map((option) => ({ value: option.value, label: t(option.labelKey) }))} ariaLabel={t("model.thinking")} /></label></div><div className="settings-capability-grid"><CapabilityEditor title={t("model.inputCapabilities")} values={settings.input} onToggle={(value) => toggleCapability("input", value)} /><CapabilityEditor title={t("model.outputCapabilities")} values={settings.output} onToggle={(value) => toggleCapability("output", value)} /></div><div className="settings-subdialog-footer">{model && <button type="button" className="settings-danger-action" onClick={remove}><Trash2 size={15} />{t("model.delete")}</button>}<button type="button" className="settings-secondary-action" onClick={onClose}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" onClick={save}><Save size={15} />{t("model.saveParameters")}</button></div></div></div>;
}

function CapabilityEditor({ title, values, onToggle }: { title: string; values: Capability[]; onToggle: (value: Capability) => void }) {
  const { t } = useLocale();
  return <div className="settings-capability-group"><strong>{title}</strong><div>{capabilities.map((capability) => <button type="button" key={capability} className={cn("settings-capability-chip", values.includes(capability) && "is-selected")} onClick={() => onToggle(capability)}>{values.includes(capability) && <Check size={13} />}{t(`capability.${capability}`)}</button>)}</div></div>;
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
  useEffect(() => send({ type: "model.list", requestId: crypto.randomUUID() }), [send]);
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

type SubagentProfile = { id: string; name: string; instructions: string; modelId: string; enabled: boolean; updatedAt: number };
const SUBAGENTS_STORAGE_KEY = "qone-subagents";

function loadSubagents(): SubagentProfile[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SUBAGENTS_STORAGE_KEY) ?? "[]") as SubagentProfile[];
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function SubagentEditorDialog({ open, initial, modelOptions, onClose, onSaved }: { open: boolean; initial?: SubagentProfile; modelOptions: { id: string; label: string }[]; onClose: () => void; onSaved: (profile: SubagentProfile) => void }) {
  const { t } = useLocale();
  const [name, setName] = useState(initial?.name ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? modelOptions[0]?.id ?? "");
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? ""); setInstructions(initial?.instructions ?? ""); setModelId(initial?.modelId ?? modelOptions[0]?.id ?? "");
  }, [open, initial?.id, modelOptions[0]?.id]);
  const save = () => {
    if (!name.trim() || !instructions.trim() || !modelId) return;
    onSaved({ id: initial?.id ?? `subagent-${Date.now()}`, name: name.trim(), instructions: instructions.trim(), modelId, enabled: initial?.enabled ?? true, updatedAt: Date.now() });
    onClose();
  };
  if (!open) return null;
  return <div className="settings-subdialog-layer"><div className="settings-subdialog model-editor-dialog" role="dialog" aria-modal="true" aria-label={t("subagent.create")}><div className="settings-subdialog-header"><div><span>Sub-agent</span><h3>{initial ? t("subagent.edit") : t("subagent.create")}</h3></div><button type="button" className="settings-dialog-close" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div><div className="settings-form-grid"><label className="is-wide">{t("subagent.name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("subagent.namePlaceholder")} /></label><label className="is-wide">{t("subagent.driverModel")}<QoneSelect value={modelId} onChange={setModelId} placeholder={t("subagent.selectModel")} options={modelOptions.map((model) => ({ value: model.id, label: model.label }))} ariaLabel={t("subagent.driverModel")} /></label><label className="is-wide">{t("subagent.systemPrompt")}<textarea className="settings-subagent-prompt" rows={7} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={t("subagent.promptPlaceholder")} /></label></div><div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" onClick={onClose}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={!name.trim() || !instructions.trim() || !modelId} onClick={save}><Save size={15} />{t("subagent.save")}</button></div></div></div>;
}

function SubagentsSection() {
  const { t } = useLocale();
  const modelConfigs = useStore((state) => state.modelConfigs);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(loadProviderProfiles);
  const [agents, setAgents] = useState<SubagentProfile[]>(loadSubagents);
  const [editing, setEditing] = useState<SubagentProfile | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const modelOptions = Array.from(new Map([
    ...modelConfigs.map((model) => [`${model.provider}/${model.model}`, { id: model.id, label: `${model.provider} / ${model.model}` }] as const),
    ...profiles.flatMap((provider) => provider.models.map((model) => [`${provider.id}/${model.id}`, { id: `${provider.id}/${model.id}`, label: `${provider.name} / ${model.label}` }] as const)),
  ]).values());
  const saveAgents = (next: SubagentProfile[]) => { setAgents(next); window.localStorage.setItem(SUBAGENTS_STORAGE_KEY, JSON.stringify(next)); };
  const saveAgent = (agent: SubagentProfile) => saveAgents([...agents.filter((item) => item.id !== agent.id), agent]);
  const deleteAgent = async (agent: SubagentProfile) => { if (await confirmDestructiveAction(t("subagent.deleteConfirm", { name: agent.name }))) saveAgents(agents.filter((item) => item.id !== agent.id)); };
  return <>
    <SectionHeader eyebrow={t("subagent.eyebrow")} title={t("subagent.title")} />
    <div className="settings-section-toolbar"><div><strong>{t("subagent.mine")}</strong><span>{agents.length} {t("subagent.count")}</span></div><button type="button" className="settings-primary-action" onClick={() => { setEditing(undefined); setDialogOpen(true); }}><Plus size={15} />{t("subagent.new")}</button></div>
    <div className="settings-subagent-list">{agents.map((agent) => <div className="settings-subagent-card" key={agent.id}><div className="settings-subagent-card-main"><span className="settings-provider-icon"><BotMessageSquare size={17} /></span><div><strong>{agent.name}</strong><small>{modelOptions.find((model) => model.id === agent.modelId)?.label ?? agent.modelId}</small><p>{agent.instructions}</p></div></div><div className="settings-subagent-actions"><button type="button" onClick={() => { setEditing(agent); setDialogOpen(true); }}>{t("common.edit")}</button><button type="button" aria-label={t("subagent.delete", { name: agent.name })} onClick={() => deleteAgent(agent)}><Trash2 size={14} /></button></div></div>)}{agents.length === 0 && <div className="settings-empty-card"><BotMessageSquare size={22} /><p>{t("subagent.noAgents")}</p></div>}</div>
    <SubagentEditorDialog open={dialogOpen} initial={editing} modelOptions={modelOptions} onClose={() => setDialogOpen(false)} onSaved={saveAgent} />
  </>;
}

function McpSection() {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const servers = useStore((state) => state.mcpServers);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [args, setArgs] = useState("");
  const [tokenEnv, setTokenEnv] = useState("");
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState("");
  const [oauthTokenUrl, setOauthTokenUrl] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");

  useEffect(() => {
    send({ type: "mcp.list", requestId: crypto.randomUUID() });
  }, [send]);

  const connect = () => {
    if (!name.trim() || (!command.trim() && !url.trim())) return;
    if (command.trim() && url.trim()) return;
    const id = name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || `mcp-${Date.now()}`;
    send({
      type: "mcp.connect",
      requestId: crypto.randomUUID(),
      config: {
        id,
        name: name.trim(),
        command: command.trim() || undefined,
        url: url.trim() || undefined,
        tokenEnv: tokenEnv.trim() || undefined,
        args: args.trim() ? args.trim().split(/\s+/) : [],
        oauth: oauthAuthorizationUrl.trim() && oauthTokenUrl.trim() && oauthClientId.trim() ? { authorizationUrl: oauthAuthorizationUrl.trim(), tokenUrl: oauthTokenUrl.trim(), clientId: oauthClientId.trim(), tokenSecretKey: `mcp.oauth:${id}` } : undefined,
      },
    });
    setName(""); setCommand(""); setUrl(""); setArgs(""); setTokenEnv(""); setOauthAuthorizationUrl(""); setOauthTokenUrl(""); setOauthClientId("");
  };

  return (
    <>
      <SectionHeader eyebrow={t("mcp.eyebrow")} title={t("mcp.title")} />
      <div className="settings-connect-panel"><div className="settings-section-toolbar"><div><strong>{t("mcp.addService")}</strong><span>{t("mcp.addDescription")}</span></div><button className="settings-primary-action" type="button" disabled={!name.trim() || (!command.trim() && !url.trim()) || Boolean(command.trim() && url.trim())} onClick={connect}><Plus size={15} />{t("mcp.connect")}</button></div><div className="settings-form-grid settings-mcp-form"><label>{t("mcp.name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("mcp.namePlaceholder")} /></label><label>{t("mcp.command")}<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></label><label>{t("mcp.arguments")}<input value={args} onChange={(event) => setArgs(event.target.value)} placeholder={t("mcp.argumentsPlaceholder")} /></label><label>{t("mcp.httpUrl")}<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label><label>{t("mcp.tokenEnv")}<input value={tokenEnv} onChange={(event) => setTokenEnv(event.target.value)} placeholder={t("mcp.optional")} /></label></div><div className="settings-form-grid settings-mcp-form"><label>{t("mcp.oauthAuthorization")}<input value={oauthAuthorizationUrl} onChange={(event) => setOauthAuthorizationUrl(event.target.value)} placeholder={t("mcp.optional")} /></label><label>{t("mcp.oauthToken")}<input value={oauthTokenUrl} onChange={(event) => setOauthTokenUrl(event.target.value)} placeholder={t("mcp.optional")} /></label><label>{t("mcp.oauthClient")}<input value={oauthClientId} onChange={(event) => setOauthClientId(event.target.value)} placeholder={t("mcp.optional")} /></label></div></div>
      <div className="settings-section-toolbar settings-list-heading"><div><strong>{t("mcp.connected")}</strong><span>{servers.length} {t("mcp.count")}</span></div></div>
      <div className="settings-mcp-list">{servers.length === 0 ? <p className="settings-empty">{t("mcp.noConnections")}</p> : servers.map((server) => <div className="settings-mcp-card" key={server.id}><span className="settings-provider-icon"><Command size={16} /></span><div><strong>{server.name}</strong><small>{server.command ?? server.url}{server.connected ? ` · ${server.toolCount ?? 0} ${t("mcp.tools")}` : ` · ${t("mcp.disconnectedStatus")}`}</small></div>{server.oauth && <button type="button" className="settings-secondary-action" onClick={() => send({ type: "mcp.oauth.begin", requestId: crypto.randomUUID(), serverId: server.id })}>{t("mcp.authorize")}</button>}<em className={server.connected ? "is-connected" : "is-disconnected"}>{server.connected ? t("mcp.connectedStatus") : t("mcp.disconnectedStatus")}</em><button type="button" className="settings-danger-icon" aria-label={t("mcp.delete", { name: server.name })} onClick={async () => { if (!await confirmDestructiveAction(t("mcp.deleteConfirm", { name: server.name }))) return; const key = server.oauth?.tokenSecretKey ?? `mcp.oauth:${server.id}`; if (hasTauriBridge()) await invoke("secret_delete", { key }).catch(() => undefined); send({ type: "mcp.delete", requestId: crypto.randomUUID(), serverId: server.id }); }}><Trash2 size={14} /></button></div>)}</div>
    </>
  );
}

function SkillsSection() {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const skills = useStore((state) => state.skills);
  const workspaces = useStore((state) => state.workspaces);
  const currentWorkspaceId = useStore((state) => state.currentWorkspaceId);

  useEffect(() => {
    send({ type: "skills.list", requestId: crypto.randomUUID(), cwd: workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.path });
  }, [send, workspaces, currentWorkspaceId]);

  return (
    <>
      <SectionHeader eyebrow={t("skills.eyebrow")} title={t("skills.title")} />
      <div className="settings-section-toolbar settings-list-heading"><div><strong>{t("skills.installed")}</strong><span>{skills.length} {t("skills.count")}</span></div></div>
      <div className="settings-skill-list">{skills.length === 0 ? <p className="settings-empty">{t("skills.none")}</p> : skills.map((skill) => <button type="button" className="settings-skill-card" key={skill.id} onClick={() => openPath(skill.path).catch((error) => console.error("open skill failed", error))}><span className="settings-provider-icon"><WandSparkles size={16} /></span><div><strong>{skill.name}</strong><small>{skill.path}</small></div><ChevronRight size={15} /></button>)}</div>
    </>
  );
}

function SectionContent({ activeSection, theme, onToggleTheme }: { activeSection: SettingsSectionId; theme: Theme; onToggleTheme: () => void }) {
  switch (activeSection) {
    case "general": return <GeneralSection theme={theme} onToggleTheme={onToggleTheme} />;
    case "personalization": return <PersonalizationSection />;
    case "configuration": return <ConfigurationSection />;
    case "models": return <ModelsSection />;
    case "mcp": return <McpSection />;
    case "skills": return <SkillsSection />;
    case "subagents": return <SubagentsSection />;
  }
}

export function SettingsDialog({ open, onClose, theme, onToggleTheme }: { open: boolean; onClose: () => void; theme: Theme; onToggleTheme: () => void }) {
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
  });

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
              <button className="settings-reset-order" type="button" onClick={() => setSectionOrder(DEFAULT_ORDER)}><RotateCcw size={13} />{t("nav.resetOrder")}</button>
            </aside>
            <main className="settings-dialog-content" aria-live="polite">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={activeSection} className="settings-dialog-section" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -5 }} transition={{ duration: 0.14 }}>
                  <SectionContent activeSection={activeSection} theme={theme} onToggleTheme={onToggleTheme} />
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
