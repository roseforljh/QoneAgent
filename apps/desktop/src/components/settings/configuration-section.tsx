import { localizeError } from "../../lib/error-localization";
import { type ProviderApiType } from "@qone/protocol";
import { PROVIDERS_STORAGE_KEY, ACTIVE_PROVIDER_STORAGE_KEY, MODEL_CONFIG_CHANGE_EVENT, providerProfilesFromModelConfigs } from "../../lib/model-picker-data";
import { fetchProviderModelCatalog } from "../../lib/provider-model-catalog";
import { defaultModelSettings, mergeFetchedModel, parseModelsResponse, withProviderInputDefaults, type ProviderModel, type ProviderProfile } from "../../lib/model-settings";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { check } from "../../lib/desktop-bridge";
import { invoke } from "../../lib/desktop-bridge";
import { hasDesktopBridge } from "../../store";
import { QoneSelect } from "../ui/Select";
import { Check, Globe2, LoaderCircle, Plus, Save, Trash2, X } from "lucide-react";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { confirmDestructiveAction, getConfirmationRequest } from "../../lib/confirm-action";
import { useLocale, type LocalizedMessage } from "../../localization";
import { loadProviderProfiles, saveProviderProfiles, providerId, normalizeBaseUrl, modelsEndpoint, resolveModelSettings, providerApiLabelKeys } from "./provider-profile-store";
import { SectionHeader, SettingsPageHeader, SettingsSelect } from "./settings-chrome";
import { ProviderLogo } from "./ProviderLogo";

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
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [status, setStatus] = useState<LocalizedMessage | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<ProviderModel[]>([]);
  const fetchSequence = useRef(0);
  useEffect(() => {
    fetchSequence.current++;
    if (!open) return;
    setName(initial?.name ?? ""); setApiType(initial?.apiType ?? "openai-compatible"); setBaseUrl(initial?.baseUrl ?? ""); setLogoUrl(initial?.logoUrl ?? ""); setApiKey(""); setModels(initial?.models ?? []); setStatus(null); setSyncOpen(false); setFetchedModels([]); setFetching(false); setSaving(false); setRemoving(false);
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
    if (saving || removing) return;
    if (!name.trim() || !baseUrl.trim()) { setStatus({ key: "provider.requiredFields" }); return; }
    setSaving(true);
    try {
      const profile: ProviderProfile = { id: initial?.id ?? providerId(name), name: name.trim(), apiType, baseUrl: normalizeBaseUrl(baseUrl), logoUrl: logoUrl.trim() || undefined, models, updatedAt: Date.now() };
      if (apiKey) {
        if (hasDesktopBridge()) await invoke("secret_set", { key: `model.apiKey:${profile.id}`, value: apiKey });
        useStore.getState().send({ type: "secret.set", requestId: crypto.randomUUID(), key: `model.apiKey:${profile.id}`, value: apiKey });
      }
      onSaved(profile); onClose();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!initial) return;
    if (saving || removing) return;
    setRemoving(true);
    try {
      if (!await confirmDestructiveAction(t("provider.deleteConfirm", { name: initial.name }))) return;
      if (hasDesktopBridge()) await invoke("secret_delete", { key: `model.apiKey:${initial.id}` }).catch(() => undefined);
      useStore.getState().send({ type: "secret.delete", requestId: crypto.randomUUID(), key: `model.apiKey:${initial.id}` });
      onDeleted(initial); onClose();
    } finally {
      setRemoving(false);
    }
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
        <div className="settings-subdialog-header"><div><span>{t("provider.configuration")}</span><h3>{initial ? t("provider.editConfiguration") : t("provider.newConfiguration")}</h3></div><button type="button" className="settings-dialog-close" disabled={saving || removing} onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div>
        <div className="settings-form-grid"><label>{t("provider.name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("provider.namePlaceholder")} /></label><label>{t("provider.apiType")}<QoneSelect value={apiType} onChange={(value) => setApiType(value as ProviderApiType)} options={Object.entries(providerApiLabelKeys).map(([value, key]) => ({ value, label: t(key) }))} ariaLabel={t("provider.apiType")} /></label><label className="is-wide">{t("provider.baseUrl")}<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={t("provider.baseUrlPlaceholder")} /><small className="settings-url-preview">{t("provider.urlPreview", { url: preview || t("provider.waitingForInput") })}</small></label><label className="is-wide">{t("provider.logoUrl")}<input type="url" value={logoUrl} onChange={(event) => setLogoUrl(event.target.value)} placeholder={t("provider.logoUrlPlaceholder")} /><small className="settings-url-preview">{t("provider.logoUrlHint")}</small></label><label className="is-wide">{t("provider.apiKey")}<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t("provider.apiKeyPlaceholder")} /></label></div>
        <div className="settings-provider-actions"><button type="button" className="settings-secondary-action" disabled={fetching} onClick={fetchModels}>{fetching ? <><LoaderCircle size={15} className="settings-spin" />{t("provider.fetching")}</> : <><Globe2 size={15} />{t("provider.fetchModels")}</>}</button><span>{models.length ? t("provider.configuredModels", { count: models.length }) : t("provider.noModels")}</span></div>
        {status && <p className="settings-inline-status" role="status">{t(status.key, status.values)}</p>}
        <div className="settings-subdialog-footer">{initial && <button type="button" className="settings-danger-action" disabled={saving || removing} onClick={() => void remove()}>{removing ? <LoaderCircle size={15} className="settings-spin" /> : <Trash2 size={15} />}{t("provider.delete")}</button>}<button type="button" className="settings-secondary-action" disabled={saving || removing} onClick={onClose}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={saving || removing} onClick={() => void save()}>{saving ? <LoaderCircle size={15} className="settings-spin" /> : <Save size={15} />}{t("provider.saveConfiguration")}</button></div>
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

export function ConfigurationSection() {
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
    <SettingsPageHeader><SectionHeader eyebrow={t("nav.configuration")} title={t("nav.configuration")} /><div className="settings-section-toolbar"><div><strong>{t("provider.configuration")}</strong><span>{profiles.length ? t("provider.configuredProviders", { count: profiles.length }) : t("provider.noProviders")}</span></div><button type="button" className="settings-primary-action" onClick={() => { setEditing(undefined); setDialogOpen(true); }}><Plus size={15} />{t("provider.newProvider")}</button></div></SettingsPageHeader>
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