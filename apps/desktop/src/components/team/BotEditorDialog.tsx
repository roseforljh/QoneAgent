import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ArrowLeft, ArrowRight, Camera, Plus, X } from "lucide-react";
import type { TeamThinkingLevel } from "@qone/protocol";
import { TEAM_CAPABILITY_KEYS } from "../../lib/team/presets";
import { avatarIdOf, customAvatarOf, TEAM_AVATAR_IDS } from "../../lib/team/avatar";
import type { TeamBot } from "../../lib/team/types";
import type { CreateBotInput } from "../../lib/team/store";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { ModelPicker } from "../assistant-ui/model-picker";
import { TeamAvatar } from "./TeamAvatar";
import { TeamAvatarCropDialog } from "./TeamAvatarCropDialog";
import { TeamWizardDialog } from "./TeamWizardDialog";

interface BotEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingBot?: TeamBot;
  nested?: boolean;
  onSave: (input: CreateBotInput, editingBotId?: string) => void;
}

export function BotEditorDialog({
  open,
  onOpenChange,
  editingBot,
  nested = false,
  onSave,
}: BotEditorDialogProps) {
  const { t } = useLocale();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [avatar, setAvatar] = useState<string>(TEAM_AVATAR_IDS[0]);
  const [cropImageUrl, setCropImageUrl] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [thinking, setThinking] = useState<TeamThinkingLevel | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [customCapability, setCustomCapability] = useState("");

  useEffect(() => {
    if (!open) {
      setCropImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    setStep(0);
    if (editingBot) {
      setName(editingBot.name);
      setRoleTitle(editingBot.roleTitle);
      setDescription(editingBot.description);
      setSystemPrompt(editingBot.systemPrompt);
      setAvatar(customAvatarOf(editingBot) ?? avatarIdOf(editingBot));
      setModelId(editingBot.modelId);
      setThinking(editingBot.thinking);
      setCapabilities([...editingBot.capabilities]);
    } else {
      setName("");
      setRoleTitle("");
      setDescription("");
      setSystemPrompt("");
      setAvatar(avatarIdOf({ id: crypto.randomUUID() }));
      setModelId("");
      setThinking(undefined);
      setCapabilities(["coding"]);
    }
    setCustomCapability("");
  }, [open, editingBot]);

  useEffect(() => () => {
    if (cropImageUrl) URL.revokeObjectURL(cropImageUrl);
  }, [cropImageUrl]);

  const openImagePicker = () => {
    fileInputRef.current?.click();
  };

  const handleImageSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 重置 value，确保取消后重复选同一张本地图仍能触发 onChange。
    event.target.value = "";
    if (!file) return;
    const nextUrl = URL.createObjectURL(file);
    setCropImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return nextUrl;
    });
  };

  const closeCropDialog = (nextOpen: boolean) => {
    if (nextOpen) return;
    setCropImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  };

  const wizardSteps = useMemo(
    () => [
      { id: "identity", label: t("team.dialog.botStep1") },
      { id: "prompt", label: t("team.dialog.botStep2") },
    ],
    [t],
  );

  const toggleCapability = (cap: string) => {
    setCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((item) => item !== cap) : [...prev, cap],
    );
  };

  const addCustomCapability = () => {
    const trimmed = customCapability.trim();
    if (!trimmed) return;
    if (!capabilities.includes(trimmed)) {
      setCapabilities((prev) => [...prev, trimmed]);
    }
    setCustomCapability("");
  };

  const canSave = name.trim().length > 0;

  const handleSubmit = () => {
    if (!canSave) return;
    onSave(
      {
        name,
        roleTitle: roleTitle.trim() || name.trim(),
        description,
        systemPrompt,
        logo: editingBot?.logo ?? "robot",
        avatar,
        modelId,
        thinking: modelId ? thinking : undefined,
        capabilities,
      },
      editingBot?.id,
    );
    onOpenChange(false);
  };

  const capabilityLabel = (key: string) => {
    const isPreset = (TEAM_CAPABILITY_KEYS as readonly string[]).includes(key);
    return isPreset ? t(`team.capability.${key}` as Parameters<typeof t>[0]) : key;
  };

  return (
    <TeamWizardDialog
      open={open}
      onOpenChange={onOpenChange}
      nested={nested}
      title={t(editingBot ? "team.dialog.botTitleEdit" : "team.dialog.botTitleCreate")}
      steps={wizardSteps}
      currentStep={step}
      onStepChange={setStep}
      maxReachableStep={canSave ? 1 : 0}
      footer={
        <>
          <div className="flex min-w-0 items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                className="servers-button inline-flex items-center gap-1.5"
                onClick={() => setStep(0)}
              >
                <ArrowLeft size={13} />
                {t("team.dialog.prevStep")}
              </button>
            )}
            <ModelPicker control={{
              modelId,
              defaultLabel: t("team.dialog.botModelDefault"),
              thinkingByModel: modelId && thinking ? { [modelId]: thinking } : {},
              setModel: (id) => {
                setModelId(id);
                if (id !== modelId) setThinking(undefined);
              },
              setThinking: (_id, level) => setThinking(level),
            }} />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="servers-button" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </button>
            {step === 0 ? (
              <button
                type="button"
                className="servers-button is-primary inline-flex items-center gap-1.5"
                disabled={!canSave}
                onClick={() => setStep(1)}
              >
                {t("team.dialog.nextStep")}
                <ArrowRight size={13} />
              </button>
            ) : (
              <button
                type="button"
                className="servers-button is-primary"
                disabled={!canSave}
                onClick={handleSubmit}
              >
                {t("team.dialog.botSave")}
              </button>
            )}
          </div>
        </>
      }
    >
      {/* 第 1 步：角色头像与成员资料。模型与定时任务一样从底栏选择。 */}
      {step === 0 && (
        <div className="team-wizard-split-balanced">
          <div className="team-wizard-panel team-portrait-panel">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              tabIndex={-1}
              onChange={handleImageSelected}
            />
            <div className="flex min-w-0 items-center gap-4">
              <button
                type="button"
                onClick={openImagePicker}
                title={t("team.dialog.avatarUploadHint")}
                aria-label={t("team.dialog.avatarUploadHint")}
                className="team-avatar-trigger"
              >
                <TeamAvatar bot={{ id: editingBot?.id ?? "preview", avatar, name: "" }} size={76} />
                <span className="team-avatar-trigger-overlay" aria-hidden="true">
                  <Camera size={18} />
                </span>
              </button>
              <div className="min-w-0">
                <strong className="block truncate text-base font-semibold text-foreground">
                  {name.trim() || t("team.dialog.botName")}
                </strong>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {roleTitle.trim() || t("team.dialog.botRole")}
                </div>
                <button
                  type="button"
                  onClick={openImagePicker}
                  className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Camera size={11} />
                  <span>{t("team.dialog.avatarUploadHint")}</span>
                </button>
              </div>
            </div>
            <div role="group" aria-label={t("team.dialog.botLogo")} className="team-portrait-grid">
              {TEAM_AVATAR_IDS.map((id, index) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setAvatar(id)}
                  aria-label={`${t("team.dialog.botLogo")} ${index + 1}`}
                  aria-pressed={avatar === id}
                  className={cn("team-logo-choice", avatar === id && "is-selected")}
                >
                  <TeamAvatar bot={{ id, name: "" }} size={40} />
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              <span>{t("team.dialog.botName")}</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("team.dialog.botNamePlaceholder")}
                className="h-10 rounded-xl border border-border bg-background px-3.5 text-sm text-foreground outline-none focus:border-foreground/40"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              <span>{t("team.dialog.botRole")}</span>
              <input
                value={roleTitle}
                onChange={(event) => setRoleTitle(event.target.value)}
                placeholder={t("team.dialog.botRolePlaceholder")}
                className="h-10 rounded-xl border border-border bg-background px-3.5 text-sm text-foreground outline-none focus:border-foreground/40"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              <span>{t("team.dialog.botSummary")}</span>
              <textarea
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("team.dialog.botSummaryPlaceholder")}
                className="resize-none rounded-xl border border-border bg-background p-3 text-xs leading-relaxed text-foreground outline-none focus:border-foreground/40"
              />
            </label>
          </div>
        </div>
      )}

      {/* 第 2 步：宽敞的系统提示词编辑器与能力标签 */}
      {step === 1 && (
        <div className="flex flex-1 flex-col gap-5">
          <label className="flex flex-1 flex-col gap-2 text-xs font-medium text-muted-foreground">
            <span>{t("team.dialog.botPrompt")}</span>
            <textarea
              rows={8}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder={t("team.dialog.botPromptPlaceholder")}
              className="min-h-[180px] flex-1 resize-none rounded-xl border border-border bg-background p-3.5 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-foreground/40"
            />
          </label>

          <section className="rounded-xl border border-border/80 bg-muted/25 p-3.5">
            <span className="mb-2 block text-xs font-medium text-muted-foreground">
              {t("team.dialog.botCapabilities")}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {TEAM_CAPABILITY_KEYS.map((key) => {
                const active = capabilities.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleCapability(key)}
                    className={cn(
                      "h-7 rounded-full border px-3 text-xs font-medium transition-colors",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {capabilityLabel(key)}
                  </button>
                );
              })}
              {capabilities
                .filter((key) => !(TEAM_CAPABILITY_KEYS as readonly string[]).includes(key))
                .map((custom) => (
                  <span
                    key={custom}
                    className="inline-flex h-7 items-center gap-1 rounded-full border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground"
                  >
                    {custom}
                    <button
                      type="button"
                      onClick={() => toggleCapability(custom)}
                      className="rounded-full p-0.5 opacity-80 hover:opacity-100"
                      aria-label={custom}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <input
                value={customCapability}
                onChange={(event) => setCustomCapability(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCustomCapability();
                  }
                }}
                placeholder={t("team.dialog.botCustomCapabilityPlaceholder")}
                className="h-8 flex-1 rounded-lg border border-border bg-background px-3 text-xs text-foreground outline-none focus:border-foreground/40"
              />
              <button
                type="button"
                onClick={addCustomCapability}
                disabled={!customCapability.trim()}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-45"
              >
                <Plus size={12} />
              </button>
            </div>
          </section>
        </div>
      )}
      <TeamAvatarCropDialog
        open={Boolean(cropImageUrl)}
        imageUrl={cropImageUrl}
        onOpenChange={closeCropDialog}
        onRechoose={openImagePicker}
        onConfirm={(dataUrl) => setAvatar(dataUrl)}
      />
    </TeamWizardDialog>
  );
}
