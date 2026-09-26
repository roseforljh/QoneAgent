import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Check, ChevronRight, Globe2, Mic2, Video, Volume2 } from "lucide-react";
import { useStore } from "../../store";
import { MODEL_CONFIG_CHANGE_EVENT, PROVIDERS_STORAGE_KEY } from "../../lib/model-picker-data";
import type { ProviderModel, ProviderProfile } from "../../lib/model-settings";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { ModelCard } from "./ModelCard";

export type CapabilityId = "webSearch" | "videoRecognition" | "stt" | "tts";
type CapabilitySpec = {
  id: CapabilityId;
  titleKey: "nav.webSearch" | "nav.videoRecognition" | "nav.stt" | "nav.tts";
  descriptionKey: "capabilitySettings.webSearchDescription" | "capabilitySettings.videoRecognitionDescription" | "capabilitySettings.sttDescription" | "capabilitySettings.ttsDescription";
  icon: ComponentType<{ size?: number }>;
};

const CAPABILITY_SPECS: CapabilitySpec[] = [
  { id: "webSearch", titleKey: "nav.webSearch", descriptionKey: "capabilitySettings.webSearchDescription", icon: Globe2 },
  { id: "videoRecognition", titleKey: "nav.videoRecognition", descriptionKey: "capabilitySettings.videoRecognitionDescription", icon: Video },
  { id: "stt", titleKey: "nav.stt", descriptionKey: "capabilitySettings.sttDescription", icon: Mic2 },
  { id: "tts", titleKey: "nav.tts", descriptionKey: "capabilitySettings.ttsDescription", icon: Volume2 },
];

const STORAGE_KEY = "qone-capability-routing";
type Routing = Partial<Record<CapabilityId, string>>;

function loadRouting(): Routing {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" ? value as Routing : {};
  } catch { return {}; }
}

function loadProviders(): ProviderProfile[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROVIDERS_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is ProviderProfile => Boolean(item && typeof item.id === "string" && Array.isArray(item.models))) : [];
  } catch { return []; }
}

function modelOptions(): { id: string; label: string; detail: string }[] {
  return loadProviders().flatMap((provider) => provider.models
    .map((model) => ({ id: `${provider.id}/${model.id}`, label: model.label || model.id, detail: provider.name })));
}

function CapabilityStatus({ id, selected, available }: { id: CapabilityId; selected?: string; available: number }) {
  const { t } = useLocale();
  if (id === "webSearch") return <small className="settings-capability-status is-ready">{t("capabilitySettings.ready")}</small>;
  if ((selected === "auto" || selected) && available > 0) return <small className="settings-capability-status is-ready">{t("capabilitySettings.configured")}</small>;
  return <small className="settings-capability-status">{t("capabilitySettings.needsModel")}</small>;
}

export function CapabilitySection({ id }: { id: CapabilityId }) {
  const { t } = useLocale();
  const spec = CAPABILITY_SPECS.find((item) => item.id === id)!;
  const Icon = spec.icon;
  const mcpServers = useStore((state) => state.mcpServers);
  const subagentConfig = useStore((state) => state.subagentConfig);
  const send = useStore((state) => state.send);
  const [routing, setRouting] = useState<Routing>(loadRouting);
  const [searchTab, setSearchTab] = useState<"model" | "mcp">("model");
  const [modelsVersion, setModelsVersion] = useState(0);
  const options = useMemo(() => modelOptions(), [modelsVersion]);
  const selected = routing[id] ?? "auto";
  const connectedSearch = mcpServers.filter((server) => server.connected && /search|exa|tavily|brave|perplexity/i.test(`${server.id} ${server.name}`));

  useEffect(() => {
    const refresh = () => setModelsVersion((value) => value + 1);
    window.addEventListener(MODEL_CONFIG_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(MODEL_CONFIG_CHANGE_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (subagentConfig.updatedAt > 0) setRouting(subagentConfig.routing);
  }, [subagentConfig.updatedAt]);

  const save = (value: string) => {
    const next = { ...routing, [id]: value };
    setRouting(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    void send({ type: "subagent.sync", requestId: crypto.randomUUID(), config: { profiles: subagentConfig.profiles, routing: next, updatedAt: Date.now() } });
  };

  return (
    <>
      <div className="settings-capability-heading">
        <span className="settings-provider-icon"><Icon size={18} /></span>
        <div>
          <SectionHeader title={t(spec.titleKey)} description={t(spec.descriptionKey)} />
          <CapabilityStatus id={id} selected={selected} available={options.length} />
        </div>
      </div>
      <div className="settings-section-toolbar"><div><strong>{t("capabilitySettings.routeTitle")}</strong><span>{t("capabilitySettings.routeDescription")}</span></div></div>
      {id === "webSearch" ? (
        <>
          <div className="settings-tabs" role="tablist" aria-label={t("capabilitySettings.routeTitle")}>
            <button type="button" role="tab" aria-selected={searchTab === "model"} className={cn(searchTab === "model" && "is-active")} onClick={() => setSearchTab("model")}>
              {t("capabilitySettings.modelTab")} <em>{options.length}</em>
            </button>
            <button type="button" role="tab" aria-selected={searchTab === "mcp"} className={cn(searchTab === "mcp" && "is-active")} onClick={() => setSearchTab("mcp")}>
              {t("capabilitySettings.mcpTab")} <em>{connectedSearch.length}</em>
            </button>
          </div>
          {searchTab === "model" ? (
            <div className="settings-model-grid">
              <ModelCard
                id="auto"
                label={t("capabilitySettings.autoSearch")}
                description={t("capabilitySettings.autoSearchDescription")}
                selected={selected === "auto"}
                onEdit={() => undefined}
                onSelect={() => save("auto")}
              />
              {options.map((option) => <ModelCard
                key={option.id}
                id={`model:${option.id}`}
                label={option.label}
                description={`${option.detail} · ${t("capabilitySettings.userSelectedModel")}`}
                selected={selected === `model:${option.id}`}
                onEdit={() => undefined}
                onSelect={() => save(`model:${option.id}`)}
              />)}
            </div>
          ) : connectedSearch.length > 0 ? (
            <div className="settings-provider-grid">
              {connectedSearch.map((server) => {
                const value = `mcp:${server.id}`;
                return <button type="button" key={server.id} className={cn("settings-provider-card", selected === value && "is-selected")} onClick={() => save(value)}>
                  <span className="settings-provider-icon"><Globe2 size={17} /></span>
                  <span><strong>{server.name}</strong><small>{t("capabilitySettings.connectedMcp")}</small></span>
                  {selected === value ? <Check size={16} /> : <ChevronRight size={16} />}
                </button>;
              })}
            </div>
          ) : (
            <div className="settings-empty-card"><Globe2 size={20} /><p>{t("capabilitySettings.noSearchMcp")}</p></div>
          )}
        </>
      ) : options.length > 0 ? (
        <div className="settings-model-grid">
          <ModelCard
            id="auto"
            label={t("capabilitySettings.autoModel")}
            description={t("capabilitySettings.autoModelDescription")}
            selected={selected === "auto"}
            onEdit={() => undefined}
            onSelect={() => save("auto")}
          />
          {options.map((option) => <ModelCard
            key={option.id}
            id={`model:${option.id}`}
            label={option.label}
            description={`${option.detail} · ${t("capabilitySettings.userSelectedModel")}`}
            selected={selected === `model:${option.id}`}
            onEdit={() => undefined}
            onSelect={() => save(`model:${option.id}`)}
          />)}
        </div>
      ) : (
        <div className="settings-empty-card"><Icon size={20} /><p>{t("capabilitySettings.noConfiguredModel")}</p></div>
      )}
    </>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return <div><h2 className="settings-capability-title">{title}</h2><p className="settings-capability-description">{description}</p></div>;
}
