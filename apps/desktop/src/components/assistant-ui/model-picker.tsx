import { useEffect, useMemo, useState, type FC } from "react";
import { CheckIcon, ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import { AssistantModalPrimitive } from "@assistant-ui/react";
import { ModelLogo } from "./model-logo";
import { ACTIVE_PROVIDER_STORAGE_KEY, PROVIDERS_STORAGE_KEY, MODEL_CONFIG_CHANGE_EVENT, filterPickerModels, readCurrentProvider, getPickerModels } from "../../lib/model-picker-data";
import "./model-picker.css";

export const ModelPicker: FC = () => {
  const modelConfigs = useStore((s) => s.modelConfigs);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const setSelectedModel = useStore((s) => s.setSelectedModel);
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [providerSnapshot, setProviderSnapshot] = useState(() => readCurrentProvider());

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

  useEffect(() => {
    if (models.length > 0 && !selected) setSelectedModel(models[0].id);
  }, [models, selected, setSelectedModel]);

  const displayLabel = activeModel?.label ?? t("chat.configureModel");

  return (
    <AssistantModalPrimitive.Root unstable_openOnRunStart={false} open={open} onOpenChange={(nextOpen) => { setProviderSnapshot(readCurrentProvider()); setSearch(nextOpen ? "" : search); setOpen(nextOpen); }}>
      <AssistantModalPrimitive.Trigger asChild>
        <button type="button" aria-label={t("chat.selectModel")} title={displayLabel} className="q-model-picker-trigger text-muted-foreground hover:text-foreground flex h-7 max-w-[220px] cursor-pointer items-center gap-1.5 rounded-full px-2 text-xs transition-colors">
          <ModelLogo modelName={activeModel?.modelName ?? ""} label={activeModel?.label} size={16} />
          <span className="truncate">{displayLabel}</span>
          <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        </button>
      </AssistantModalPrimitive.Trigger>
      <AssistantModalPrimitive.Content side="top" align="start" sideOffset={8} collisionPadding={12} dissmissOnInteractOutside className="q-model-picker-card" onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = event.currentTarget as HTMLElement;
          const searchInput = content.querySelector<HTMLInputElement>(".q-model-picker-search-input");
          const option = content.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? content.querySelector<HTMLButtonElement>('[role="option"]');
          (searchInput ?? option ?? content.querySelector<HTMLButtonElement>("button") ?? content).focus();
        }} onKeyDown={(event) => {
          if (event.key === "Tab") { setOpen(false); return; }
          const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
          if (!options.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const index = options.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : index < 0 ? (event.key === "ArrowUp" ? options.length - 1 : 0) : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
          options[next]?.focus();
        }}>
          <div className="q-model-picker-heading">
            {models.length > 0 && <label className="q-model-picker-search">
              <SearchIcon className="q-model-picker-search-icon" aria-hidden="true" />
              <input className="q-model-picker-search-input" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("chat.searchModels")} aria-label={t("chat.searchModels")} />
              {search && <button type="button" className="q-model-picker-search-clear" aria-label={t("chat.clearModelSearch")} onClick={() => setSearch("")}><XIcon /></button>}
            </label>}
          </div>
          <div className="q-model-picker-list" role="listbox" aria-label={t("chat.modelsInProvider", { provider: providerSnapshot?.name || t("chat.modelProvider") })}>
            {visibleModels.map((model) => (
              <button type="button" role="option" aria-selected={model.id === activeModel?.id} title={model.label} className={cn("q-model-picker-option", model.id === activeModel?.id && "is-selected")} key={model.id} onClick={() => { setSelectedModel(model.id); setOpen(false); }}>
                <ModelLogo modelName={model.modelName} label={model.label} />
                <span className="q-model-picker-option-copy"><strong>{model.label}</strong></span>
                {model.id === activeModel?.id && <CheckIcon className="size-4 shrink-0" />}
              </button>
            ))}
            {models.length === 0 && <p className="q-model-picker-empty">{t("chat.noModelsConfigured")}</p>}
            {models.length > 0 && visibleModels.length === 0 && <p className="q-model-picker-empty">{t("chat.noModelsFound")}</p>}
          </div>
          {models.length === 0 && <button type="button" className="q-model-picker-settings" onClick={() => { setOpen(false); window.dispatchEvent(new Event("qone-open-settings")); }}>{t("chat.openSettings")}</button>}
      </AssistantModalPrimitive.Content>
    </AssistantModalPrimitive.Root>
  );
};
