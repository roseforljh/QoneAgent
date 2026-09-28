import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, RotateCcwIcon, SearchIcon, XIcon } from "lucide-react";
import { Popover } from "radix-ui";
import type { ProviderApiType } from "@qone/protocol";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import { ACTIVE_PROVIDER_STORAGE_KEY, PROVIDERS_STORAGE_KEY, MODEL_CONFIG_CHANGE_EVENT, filterPickerModels, readCurrentProvider, getPickerModels } from "../../lib/model-picker-data";
import { normalizeThinkingLevel, thinkingLevelOptionsForApi, type ThinkingLevel } from "../../lib/model-settings";
import { ModelLogo } from "./model-logo";
import { ThinkingWave } from "./run-options-popover";
import "./model-picker.css";

export const ModelPicker: FC = () => {
  const modelConfigs = useStore((s) => s.modelConfigs);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const setSelectedModel = useStore((s) => s.setSelectedModel);
  const runOptions = useStore((s) => s.currentSessionId ? s.runOptionsBySession[s.currentSessionId] : s.draftRunOptions);
  const setThinking = useStore((s) => s.setRunThinking);
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"simple" | "advanced">("simple");
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [openTriggerWidth, setOpenTriggerWidth] = useState<number>();
  const [providerSnapshot, setProviderSnapshot] = useState(() => readCurrentProvider());
  const [panelHeights, setPanelHeights] = useState<{ simple: number; advanced: number }>();
  const simpleRef = useRef<HTMLDivElement>(null);
  const advancedRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openLabelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const refresh = () => setProviderSnapshot(readCurrentProvider());
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

  const models = useMemo(() => getPickerModels(providerSnapshot, modelConfigs), [providerSnapshot, modelConfigs]);
  const visibleModels = useMemo(() => filterPickerModels(models, search), [models, search]);
  const selected = models.find((model) => model.id === selectedModelId);
  const activeModel = selected ?? models[0];
  const activeConfig = modelConfigs.find((model) => model.id === activeModel?.id);
  const apiType = (activeConfig?.config.apiType as ProviderApiType | undefined) ?? "openai-compatible";
  const thinkingOptions = thinkingLevelOptionsForApi(apiType);
  const thinking = normalizeThinkingLevel((activeModel?.id && runOptions?.thinkingByModel?.[activeModel.id]) || activeConfig?.config.thinking, apiType);
  const thinkingIndex = Math.max(0, thinkingOptions.findIndex((option) => option.value === thinking));
  const displayLabel = activeModel?.label ?? t("chat.configureModel");
  const thinkingLabel = activeModel ? t(thinkingOptions[thinkingIndex]?.labelKey ?? "") : "";
  const openLabel = t(activeModel && thinkingOptions.length >= 2 ? "model.selectEffort" : "chat.selectModel");

  useEffect(() => {
    if (models.length > 0 && !selected) setSelectedModel(models[0].id);
  }, [models, selected, setSelectedModel]);

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
  }, [open, view, visibleModels.length, searchOpen, measurePanels]);

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
    setView("advanced");
    requestAnimationFrame(() => (advancedRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? advancedRef.current?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus());
  };
  const chooseModel = (id: string) => {
    const nextApiType = (modelConfigs.find((model) => model.id === id)?.config.apiType as ProviderApiType | undefined) ?? "openai-compatible";
    setSelectedModel(id);
    if (thinkingLevelOptionsForApi(nextApiType).length < 2) return;
    setView("simple");
    requestAnimationFrame(() => simpleRef.current?.querySelector<HTMLButtonElement>(".q-model-picker-model-button")?.focus());
  };
  const preparePicker = () => {
    setProviderSnapshot(readCurrentProvider());
    setView(activeModel && thinkingOptions.length >= 2 ? "simple" : "advanced");
    setSearch("");
    setSearchOpen(false);
    setPanelHeights(undefined);
  };

  return <Popover.Root open={open} onOpenChange={(nextOpen) => {
    if (nextOpen) {
      setOpenTriggerWidth(Math.max(
        triggerRef.current?.offsetWidth ?? 0,
        openLabelRef.current?.offsetWidth ?? 0,
      ));
      preparePicker();
    } else setOpenTriggerWidth(undefined);
    setOpen(nextOpen);
  }}>
    <Popover.Trigger asChild>
      <button ref={triggerRef} type="button" aria-label={open ? openLabel : t("chat.selectModel")} title={open ? openLabel : displayLabel} aria-expanded={open} data-selected={Boolean(selected)} data-state={open ? "open" : "closed"} className="q-model-picker-trigger" style={openTriggerWidth === undefined ? undefined : { width: openTriggerWidth }}>
        <span ref={openLabelRef} className="q-model-picker-trigger-measure" aria-hidden="true"><span>{openLabel}</span><ChevronDownIcon size={14} /></span>
        {open ? <span className="q-model-picker-trigger-placeholder">{openLabel}</span> : <>
          <ModelLogo modelName={activeModel?.modelName ?? ""} label={activeModel?.label} size={16} />
          <span className="q-model-picker-trigger-name">{displayLabel}</span>
          {activeModel && <span className="q-model-picker-effort-label">{thinkingLabel}</span>}
        </>}
        <ChevronDownIcon size={14} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Content side="top" align="center" sideOffset={8} collisionPadding={12} className="q-model-picker-card"
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
            <ModelLogo modelName={activeModel?.modelName ?? ""} label={activeModel?.label} size={17} />
            <button type="button" className="q-model-picker-model-button" onClick={showModels} aria-label={`${t("chat.selectModel")}：${displayLabel}`}>
              <span className="q-model-picker-model-content">
                <span className="q-model-picker-model-label"><span className="q-model-picker-model-name">{displayLabel}</span></span>
                <span className="q-model-picker-thinking-label">{thinkingLabel || t("model.thinking")}</span>
                <ChevronRightIcon size={13} aria-hidden="true" />
              </span>
            </button>
            <button type="button" className="q-model-picker-reset" disabled={!activeModel || activeModel.id === models[0]?.id} onClick={() => models[0] && setSelectedModel(models[0].id)} aria-label={t("model.resetToDefault")} title={t("model.resetToDefault")}><RotateCcwIcon size={16} /></button>
          </div>
          <ThinkingWave options={thinkingOptions} index={thinkingIndex} disabled={!activeModel} showLabel={false} onSelect={(index) => {
            const level = thinkingOptions[index];
            if (activeModel && level) setThinking(activeModel.id, level.value as ThinkingLevel);
          }} />
        </div>
        <div ref={advancedRef} className="q-model-picker-advanced" aria-hidden={view !== "advanced"} inert={view !== "advanced"} data-active={view === "advanced"}>
          <div className="q-model-picker-list-head">
            {searchOpen ? <label className="q-model-picker-search">
              <SearchIcon size={14} aria-hidden="true" />
              <input ref={searchRef} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("chat.searchModels")} aria-label={t("chat.searchModels")} />
              <button type="button" aria-label={t("chat.clearModelSearch")} onClick={() => { setSearch(""); setSearchOpen(false); }}><XIcon size={14} /></button>
            </label> : <><span>{t("chat.selectModel")}</span><button type="button" aria-label={t("chat.searchModels")} onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }}><SearchIcon size={15} /></button></>}
          </div>
          <div className="q-model-picker-list" role="listbox" aria-label={t("chat.modelsInProvider", { provider: providerSnapshot?.name || t("chat.modelProvider") })}>
            {visibleModels.map((model) => <button type="button" role="option" aria-selected={model.id === activeModel?.id} className={cn("q-model-picker-option", model.id === activeModel?.id && "is-selected")} key={model.id} onClick={() => chooseModel(model.id)}>
              <span className="q-model-picker-option-name">{model.label}</span>
              {model.id === activeModel?.id && <CheckIcon size={16} aria-hidden="true" />}
            </button>)}
            {models.length === 0 && <p className="q-model-picker-empty">{t("chat.noModelsConfigured")}</p>}
            {models.length > 0 && visibleModels.length === 0 && <p className="q-model-picker-empty">{t("chat.noModelsFound")}</p>}
          </div>
          {models.length === 0 && <button type="button" className="q-model-picker-settings" onClick={() => { setOpen(false); window.dispatchEvent(new Event("qone-open-settings")); }}>{t("chat.openSettings")}</button>}
        </div>
      </div>
    </Popover.Content>
  </Popover.Root>;
};
