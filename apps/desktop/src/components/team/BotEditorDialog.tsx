import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Plus, X } from "lucide-react";
import type { ModelConfigInfo, SubagentLogoId } from "@qone/protocol";
import { TEAM_BOT_LOGO_CHOICES, TEAM_CAPABILITY_KEYS } from "../../lib/team/presets";
import type { TeamBot } from "../../lib/team/types";
import type { CreateBotInput } from "../../lib/team/store";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { SubagentLogo } from "../settings/subagent-logo";
import { QoneSelect } from "../ui/Select";
import { TeamWizardDialog } from "./TeamWizardDialog";

interface BotEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingBot?: TeamBot;
  modelConfigs: readonly ModelConfigInfo[];
  nested?: boolean;
  onSave: (input: CreateBotInput, editingBotId?: string) => void;
}

export function BotEditorDialog({
  open,
  onOpenChange,
  editingBot,
  modelConfigs,
  nested = false,
  onSave,
}: BotEditorDialogProps) {
  const { t } = useLocale();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [logo, setLogo] = useState<SubagentLogoId>("robot");
  const [modelId, setModelId] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [customCapability, setCustomCapability] = useState("");

  useEffect(() => {
    if (!open) return;
    setStep(0);
    if (editingBot) {
      setName(editingBot.name);
      setRoleTitle(editingBot.roleTitle);
      setDescription(editingBot.description);
      setSystemPrompt(editingBot.systemPrompt);
      setLogo(editingBot.logo);
      setModelId(editingBot.modelId);
      setCapabilities([...editingBot.capabilities]);
    } else {
      setName("");
      setRoleTitle("");
      setDescription("");
      setSystemPrompt("");
      setLogo("sparkles");
      setModelId("");
      setCapabilities(["coding"]);
    }
    setCustomCapability("");
  }, [open, editingBot]);

  const modelOptions = useMemo(() => {
    const enabled = modelConfigs.filter((item) => item.enabled);
    return [
      { value: "", label: t("team.dialog.botModelDefault") },
      ...enabled.map((item) => ({
        value: item.id,
        label:
          typeof item.config?.displayName === "string" && item.config.displayName
            ? item.config.displayName
            : item.model,
        description: `${item.provider} · ${item.model}`,
      })),
    ];
  }, [modelConfigs, t]);

  const selectedModelLabel =
    modelOptions.find((option) => option.value === modelId)?.label ??
    t("team.dialog.botModelDefault");

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
        logo,
        modelId,
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
      description={t("team.dialog.botDesc")}
      steps={wizardSteps}
      currentStep={step}
      onStepChange={setStep}
      maxReachableStep={canSave ? 1 : 0}
      footer={
        <>
          <div className="flex items-center gap-2">
            {step > 0 ? (
              <button
                type="button"
                className="servers-button inline-flex items-center gap-1.5"
                onClick={() => setStep(0)}
              >
                <ArrowLeft size={13} />
                {t("team.dialog.prevStep")}
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">
                {t("team.dialog.stepCounter", { current: step + 1, total: wizardSteps.length })}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
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
      {/* 第 1 步：左侧实时名片与图标选择器，右侧基础身份与模型 */}
      {step === 0 && (
        <div className="team-wizard-split-balanced">
          <div className="team-wizard-panel gap-3.5">
            <div className="text-[11px] font-medium text-muted-foreground">
              {t("team.dialog.botPreview")}
            </div>

            <div className="flex items-center gap-3.5 rounded-xl border border-border/80 bg-background p-3.5">
              <SubagentLogo logo={logo} name={name || "Bot"} size={48} />
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-semibold text-foreground">
                  {name.trim() || t("team.dialog.botName")}
                </strong>
                <div className="truncate text-xs text-muted-foreground">
                  {roleTitle.trim() || t("team.dialog.botRole")}
                </div>
                <div className="mt-1.5 truncate text-[11px] text-muted-foreground/85">
                  {selectedModelLabel}
                </div>
              </div>
            </div>

            <div>
              <span className="mb-2 block text-[11px] font-medium text-muted-foreground">
                {t("team.dialog.botLogo")}
              </span>
              <div className="grid grid-cols-6 gap-1.5">
                {TEAM_BOT_LOGO_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => setLogo(choice)}
                    aria-pressed={logo === choice}
                    className={cn("team-logo-choice", logo === choice && "is-selected")}
                  >
                    <SubagentLogo logo={choice} name={name || choice} size={28} />
                  </button>
                ))}
              </div>
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

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t("team.dialog.botModel")}
              </span>
              <QoneSelect
                value={modelId}
                onChange={setModelId}
                options={modelOptions}
                ariaLabel={t("team.dialog.botModel")}
                triggerClassName="qone-select-trigger-compact w-full"
              />
            </div>

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
    </TeamWizardDialog>
  );
}
