import { localizeError } from "../../lib/error-localization";
import { detectImageModel, modelNamesEqual, supportsExtendedImageQuality, type ImageApiFormat, type ProviderApiType } from "@qone/protocol";
import { PROVIDERS_STORAGE_KEY, ACTIVE_PROVIDER_STORAGE_KEY, MODEL_CONFIG_CHANGE_EVENT, providerProfilesFromModelConfigs } from "../../lib/model-picker-data";
import { fetchProviderModelCatalog } from "../../lib/provider-model-catalog";
import { capabilities, defaultModelSettings, mergeFetchedModel, normalizeThinkingLevel, parseModelsResponse, thinkingLevelOptionsForApi, withProviderInputDefaults, type Capability, type ImageGenerationSettings, type ModelSettingField, type ModelSettings, type ProviderModel, type ProviderProfile, type ThinkingLevel } from "../../lib/model-settings";
import { useEffect, useRef, useState } from "react";
import { check } from "../../lib/desktop-bridge";
import { QoneSelect } from "../ui/Select";
import { Check, Globe2, LoaderCircle, Plus, Save, Trash2, X } from "lucide-react";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { useLocale, type LocalizedMessage } from "../../localization";
import { loadProviderProfiles, saveProviderProfiles, resolveModelSettings, providerApiLabelKeys } from "./provider-profile-store";
import { SectionHeader, SettingsPageHeader } from "./settings-chrome";
import { ModelCard } from "./ModelCard";
import { ProviderLogo } from "./ProviderLogo";

function ModelSourceSummary({ settings, isImageModel }: { settings: ModelSettings; isImageModel: boolean }) {
  const { t } = useLocale();
  const fields: Array<[ModelSettingField, string]> = [
    ...(!isImageModel ? [["maxOutput", t("model.maxOutput")], ["maxContext", t("model.maxContext")], ["thinking", t("model.thinking")]] as Array<[ModelSettingField, string]> : []),
    ["input", t("model.inputCapabilities")], ["output", t("model.outputCapabilities")],
  ];
  const sourceKeys = { provider: "model.source.provider", pi: "model.source.pi", "models.dev": "model.source.modelsDev", config: "model.source.manual", default: "model.source.default", unknown: "model.source.unknown", unconfirmed: "model.source.unconfirmed" } as const;
  return <div className="settings-model-sources" aria-label={t("model.source.title")}>{fields.map(([field, label]) => {
    const source = (field === "input" || field === "output") && !settings.metadataOverrides?.[field]
      && (!settings.metadataSources?.[field] || settings.metadataSources[field] === "default")
      ? "unconfirmed"
      : settings.metadataOverrides?.[field] ? "config" : settings.metadataSources?.[field] ?? "unknown";
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
  const visibleInput = settings.input;
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

export function ModelsSection() {
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
    <SettingsPageHeader><SectionHeader eyebrow="Models" title={t("model.title")} /><div className="settings-model-toolbar"><label>{t("model.currentProvider")}<QoneSelect value={provider?.id ?? ""} onChange={selectProvider} placeholder={t("model.selectProvider")} options={profiles.map((item) => ({ value: item.id, label: item.name }))} ariaLabel={t("model.currentProvider")} /></label><button type="button" className="settings-secondary-action" disabled={!provider} onClick={() => { setEditing(undefined); setEditorOpen(true); }}><Plus size={15} />{t("model.manualAdd")}</button></div></SettingsPageHeader>
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