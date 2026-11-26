import { useConversationStore } from "../../lib/conversation-context";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { CodexIcon } from "../ui/CodexIcon";
import searchIcon from "../../assets/codex-icons/magnifying-glass-lg-light-16.svg";
import { Popover } from "radix-ui";
import type { ProviderApiType } from "@qone/protocol";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { ACTIVE_PROVIDER_STORAGE_KEY, PROVIDERS_STORAGE_KEY, MODEL_CONFIG_CHANGE_EVENT, filterPickerModels, readCurrentProvider, readPickerProviders, getPickerModels, providerProfilesFromModelConfigs, type PickerModel } from "../../lib/model-picker-data";
import { defaultThinkingForModel, normalizeThinkingLevel, thinkingLevelOptionsForApi, type ThinkingLevel } from "../../lib/model-settings";
import { ModelLogo } from "./model-logo";
import { CodexArrowLeftIcon } from "./execution-icons";
import { ProviderLogo } from "../settings/ProviderLogo";
import { ThinkingWave } from "./run-options-popover";
import { Skeleton } from "../ui/skeleton";
import "./model-picker.css";

/** Drives the picker from the caller instead of the conversation, e.g. a scheduled task's own model. */
export interface ModelPickerControl {
  modelId?: string;
  thinkingByModel?: Record<string, ThinkingLevel>;
  setModel(id: string): void;
  setThinking(id: string, level: ThinkingLevel): void;
  /** 为空时跟随默认模型，重置按钮恢复此状态。 */
  defaultLabel?: string;
}

export const ModelPicker: FC<{ control?: ModelPickerControl }> = ({ control }) => {
  const modelConfigs = useConversationStore((s) => s.modelConfigs);
  const modelConfigsLoaded = useConversationStore((s) => s.modelConfigsLoaded);
  const sessionModelId = useConversationStore((s) => s.selectedModelId);
  const setSessionModel = useConversationStore((s) => s.setSelectedModel);
  const sessionRunOptions = useConversationStore((s) => s.currentSessionId ? s.runOptionsBySession[s.currentSessionId] : s.draftRunOptions);
  const setSessionThinking = useConversationStore((s) => s.setRunThinking);
  const defaultLabel = control?.defaultLabel;
  const followsDefault = defaultLabel !== undefined && !control?.modelId;
  // 继承只影响存储；选择器照常展示实际生效的模型。
  const selectedModelId = followsDefault || !control ? sessionModelId : control.modelId;
  const setSelectedModel = control ? control.setModel : setSessionModel;
  const runOptions = control ? { thinkingByModel: control.thinkingByModel } : sessionRunOptions;
  const setThinking = control ? control.setThinking : setSessionThinking;
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [dialogBoundary, setDialogBoundary] = useState<Element | null>(null);
  const [view, setView] = useState<"simple" | "advanced">("simple");
  const [list, setList] = useState<"models" | "providers">("models");
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [openTriggerWidth, setOpenTriggerWidth] = useState<number>();
  const [providerData, setProviderData] = useState(() => ({ all: readPickerProviders(), current: readCurrentProvider() }));
  const [panelHeights, setPanelHeights] = useState<{ simple: number; advanced: number }>();
  const simpleRef = useRef<HTMLDivElement>(null);
  const advancedRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openLabelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const refresh = () => setProviderData({ all: readPickerProviders(), current: readCurrentProvider() });
    window.addEventListener(MODEL_CONFIG_CHANGE_EVENT, refresh);
    const onStorage = (event: StorageEvent) => {
      if (!event.key || [ACTIVE_PROVIDER_STORAGE_KEY, PROVIDERS_STORAGE_KEY].includes(event.key)) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MODEL_CONFIG_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const providers = useMemo(() => providerData.all.length ? providerData.all : providerProfilesFromModelConfigs(modelConfigs), [providerData.all, modelConfigs]);
  // Each conversation keeps its own model, so its provider follows that model, not the global default.
  const sessionProviderId = modelConfigs.find((config) => config.id === selectedModelId)?.provider;
  const provider = providers.find((item) => item.id === sessionProviderId) ?? providerData.current ?? providers[0];
  const models = useMemo(() => getPickerModels(provider, modelConfigs), [provider, modelConfigs]);
  const providerChoices = useMemo(() => providers
    .map((item) => ({ provider: item, models: getPickerModels(item, modelConfigs) }))
    .filter((choice) => choice.models.length > 0), [providers, modelConfigs]);
  const visibleModels = useMemo(() => filterPickerModels(models, search), [models, search]);
  const selected = models.find((model) => model.id === selectedModelId);
  const activeModel = selected ?? models[0];
  const activeConfig = modelConfigs.find((model) => model.id === activeModel?.id);
  const apiType = (activeConfig?.config.apiType as ProviderApiType | undefined) ?? "openai-compatible";
  const thinkingOptions = thinkingLevelOptionsForApi(apiType);
  const storedThinking = activeModel?.id ? runOptions?.thinkingByModel?.[activeModel.id] : undefined;
  const thinking = storedThinking === undefined
    ? defaultThinkingForModel(activeConfig?.config, apiType)
    : normalizeThinkingLevel(storedThinking, apiType);
  const thinkingIndex = Math.max(0, thinkingOptions.findIndex((option) => option.value === thinking));
  const displayLabel = activeModel?.label ?? t("chat.configureModel");
  const thinkingLabel = activeModel ? t(thinkingOptions[thinkingIndex]?.labelKey ?? "") : "";
  const canSetEffort = Boolean(activeModel && thinkingOptions.length >= 2);
  const openLabel = t(canSetEffort ? "model.selectEffort" : "chat.selectModel");

  useEffect(() => {
    // Before the runtime's model list arrives, "not found" only means "not loaded yet".
    if (modelConfigsLoaded && models.length > 0 && !selected && !followsDefault) {
      setSelectedModel(defaultLabel === undefined ? models[0].id : "");
    }
  }, [modelConfigsLoaded, models, selected, followsDefault, defaultLabel, setSelectedModel]);

  const measurePanels = useCallback(() => {
    const simple = simpleRef.current;
    const advanced = advancedRef.current;
    if (!simple || !advanced) return;
    const simpleHeight = simple.offsetHeight;
    const advancedHeight = advanced.offsetHeight;
    if (simpleHeight <= 0 || advancedHeight <= 0) return;
    setPanelHeights((previous) => previous?.simple === simpleHeight && previous.advanced === advancedHeight
      ? previous : { simple: simpleHeight, advanced: advancedHeight });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const simple = simpleRef.current;
    const advanced = advancedRef.current;
    if (!simple || !advanced) return;
    measurePanels();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measurePanels);
    observer.observe(simple);
    observer.observe(advanced);
    return () => observer.disconnect();
  }, [open, view, list, visibleModels.length, searchOpen, measurePanels]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      measurePanels();
      if (view === "simple") simpleRef.current?.querySelector<HTMLButtonElement>(".q-model-picker-model-button")?.focus();
      else (advancedRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? advancedRef.current?.querySelector<HTMLButtonElement>('[role="option"]') ?? advancedRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, view, measurePanels]);

  const showModels = () => {
    setList("models");
    setView("advanced");
    requestAnimationFrame(() => (advancedRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? advancedRef.current?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus());
  };
  const showProviders = () => {
    setList("providers");
    setView("advanced");
    requestAnimationFrame(() => (advancedRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? advancedRef.current?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus());
  };
  // Keep the same model when the new provider offers it; otherwise start from its first model.
  const chooseProvider = (choices: PickerModel[]) => {
    const next = choices.find((model) => model.modelName === activeModel?.modelName) ?? choices[0];
    if (next) setSelectedModel(next.id);
  };
  const preparePicker = () => {
    setProviderData({ all: readPickerProviders(), current: readCurrentProvider() });
    setList("models");
    // 即使当前没有推理档位，也保留已配置服务商的切换入口。
    setView(canSetEffort || providerChoices.length > 0 ? "simple" : "advanced");
    setSearch("");
    setSearchOpen(false);
    setPanelHeights(undefined);
  };

  if (!modelConfigsLoaded) return <Skeleton aria-busy="true" className="h-4 w-28 rounded-md" />;

  // 对话框里的浮层在父弹窗范围内避让，并接管焦点，避免被父弹窗拦截点击。
  return <Popover.Root modal={Boolean(dialogBoundary)} open={open} onOpenChange={(nextOpen) => {
    if (nextOpen) {
      setDialogBoundary(triggerRef.current?.closest('[role="dialog"]') ?? null);
      setOpenTriggerWidth(Math.max(
        triggerRef.current?.offsetWidth ?? 0,
        openLabelRef.current?.offsetWidth ?? 0,
      ));
      preparePicker();
    } else setOpenTriggerWidth(undefined);
    setOpen(nextOpen);
  }}>
    <Popover.Trigger asChild>
      <button ref={triggerRef} type="button" aria-label={open ? openLabel : t("chat.selectModel")} title={open ? openLabel : followsDefault ? `${defaultLabel} · ${displayLabel}` : displayLabel} aria-expanded={open} data-selected={Boolean(selected)} data-state={open ? "open" : "closed"} className="q-model-picker-trigger" style={!open || openTriggerWidth === undefined ? undefined : { width: openTriggerWidth }}>
        <span ref={openLabelRef} className="q-model-picker-trigger-measure" aria-hidden="true"><span>{openLabel}</span><ChevronDownIcon size={14} /></span>
        {open ? <span className="q-model-picker-trigger-placeholder">{openLabel}</span> : <>
          <ModelLogo modelName={activeModel?.modelName ?? ""} label={activeModel?.label} size={16} />
          <span className="q-model-picker-trigger-labels">
            <span className="q-model-picker-trigger-name">{displayLabel}</span>
            {activeModel && <span className="q-model-picker-effort-label">{thinkingLabel}</span>}
          </span>
        </>}
        <ChevronDownIcon size={14} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content side="top" align="center" sideOffset={8} collisionBoundary={dialogBoundary} collisionPadding={12} className="q-model-picker-card"
        onOpenAutoFocus={(event) => { event.preventDefault(); measurePanels(); }}
        onKeyDown={(event) => {
          if (view !== "advanced" || (event.target as HTMLElement).closest('input, [role="slider"]')) return;
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const options = Array.from(advancedRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
          if (!options.length) return;
          event.preventDefault();
          const index = options.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
            : index < 0 ? (event.key === "ArrowUp" ? options.length - 1 : 0)
              : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
          options[next]?.focus();
        }}>
        <div className="q-model-picker-viewport" data-measured={Boolean(panelHeights)} style={panelHeights === undefined ? undefined : { height: panelHeights[view] }}>
          <div ref={simpleRef} className="q-model-picker-simple" aria-hidden={view !== "simple"} inert={view !== "simple"} data-active={view === "simple"}>
            <div className="q-model-picker-card-head">
              <button type="button" className="q-model-picker-provider-button" onClick={showProviders} aria-label={`${t("model.switchProvider")}：${provider?.name ?? ""}`} title={provider ? `${t("model.switchProvider")}：${provider.name}` : t("model.switchProvider")}>
                <ModelLogo modelName={activeModel?.modelName ?? ""} label={activeModel?.label} size={17} />
              </button>
              <button type="button" className="q-model-picker-model-button" onClick={showModels} aria-label={`${t("chat.selectModel")}：${displayLabel}`}>
                <span className="q-model-picker-model-content">
                  <span className="q-model-picker-model-label"><span className="q-model-picker-model-name">{displayLabel}</span></span>
                  <span className="q-model-picker-thinking-label">{thinkingLabel || t("model.thinking")}</span>
                  <ChevronRightIcon size={13} aria-hidden="true" />
                </span>
              </button>
              <Popover.Close asChild>
                <button type="button" className="q-model-picker-reset" disabled={defaultLabel !== undefined ? followsDefault : !activeModel || activeModel.id === models[0]?.id} onClick={() => defaultLabel !== undefined ? setSelectedModel("") : models[0] && setSelectedModel(models[0].id)} aria-label={defaultLabel ?? t("model.resetToDefault")} title={defaultLabel ?? t("model.resetToDefault")}><RotateCcwIcon size={16} /></button>
              </Popover.Close>
            </div>
            {canSetEffort && <ThinkingWave options={thinkingOptions} index={thinkingIndex} disabled={!activeModel} showLabel={false} onSelect={(index) => {
              const level = thinkingOptions[index];
              if (!activeModel || !level) return;
              // 自定义推理强度时，成员需同时保存适用该档位的模型。
              if (followsDefault) setSelectedModel(activeModel.id);
              setThinking(activeModel.id, level.value as ThinkingLevel);
            }} />}
          </div>
          <div ref={advancedRef} className="q-model-picker-advanced" aria-hidden={view !== "advanced"} inert={view !== "advanced"} data-active={view === "advanced"}>
            {list === "providers" ? <>
              <div className="q-model-picker-list-head"><button type="button" className="q-model-picker-back" onClick={() => setView("simple")}><CodexArrowLeftIcon size={14} />{t("model.back")}</button></div>
              <div className="q-model-picker-list" role="listbox" aria-label={t("model.selectProvider")}>
                {providerChoices.map((choice) => {
                  const current = choice.provider.id === provider?.id;
                  return <Popover.Close key={choice.provider.id} asChild>
                    <button type="button" role="option" aria-selected={current} className={cn("q-model-picker-option", current && "is-selected")} onClick={() => chooseProvider(choice.models)}>
                      <ProviderLogo name={choice.provider.name} baseUrl={choice.provider.baseUrl ?? ""} logoUrl={choice.provider.logoUrl} />
                      <span className="q-model-picker-option-name">{choice.provider.name}</span>
                      {current && <CheckIcon size={16} aria-hidden="true" />}
                    </button>
                  </Popover.Close>;
                })}
                {providerChoices.length === 0 && <p className="q-model-picker-empty">{t("chat.noModelsConfigured")}</p>}
              </div>
            </> : <>
            <div className="q-model-picker-list-head">
              {searchOpen ? <label className="q-model-picker-search">
                <CodexIcon src={searchIcon} className="size-3.5" />
                <input ref={searchRef} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("chat.searchModels")} aria-label={t("chat.searchModels")} />
                <button type="button" aria-label={t("chat.clearModelSearch")} onClick={() => { setSearch(""); setSearchOpen(false); }}><XIcon size={14} /></button>
              </label> : <><span>{t("chat.selectModel")}</span><button type="button" aria-label={t("chat.searchModels")} onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }}><CodexIcon src={searchIcon} className="size-[15px]" /></button></>}
            </div>
            <div className="q-model-picker-list" role="listbox" aria-label={t("chat.modelsInProvider", { provider: provider?.name || t("chat.modelProvider") })}>
              {visibleModels.map((model) => <Popover.Close key={model.id} asChild>
                <button type="button" role="option" aria-selected={model.id === activeModel?.id} className={cn("q-model-picker-option", model.id === activeModel?.id && "is-selected")} onClick={() => setSelectedModel(model.id)}>
                  <span className="q-model-picker-option-name">{model.label}</span>
                  {model.id === activeModel?.id && <CheckIcon size={16} aria-hidden="true" />}
                </button>
              </Popover.Close>)}
              {models.length === 0 && <p className="q-model-picker-empty">{t("chat.noModelsConfigured")}</p>}
              {models.length > 0 && visibleModels.length === 0 && <p className="q-model-picker-empty">{t("chat.noModelsFound")}</p>}
            </div>
            {models.length === 0 && <Popover.Close asChild>
              <button type="button" className="q-model-picker-settings" onClick={() => window.dispatchEvent(new Event("qone-open-settings"))}>{t("chat.openSettings")}</button>
            </Popover.Close>}
            </>}
          </div>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
};
