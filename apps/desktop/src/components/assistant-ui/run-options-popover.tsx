import { useState, type FC, type RefObject } from "react";
import { AssistantModalPrimitive } from "@assistant-ui/react";
import { CheckIcon, HandIcon, ShieldCheckIcon, ShieldIcon, SlidersHorizontalIcon, SparklesIcon } from "lucide-react";
import type { ProviderApiType, RunPermissionMode } from "@qone/protocol";
import { normalizeThinkingLevel, thinkingLevelOptionsForApi, type ThinkingLevel } from "../../lib/model-settings";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import { PermissionGrant, type GrantScope } from "./elements/permission-grant";
import "./run-options-popover.css";

const permissionModes = [
  { value: "ask", labelKey: "composer.permissionAsk", descriptionKey: "composer.permissionAskDescription", icon: HandIcon },
  { value: "auto", labelKey: "composer.permissionAuto", descriptionKey: "composer.permissionAutoDescription", icon: ShieldCheckIcon },
  { value: "full", labelKey: "composer.permissionFull", descriptionKey: "composer.permissionFullDescription", icon: ShieldIcon },
] as const;

export const RunOptionsPopover: FC<{ anchorRef: RefObject<HTMLDivElement | null> }> = ({ anchorRef }) => {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const sessionId = useStore((state) => state.currentSessionId);
  const selectedModelId = useStore((state) => state.selectedModelId);
  const model = useStore((state) => state.modelConfigs.find((item) => item.id === state.selectedModelId));
  const options = useStore((state) => sessionId ? state.runOptionsBySession[sessionId] : state.draftRunOptions);
  const setPermission = useStore((state) => state.setRunPermissionMode);
  const defaultPermissionMode = useStore((state) => state.defaultPermissionMode);
  const setDefaultPermissionMode = useStore((state) => state.setDefaultPermissionMode);
  const setThinking = useStore((state) => state.setRunThinking);
  const [grantScope, setGrantScope] = useState<GrantScope | "pending" | null>(null);
  const [modeBeforeGrant, setModeBeforeGrant] = useState<RunPermissionMode>("ask");
  const permissionMode = options?.permissionMode ?? defaultPermissionMode;
  const configuredThinking = model?.config.thinking;
  const apiType = (model?.config.apiType as ProviderApiType | undefined) ?? "openai-compatible";
  const thinkingOptions = thinkingLevelOptionsForApi(apiType, Array.isArray(model?.config.thinkingLevels) ? model?.config.thinkingLevels as string[] : undefined);
  const thinking = (selectedModelId && options?.thinkingByModel?.[selectedModelId])
    ?? normalizeThinkingLevel(configuredThinking, apiType, thinkingOptions.map((item) => item.value));
  const modeLabel = t(permissionModes.find((mode) => mode.value === permissionMode)?.labelKey ?? "composer.permissionAsk");

  const choosePermissionMode = (mode: RunPermissionMode) => {
    if (mode !== "full") {
      setGrantScope(null);
      setPermission(mode);
      return;
    }
    setModeBeforeGrant(permissionMode);
    setGrantScope("pending");
  };

  const resolvePermissionGrant = (scope: GrantScope) => {
    setGrantScope(scope);
    if (scope === "denied") {
      setPermission(modeBeforeGrant);
      return;
    }
    setPermission("full");
    if (scope === "always") setDefaultPermissionMode("full");
  };

  return <AssistantModalPrimitive.Root unstable_openOnRunStart={false} open={open} onOpenChange={setOpen}>
    <AssistantModalPrimitive.Anchor virtualRef={anchorRef} />
    <AssistantModalPrimitive.Trigger asChild>
      <button type="button" className="q-run-options-trigger" data-state={open ? "open" : "closed"} data-permission-mode={permissionMode} aria-label={`${t("composer.runOptions")}：${modeLabel}`} title={`${t("composer.runOptions")}：${modeLabel}`}>
        <SlidersHorizontalIcon size={16} aria-hidden="true" />
      </button>
    </AssistantModalPrimitive.Trigger>
    <AssistantModalPrimitive.Content side="top" align="end" sideOffset={10} collisionPadding={12} dissmissOnInteractOutside className="q-run-options-card" aria-label={t("composer.runOptions")}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>("button[aria-pressed='true']")?.focus();
      }}>
      <section className="q-run-options-section" aria-label={t("composer.permissions")}>
        <h3>{t("composer.permissions")}</h3>
        <div className="q-run-options-modes">
          {permissionModes.map((mode) => {
            const Icon = mode.icon;
            return <button key={mode.value} type="button" className="q-run-options-mode" aria-pressed={permissionMode === mode.value && grantScope !== "pending"} onClick={() => choosePermissionMode(mode.value as RunPermissionMode)}>
              <Icon size={17} aria-hidden="true" />
              <span><strong>{t(mode.labelKey)}</strong><small>{t(mode.descriptionKey)}</small></span>
              {permissionMode === mode.value && grantScope !== "pending" && <CheckIcon size={16} className="q-run-options-check" aria-hidden="true" />}
            </button>;
          })}
        </div>
        {grantScope && (
          <PermissionGrant
            capability={t("composer.permissionGrantCapability")}
            requester="Qone"
            reach={[
              t("composer.permissionGrantWorkspace"),
              t("composer.permissionGrantTools"),
              t("composer.permissionGrantBoundary"),
            ]}
            scope={grantScope}
            onGrant={resolvePermissionGrant}
            labels={{
              requestedBy: t("composer.permissionGrantRequestedBy"),
              thisGrants: t("composer.permissionGrantThisGrants"),
              deny: t("composer.permissionGrantDeny"),
              session: t("composer.permissionGrantSession"),
              always: t("composer.permissionGrantAlways"),
              pending: t("composer.permissionGrantPending"),
              denied: t("composer.permissionGrantDenied"),
              granted: t("composer.permissionGrantGranted"),
            }}
            className="q-permission-grant"
          />
        )}
      </section>
      <section className="q-run-options-section q-run-options-thinking" aria-label={t("model.thinking")}>
        <h3><SparklesIcon size={15} aria-hidden="true" />{t("model.thinking")}</h3>
        <p className="q-run-options-model">{model ? `${model.provider} / ${model.model}` : t("chat.configureModel")}</p>
        <div className="q-run-options-levels" role="group" aria-label={t("model.thinking")}>
          {thinkingOptions.map((level) => <button key={level.value} type="button" disabled={!selectedModelId} aria-pressed={thinking === level.value} onClick={() => selectedModelId && setThinking(selectedModelId, level.value as ThinkingLevel)}>{t(level.labelKey)}</button>)}
        </div>
      </section>
    </AssistantModalPrimitive.Content>
  </AssistantModalPrimitive.Root>;
};
