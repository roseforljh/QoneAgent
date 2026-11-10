import { localizeError } from "../../lib/error-localization";
import { subagentProfileCopy, subagentProfileNameForSave } from "../../lib/subagent-profile-copy";
import { detectImageModel, ECC_BUILTIN_SUBAGENTS, isBuiltinSubagentId, isEccBuiltinSubagentId, modelListUrl, modelNamesEqual, REMOVED_BUILTIN_SUBAGENT_IDS, supportsExtendedImageQuality, type BuiltinSubagentCatalogEntry, type ImageApiFormat, type ProviderApiType } from "@qone/protocol";
import { NumberField } from "@base-ui/react/number-field";
import { Switch } from "@base-ui/react/switch";
import { PROVIDERS_STORAGE_KEY, ACTIVE_PROVIDER_STORAGE_KEY, MODEL_CONFIG_CHANGE_EVENT, providerProfilesFromModelConfigs } from "../../lib/model-picker-data";
import { fetchProviderModelCatalog } from "../../lib/provider-model-catalog";
import { capabilities, defaultModelSettings, mergeFetchedModel, normalizeThinkingLevel, parseModelsResponse, thinkingLevelOptionsForApi, withProviderInputDefaults, withResolvedModelSettings, type Capability, type ImageGenerationSettings, type ModelSettingField, type ModelSettings, type ProviderModel, type ProviderProfile, type ThinkingLevel } from "../../lib/model-settings";
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { check } from "../../lib/desktop-bridge";
import { invoke } from "../../lib/desktop-bridge";
import { openPath, openUrl, revealItemInDir } from "../../lib/desktop-bridge";
import { hasDesktopBridge, requestModelMetadata } from "../../store";
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
  Library,
  LoaderCircle,
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
import { ModelCard } from "./ModelCard";
import { ProviderLogo } from "./ProviderLogo";
import { SectionHeader, SettingsPageHeader, SettingsSelect } from "./settings-chrome";
import { SkillsSection } from "./SkillsSection";
import { GeneralSection } from "./general-section";
import { McpSection } from "./mcp-section";
import { PersonalizationSection } from "./personalization-section";
import { ConfigurationSection } from "./configuration-section";
import { ModelsSection } from "./models-section";
import { SubagentsSection } from "./subagents-section";
import { CompactionSection } from "./compaction-section";
import { SubagentRuntimeSettings } from "./SubagentRuntimeSettings";
import { SubagentTemporarySettings } from "./SubagentTemporarySettings";
import { BuiltinSubagentSettings } from "./BuiltinSubagentDialog";
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
