import { subagentProfileCopy, subagentProfileNameForSave } from "../../lib/subagent-profile-copy";
import { ECC_BUILTIN_SUBAGENTS, isBuiltinSubagentId, isEccBuiltinSubagentId, REMOVED_BUILTIN_SUBAGENT_IDS, type BuiltinSubagentCatalogEntry } from "@qone/protocol";
import { Switch } from "@base-ui/react/switch";
import { type ProviderProfile } from "../../lib/model-settings";
import { useEffect, useState } from "react";
import { QoneSelect } from "../ui/Select";
import { BotMessageSquare, ArrowLeft, ChevronRight, Library, Plus, Save, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { useLocale, type LocalizedMessage } from "../../localization";
import { normalizeSubagentLogos, SubagentLogo } from "./subagent-logo";
import { SubagentTemporarySettings } from "./SubagentTemporarySettings";
import { SubagentRuntimeSettings } from "./SubagentRuntimeSettings";
import { BuiltinSubagentSettings } from "./BuiltinSubagentDialog";
import { loadProviderProfiles } from "./provider-profile-store";
import { SectionHeader, SettingsPageHeader } from "./settings-chrome";

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

function withoutLegacySubagentControls(profile: SubagentProfile): SubagentProfile {
  const next = { ...profile };
  delete next.tools;
  delete next.permissionMode;
  return next;
}

function loadSubagents(): SubagentProfile[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SUBAGENTS_STORAGE_KEY) ?? "[]") as SubagentProfile[];
    if (!Array.isArray(saved)) return [];
    return normalizeSubagentLogos(dedupeSubagents(saved)).map(withoutLegacySubagentControls);
  } catch {
    return [];
  }
}

function SubagentEditorDialog({ open, initial, modelOptions, mainModelId, onClose, onSaved }: { open: boolean; initial?: SubagentProfile; modelOptions: { id: string; label: string }[]; mainModelId?: string; onClose: () => void; onSaved: (profile: SubagentProfile) => void }) {
  const { t, locale } = useLocale();
  const copy = initial ? subagentProfileCopy(initial, locale) : undefined;
  const [name, setName] = useState(copy?.name ?? "");
  const [instructions, setInstructions] = useState(copy?.instructions ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? "");
  const driverModelOptions = [{ value: "", label: t("subagent.followMainModel"), description: t("subagent.followMainModelDescription") }, ...modelOptions.map((model) => ({ value: model.id, label: model.label }))];
  const hasDriverModel = modelId ? modelOptions.some((model) => model.id === modelId) : Boolean(mainModelId);
  useEffect(() => {
    if (!open) return;
    setName(copy?.name ?? ""); setInstructions(copy?.instructions ?? ""); setModelId(initial?.modelId ?? "");
  }, [open, initial?.id]);
  const save = () => {
    if (!name.trim() || !instructions.trim()) return;
    const id = initial?.id ?? `subagent-${Date.now()}`;
    const savedName = subagentProfileNameForSave(initial, name.trim(), locale);
    onSaved({ id, name: savedName, instructions: instructions.trim(), nameKey: name.trim() === copy?.name ? initial?.nameKey : undefined, instructionsKey: instructions.trim() === copy?.instructions ? initial?.instructionsKey : undefined, modelId, logo: initial?.logo, enabled: initial ? initial.enabled && hasDriverModel : hasDriverModel, updatedAt: Date.now() });
    onClose();
  };
  if (!open) return null;
  return <div className="settings-subdialog-layer"><div className="settings-subdialog model-editor-dialog" role="dialog" aria-modal="true" aria-label={t("subagent.create")}><div className="settings-subdialog-header"><div><span>{t("nav.subagents")}</span><h3>{initial ? t("subagent.edit") : t("subagent.create")}</h3></div><button type="button" className="settings-dialog-close" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div><div className="settings-form-grid"><label className="is-wide">{t("subagent.name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("subagent.namePlaceholder")} /></label><label className="is-wide">{t("subagent.driverModel")}<QoneSelect value={modelId} onChange={setModelId} placeholder={t("subagent.selectModel")} options={driverModelOptions} ariaLabel={t("subagent.driverModel")} /></label><label className="is-wide">{t("subagent.systemPrompt")}<textarea className="settings-subagent-prompt" rows={7} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={t("subagent.promptPlaceholder")} /></label></div><div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" onClick={onClose}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={!name.trim() || !instructions.trim()} onClick={save}><Save size={15} />{t("subagent.save")}</button></div></div></div>;
}

export function SubagentsSection() {
  const { t, locale } = useLocale();
  const modelConfigs = useStore((state) => state.modelConfigs);
  const runtimeSubagentConfig = useStore((state) => state.subagentConfig);
  const selectedModelId = useStore((state) => state.selectedModelId);
  const send = useStore((state) => state.send);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(loadProviderProfiles);
  const [agents, setAgents] = useState<SubagentProfile[]>(loadSubagents);
  const [runtime, setRuntime] = useState(runtimeSubagentConfig.runtime);
  const [editing, setEditing] = useState<SubagentProfile | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [subagentError, setSubagentError] = useState<LocalizedMessage | null>(null);
  const [view, setView] = useState<"overview" | "runtime" | "temporary" | "builtins">("overview");
  const modelOptions = Array.from(new Map([
    ...modelConfigs.map((model) => [`${model.provider}/${model.model}`, { id: model.id, label: `${model.provider} / ${model.model}` }] as const),
    ...profiles.flatMap((provider) => provider.models.map((model) => [`${provider.id}/${model.id}`, { id: `${provider.id}/${model.id}`, label: `${provider.name} / ${model.label}` }] as const)),
  ]).values());
  useEffect(() => {
    if (runtimeSubagentConfig.updatedAt <= 0) return;
    const normalized = normalizeSubagentLogos(dedupeSubagents(runtimeSubagentConfig.profiles)).map(withoutLegacySubagentControls);
    setAgents(normalized);
    setRuntime(runtimeSubagentConfig.runtime);
    window.localStorage.setItem(SUBAGENTS_STORAGE_KEY, JSON.stringify(normalized));
  }, [runtimeSubagentConfig.updatedAt]);
  const saveAgents = (next: SubagentProfile[]) => {
    setSubagentError(null);
    const normalized = normalizeSubagentLogos(dedupeSubagents(next)).map(withoutLegacySubagentControls);
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
  const hasUsableDriverModel = (agent: SubagentProfile) => agent.modelId ? modelOptions.some((model) => model.id === agent.modelId) : Boolean(selectedModelId);
  const toggleBuiltin = (entry: BuiltinSubagentCatalogEntry, enabled: boolean) => {
    const existing = agents.find((agent) => agent.id === entry.id);
    if (enabled) {
      if (existing && !hasUsableDriverModel(existing) || !existing && !selectedModelId) {
        setSubagentError({ key: "subagent.driverModelRequired" });
        return;
      }
    }
    setSubagentError(null);
    if (existing) {
      saveAgents(agents.map((agent) => agent.id === entry.id ? { ...agent, enabled, updatedAt: Date.now() } : agent));
      return;
    }
    saveAgents([...agents, { id: entry.id, name: entry.name, instructions: entry.instructions, modelId: "", enabled, updatedAt: Date.now() }]);
  };
  const saveRuntime = (next: typeof runtime) => {
    setRuntime(next);
    const config = { profiles: dedupeSubagents(agents).map(withoutLegacySubagentControls), routing: runtimeSubagentConfig.routing, runtime: next, updatedAt: Date.now() };
    void send({ type: "subagent.sync", requestId: crypto.randomUUID(), config });
  };
  const deleteAgent = async (agent: SubagentProfile) => { if (await confirmDestructiveAction(t("subagent.deleteConfirm", { name: subagentProfileCopy(agent, locale).name }))) saveAgents(agents.filter((item) => item.id !== agent.id)); };
  const setAgentEnabled = (agent: SubagentProfile, enabled: boolean) => {
    if (enabled && !hasUsableDriverModel(agent)) {
      setSubagentError({ key: "subagent.driverModelRequired" });
      return;
    }
    saveAgents(agents.map((item) => item.id === agent.id ? { ...item, enabled, updatedAt: Date.now() } : item));
  };
  const openBuiltinEditor = (entry: BuiltinSubagentCatalogEntry, profile?: SubagentProfile) => {
    setEditing(profile ?? { id: entry.id, name: entry.name, instructions: entry.instructions, modelId: "", enabled: false, updatedAt: Date.now() });
    setDialogOpen(true);
  };
  const temporaryModelLabel = runtime.temporaryModelId
    ? modelOptions.find((model) => model.id === runtime.temporaryModelId)?.label ?? runtime.temporaryModelId
    : t("subagent.followMainModel");
  if (view === "temporary") return <>
    <SettingsPageHeader>
      <button type="button" className="settings-subagent-back" onClick={() => setView("overview")}>
        <ArrowLeft size={14} aria-hidden="true" />
        {t("subagent.temporaryBack")}
      </button>
      <SectionHeader eyebrow={t("subagent.eyebrow")} title={t("subagent.temporaryTitle")}>
        {t("subagent.temporaryDescription")}
      </SectionHeader>
    </SettingsPageHeader>
    <SubagentTemporarySettings value={runtime.temporaryModelId} modelOptions={modelOptions} onChange={(temporaryModelId) => saveRuntime({ ...runtime, temporaryModelId })} />
  </>;
  if (view === "runtime") return <>
    <SettingsPageHeader>
      <button type="button" className="settings-subagent-back" onClick={() => setView("overview")}>
        <ArrowLeft size={14} aria-hidden="true" />
        {t("subagent.runtimeBack")}
      </button>
      <SectionHeader eyebrow={t("subagent.eyebrow")} title={t("subagent.runtimeTitle")}>
        {t("subagent.runtimeDescription")}
      </SectionHeader>
    </SettingsPageHeader>
    <SubagentRuntimeSettings value={runtime} onChange={saveRuntime} />
  </>;
  if (view === "builtins") return <>
    {subagentError && <p className="settings-inline-status" role="alert">{t(subagentError.key, subagentError.values)}</p>}
    <BuiltinSubagentSettings profiles={agents.filter((agent) => isEccBuiltinSubagentId(agent.id))} onToggle={toggleBuiltin} onEdit={openBuiltinEditor} onBack={() => setView("overview")} backLabel={t("subagent.builtInBack")} />
    <SubagentEditorDialog open={dialogOpen} initial={editing} modelOptions={modelOptions} mainModelId={selectedModelId} onClose={() => setDialogOpen(false)} onSaved={saveAgent} />
  </>;
  return <>
    <SettingsPageHeader><SectionHeader eyebrow={t("subagent.eyebrow")} title={t("subagent.title")} /><div className="settings-section-toolbar"><div><strong>{t("subagent.mine")}</strong><span>{t("subagent.count", { count: agents.length })}</span></div><button type="button" className="settings-primary-action" onClick={() => { setEditing(undefined); setDialogOpen(true); }}><Plus size={15} />{t("subagent.new")}</button></div></SettingsPageHeader>
    <div className="settings-subagent-list">{agents.map((agent) => { const builtin = isBuiltinSubagentId(agent.id); const display = subagentProfileCopy(agent, locale); const openEditor = () => { setEditing(agent); setDialogOpen(true); }; return <div className={cn("settings-subagent-card", "is-actionable", !agent.enabled && "is-disabled")} key={agent.id} role="button" tabIndex={0} aria-label={`${display.name} · ${t("common.edit")}`} onClick={openEditor} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openEditor(); } }}><div className="settings-subagent-card-main"><SubagentLogo logo={agent.logo} name={display.name} size={36} /><div><strong>{display.name}</strong><small>{modelOptions.find((model) => model.id === agent.modelId)?.label ?? (agent.modelId ? agent.modelId : t("subagent.followMainModel"))} · {builtin ? t("subagent.builtIn") : agent.enabled ? t("subagent.enabled") : t("subagent.disabled")}</small></div></div><div className="settings-subagent-actions"><Switch.Root checked={agent.enabled} aria-label={t(agent.enabled ? "subagent.disable" : "subagent.enable")} className={cn("settings-switch", agent.enabled && "is-on")} onClick={(event) => event.stopPropagation()} onCheckedChange={(checked) => setAgentEnabled(agent, checked)}><Switch.Thumb /></Switch.Root>{!builtin && <button type="button" aria-label={t("subagent.delete", { name: agent.name })} onClick={(event) => { event.stopPropagation(); void deleteAgent(agent); }}><Trash2 size={14} /></button>}</div></div>; })}{agents.length === 0 && <div className="settings-empty-card"><BotMessageSquare size={22} /><p>{t("subagent.noAgents")}</p></div>}</div>
    <button type="button" className="settings-subagent-settings-card" onClick={() => setView("builtins")}>
      <span className="settings-subagent-settings-icon"><Library size={17} aria-hidden="true" /></span>
      <span className="settings-subagent-settings-copy"><strong>{t("subagent.builtInCatalog")}</strong><small>{t("subagent.builtInCount", { count: ECC_BUILTIN_SUBAGENTS.length })}</small></span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
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
    <SubagentEditorDialog open={dialogOpen} initial={editing} modelOptions={modelOptions} mainModelId={selectedModelId} onClose={() => setDialogOpen(false)} onSaved={saveAgent} />
  </>;
}