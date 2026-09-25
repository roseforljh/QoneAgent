import { useEffect, useRef, useState, type CSSProperties, type FC, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { AssistantModalPrimitive } from "@assistant-ui/react";
import { CheckIcon, HandIcon, ShieldCheckIcon, ShieldIcon, SnowflakeIcon } from "lucide-react";
import type { ProviderApiType, RunPermissionMode } from "@qone/protocol";
import { normalizeThinkingLevel, thinkingLevelOptionsForApi, type ThinkingLevel } from "../../lib/model-settings";
import { useLocale, type MessageKey } from "../../localization";
import { useStore } from "../../store";
import { PermissionGrant, type GrantScope } from "./elements/permission-grant";
import penguinUrl from "../../assets/qone-penguin.png";
import "./run-options-popover.css";

const permissionModes = [
  { value: "ask", labelKey: "composer.permissionAsk", descriptionKey: "composer.permissionAskDescription", icon: HandIcon },
  { value: "auto", labelKey: "composer.permissionAuto", descriptionKey: "composer.permissionAutoDescription", icon: ShieldCheckIcon },
  { value: "full", labelKey: "composer.permissionFull", descriptionKey: "composer.permissionFullDescription", icon: ShieldIcon },
] as const;

// Shockwave picker: a capsule track with a filled segment + knob and evenly
// spaced dots that bulge as the knob passes them. Drag or wheel to change.
const ThinkingWave: FC<{
  options: readonly { value: string; labelKey: MessageKey }[];
  index: number;
  disabled: boolean;
  onSelect: (index: number) => void;
}> = ({ options, index, disabled, onSelect }) => {
  const { t } = useLocale();
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [walkDir, setWalkDir] = useState(1);
  const wheelAcc = useRef(0);
  const indexRef = useRef(index);
  indexRef.current = index;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const count = options.length;
  const last = Math.max(1, count - 1);
  const ratio = count ? index / last : 0.5;

  useEffect(() => {
    const track = trackRef.current;
    if (!track || disabled) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      wheelAcc.current += event.deltaY + event.deltaX;
      if (Math.abs(wheelAcc.current) < 36) return;
      const step = Math.sign(wheelAcc.current);
      wheelAcc.current = 0;
      const next = Math.min(count - 1, Math.max(0, indexRef.current + step));
      if (next !== indexRef.current) selectRef.current(next);
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, [disabled, count]);

  if (!count) return null;

  const ratioFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 20) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left - 10) / (rect.width - 20)));
  };

  // 拖动时按指针经过的位置直接吸附到最近档位，选中态实时提交（右侧档位名同步变）
  const snapAt = (clientX: number) => {
    const next = Math.min(count - 1, Math.max(0, Math.round(ratioFromClientX(clientX) * last)));
    if (next !== indexRef.current) {
      setWalkDir(next > indexRef.current ? 1 : -1);
      selectRef.current(next);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    const track = event.currentTarget;
    track.setPointerCapture(event.pointerId);
    setDragging(true);
    snapAt(event.clientX);
    const move = (ev: PointerEvent) => snapAt(ev.clientX);
    const done = () => {
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", done);
      track.removeEventListener("pointercancel", done);
      setDragging(false);
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", done);
    track.addEventListener("pointercancel", done);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1
        : event.key === "Home" ? -count
          : event.key === "End" ? count : 0;
    if (!step) return;
    event.preventDefault();
    const next = Math.min(count - 1, Math.max(0, indexRef.current + step));
    if (next !== indexRef.current) selectRef.current(next);
  };

  return (
    <div className="q-think-wave-row">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={t("model.thinking")}
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={index}
        aria-valuetext={t(options[index]?.labelKey ?? "")}
        aria-disabled={disabled || undefined}
        data-dragging={dragging || undefined}
        className="q-think-wave"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <span className="q-think-wave-fill" style={{ width: `calc(${ratio * 100}% + ${10 - ratio * 20}px)` }} aria-hidden="true" />
        {/* 雪花按整条轨道宽度流动，clip-path 只负责裁掉填充段以外的部分，
            所以填充伸缩不会改变雪花的速度和位置 */}
        <span
          className="q-think-wave-flakes"
          data-on={ratio > 0.22 || undefined}
          style={{ clipPath: `inset(0 calc(${(1 - ratio) * 100}% - ${10 - ratio * 20}px) 0 0)` }}
          aria-hidden="true"
        >
          {[
            { top: "38%", size: 7, dur: 5.2, delay: -0.6, bobA: -2, bobB: 1.5 },
            { top: "60%", size: 5, dur: 6.6, delay: -2.1, bobA: 2, bobB: -1.5 },
            { top: "46%", size: 9, dur: 4.6, delay: -3.4, bobA: -2.5, bobB: 2 },
            { top: "57%", size: 6, dur: 7.4, delay: -1.5, bobA: 1.5, bobB: -2 },
          ].map((flake, i) => (
            <SnowflakeIcon
              key={i}
              size={flake.size}
              className="q-think-wave-flake"
              style={{ top: flake.top, "--dur": `${flake.dur}s`, "--delay": `${flake.delay}s`, "--bob-a": `${flake.bobA}px`, "--bob-b": `${flake.bobB}px` } as CSSProperties}
            />
          ))}
        </span>
        {options.map((option, i) => {
          const pos = count > 1 ? i / last : 0.5;
          const wave = Math.max(0, 1 - Math.abs(pos - ratio) * last * 0.85);
          return (
            <i
              key={option.value}
              aria-hidden="true"
              className="q-think-wave-dot"
              style={{ left: `calc(${pos * 100}% + ${10 - pos * 20}px)`, transform: `translate(-50%, -50%) scale(${(1 + wave * 1.05).toFixed(3)})` }}
            />
          );
        })}
        <span className="q-think-wave-knob" style={{ left: `calc(max(14px, ${ratio * 100}% + ${2 - ratio * 20}px))` }} aria-hidden="true">
          <img
            src={penguinUrl}
            alt=""
            draggable={false}
            className="q-think-wave-penguin"
            data-walking={dragging || undefined}
            style={{ "--dir": walkDir } as CSSProperties}
          />
        </span>
      </div>
      <span className="q-think-wave-label">{t(options[index]?.labelKey ?? "")}</span>
    </div>
  );
};

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
  const thinkingOptions = thinkingLevelOptionsForApi(apiType);
  const thinking = normalizeThinkingLevel((selectedModelId && options?.thinkingByModel?.[selectedModelId]) || configuredThinking, apiType);
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
    <span className="q-reveal-zone -m-1 inline-flex p-1">
      <AssistantModalPrimitive.Trigger asChild>
        <button type="button" className="q-reveal q-run-options-trigger" data-state={open ? "open" : "closed"} data-open={open} data-permission-mode={permissionMode} aria-label={`${t("composer.runOptions")}：${modeLabel}`} title={`${t("composer.runOptions")}：${modeLabel}`}>
          <img src={penguinUrl} alt="" aria-hidden="true" draggable={false} className="q-run-options-penguin" />
        </button>
      </AssistantModalPrimitive.Trigger>
    </span>
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
            return <button key={mode.value} type="button" data-mode={mode.value} className="q-run-options-mode" aria-pressed={permissionMode === mode.value && grantScope !== "pending"} onClick={() => choosePermissionMode(mode.value as RunPermissionMode)}>
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
        <ThinkingWave
          options={thinkingOptions}
          index={Math.max(0, thinkingOptions.findIndex((level) => level.value === thinking))}
          disabled={!selectedModelId}
          onSelect={(i) => {
            const level = thinkingOptions[i];
            if (selectedModelId && level) setThinking(selectedModelId, level.value as ThinkingLevel);
          }}
        />
      </section>
    </AssistantModalPrimitive.Content>
  </AssistantModalPrimitive.Root>;
};
