import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Crown,
  Laptop,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import type { ServerInfo, WorkspaceInfo } from "@qone/protocol";
import { isCustomAvatar } from "../../lib/team/avatar";
import { DEFAULT_TEAM_GROUP_TEMPLATES } from "../../lib/team/presets";
import type {
  TeamBot,
  TeamExecutionStrategy,
  TeamGroupTemplate,
} from "../../lib/team/types";
import type { CreateGroupInput } from "../../lib/team/store";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { TeamAvatar, TeamGroupAvatar } from "./TeamAvatar";
import { TeamAvatarCropDialog } from "./TeamAvatarCropDialog";
import { BotModelChip } from "./BotModelChip";
import { QoneSelect } from "../ui/Select";
import { CodexServerIcon } from "../ui/CodexIcon";
import { ServerPickerDialog } from "../assistant-ui/server-picker-dialog";
import { TeamWizardDialog } from "./TeamWizardDialog";

interface CreateTeamGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: readonly TeamBot[];
  servers: readonly ServerInfo[];
  workspaces: readonly WorkspaceInfo[];
  initialTemplateId?: string;
  /** 新建自定义机器人并自动勾选时传入的刚创建的 bot ID。 */
  newlyCreatedBotId?: string;
  onRequestCreateBot: () => void;
  /** 编辑成员（人设与驱动模型）。 */
  onEditBot: (bot: TeamBot) => void;
  onSubmit: (input: CreateGroupInput) => void;
}

const STRATEGIES: ReadonlyArray<{
  id: TeamExecutionStrategy;
  titleKey: "team.env.smart" | "team.env.localOnly" | "team.env.serversPreferred";
  descKey: "team.env.strategySmartDesc" | "team.env.strategyLocalDesc" | "team.env.strategyServerDesc";
}> = [
  { id: "smart", titleKey: "team.env.smart", descKey: "team.env.strategySmartDesc" },
  { id: "local-only", titleKey: "team.env.localOnly", descKey: "team.env.strategyLocalDesc" },
  { id: "servers-preferred", titleKey: "team.env.serversPreferred", descKey: "team.env.strategyServerDesc" },
];

export function CreateTeamGroupDialog({
  open,
  onOpenChange,
  bots,
  servers,
  workspaces,
  initialTemplateId,
  newlyCreatedBotId,
  onRequestCreateBot,
  onEditBot,
  onSubmit,
}: CreateTeamGroupDialogProps) {
  const { t } = useLocale();
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [step, setStep] = useState(0);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState("");
  const [cropImageUrl, setCropImageUrl] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [coordinatorId, setCoordinatorId] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "preset" | "custom">("all");
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [allowLocal, setAllowLocal] = useState(true);
  const [strategy, setStrategy] = useState<TeamExecutionStrategy>("smart");
  const [workspaceId, setWorkspaceId] = useState("");
  const [serverPickerOpen, setServerPickerOpen] = useState(false);

  const botByPresetKey = useMemo(() => {
    const map = new Map<string, TeamBot>();
    for (const bot of bots) {
      if (bot.presetKey) map.set(bot.presetKey, bot);
    }
    return map;
  }, [bots]);

  const botsRef = useRef(bots);
  botsRef.current = bots;

  const applyTemplate = useCallback(
    (template: TeamGroupTemplate) => {
      const resolvedMembers = template.botPresetKeys
        .map((key) => botByPresetKey.get(key)?.id)
        .filter((id): id is string => Boolean(id));
      const resolvedCoordinator =
        botByPresetKey.get(template.coordinatorPresetKey)?.id ?? resolvedMembers[0] ?? "";
      setSelectedTemplateId(template.id);
      setName(t(template.nameKey as Parameters<typeof t>[0]));
      setDescription(t(template.descriptionKey as Parameters<typeof t>[0]));
      setMemberIds(resolvedMembers);
      setCoordinatorId(resolvedCoordinator);
      setStrategy(template.defaultStrategy);
    },
    [botByPresetKey, t],
  );

  const selectBlankSetup = () => {
    setSelectedTemplateId("blank");
    setName("");
    setDescription("");
    setMemberIds([]);
    setCoordinatorId("");
    setStrategy("smart");
  };

  useEffect(() => {
    if (!open) {
      setCropImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    setStep(0);
    setAvatar("");
    setMemberSearch("");
    setSourceFilter("all");
    setServerIds([]);
    setAllowLocal(true);
    setWorkspaceId("");
    const preset = initialTemplateId
      ? DEFAULT_TEAM_GROUP_TEMPLATES.find((item) => item.id === initialTemplateId)
      : DEFAULT_TEAM_GROUP_TEMPLATES[0];
    if (preset) {
      applyTemplate(preset);
    } else {
      const defaults = botsRef.current.slice(0, 3).map((bot) => bot.id);
      setSelectedTemplateId(null);
      setName("");
      setDescription("");
      setMemberIds(defaults);
      setCoordinatorId(defaults[0] ?? "");
      setStrategy("smart");
    }
  }, [open, initialTemplateId, applyTemplate]);

  useEffect(() => () => {
    if (cropImageUrl) URL.revokeObjectURL(cropImageUrl);
  }, [cropImageUrl]);

  const openGroupAvatarPicker = () => {
    avatarInputRef.current?.click();
  };

  const handleGroupAvatarSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
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

  useEffect(() => {
    if (!open || !newlyCreatedBotId) return;
    setMemberIds((prev) => (prev.includes(newlyCreatedBotId) ? prev : [...prev, newlyCreatedBotId]));
    setCoordinatorId((prev) => prev || newlyCreatedBotId);
  }, [open, newlyCreatedBotId]);

  const toggleMember = (botId: string) => {
    setMemberIds((prev) => {
      const exists = prev.includes(botId);
      const next = exists ? prev.filter((id) => id !== botId) : [...prev, botId];
      if (!next.includes(coordinatorId)) {
        setCoordinatorId(next[0] ?? "");
      }
      return next;
    });
  };

  const filteredBots = useMemo(() => {
    const q = memberSearch.trim().toLocaleLowerCase();
    return bots.filter((bot) => {
      if (sourceFilter !== "all" && bot.source !== sourceFilter) return false;
      if (!q) return true;
      return `${bot.name} ${bot.roleTitle} ${bot.description} ${bot.capabilities.join(" ")}`
        .toLocaleLowerCase()
        .includes(q);
    });
  }, [bots, memberSearch, sourceFilter]);

  const selectedMembers = useMemo(
    () =>
      memberIds
        .map((id) => bots.find((bot) => bot.id === id))
        .filter((bot): bot is TeamBot => Boolean(bot)),
    [bots, memberIds],
  );
  const boundServers = useMemo(
    () => servers.filter((server) => serverIds.includes(server.id)),
    [servers, serverIds],
  );

  const step1Valid = name.trim().length > 0;
  const step2Valid = memberIds.length > 0;
  const canCreate = step1Valid && step2Valid;
  const canAdvance = step === 0 ? step1Valid : step === 1 ? step2Valid : canCreate;
  const maxReachableStep = !step1Valid ? 0 : !step2Valid ? 1 : 2;

  const wizardSteps = useMemo(
    () => [
      { id: "template", label: t("team.dialog.groupStep1") },
      { id: "members", label: t("team.dialog.groupStep2") },
      { id: "environment", label: t("team.dialog.groupStep3") },
    ],
    [t],
  );

  const handleCreate = () => {
    if (!canCreate) return;
    onSubmit({
      name,
      description,
      ...(avatar ? { avatar } : {}),
      memberBotIds: memberIds,
      coordinatorBotId: coordinatorId || memberIds[0],
      execution: {
        allowLocal: strategy === "local-only" || serverIds.length === 0 ? true : allowLocal,
        serverIds,
        strategy: serverIds.length === 0 && strategy === "servers-preferred" ? "smart" : strategy,
        workspaceId: workspaceId || undefined,
      },
    });
    onOpenChange(false);
  };

  return (
    <>
      <TeamWizardDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("team.dialog.createGroupTitle")}
        steps={wizardSteps}
        currentStep={step}
        onStepChange={setStep}
        maxReachableStep={maxReachableStep}
        footer={
          <>
            <div className="flex items-center gap-2">
              {step > 0 ? (
                <button
                  type="button"
                  className="servers-button inline-flex items-center gap-1.5"
                  onClick={() => setStep((prev) => Math.max(0, prev - 1))}
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
              {step < wizardSteps.length - 1 ? (
                <>
                  {step === 0 && canCreate && (
                    <button
                      type="button"
                      className="servers-button"
                      onClick={handleCreate}
                    >
                      {t("team.dialog.quickCreate")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="servers-button is-primary inline-flex items-center gap-1.5"
                    disabled={!canAdvance}
                    onClick={() => setStep((prev) => Math.min(wizardSteps.length - 1, prev + 1))}
                  >
                    {t("team.dialog.nextStep")}
                    <ArrowRight size={13} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="servers-button is-primary"
                  disabled={!canCreate}
                  onClick={handleCreate}
                >
                  {t("team.dialog.createCta")}
                </button>
              )}
            </div>
          </>
        }
      >
        {/* 第 1 步：选择模板 + 群聊基础信息 */}
        {step === 0 && (
          <div className="flex flex-1 flex-col gap-5">
            <section>
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("team.dialog.templates")}
                </span>
                <button
                  type="button"
                  onClick={selectBlankSetup}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                    selectedTemplateId === "blank"
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Plus size={12} />
                  {t("team.dialog.blankTemplateName")}
                </button>
              </div>

              <div className="team-template-grid">
                {DEFAULT_TEAM_GROUP_TEMPLATES.map((template) => {
                  const templateBots = template.botPresetKeys
                    .map((key) => botByPresetKey.get(key))
                    .filter((bot): bot is TeamBot => Boolean(bot));
                  const isSelected = selectedTemplateId === template.id;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => applyTemplate(template)}
                      className={cn("team-template-card", isSelected && "is-selected")}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="team-avatar-stack">
                          {templateBots.map((bot) => (
                            <TeamAvatar key={bot.id} bot={bot} size={26} />
                          ))}
                        </div>
                        {isSelected ? (
                          <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check size={11} />
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">
                            {t("team.membersCount", { count: templateBots.length })}
                          </span>
                        )}
                      </div>
                      <div>
                        <strong className="block text-[13.5px] font-semibold text-foreground">
                          {t(template.nameKey as Parameters<typeof t>[0])}
                        </strong>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {t(template.descriptionKey as Parameters<typeof t>[0])}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="flex flex-col gap-4 border-t border-border/70 pt-5 sm:flex-row sm:items-end">
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="sr-only"
                tabIndex={-1}
                onChange={handleGroupAvatarSelected}
              />
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={openGroupAvatarPicker}
                  title={t("team.inspector.groupAvatarHint")}
                  aria-label={t("team.inspector.groupAvatarHint")}
                  className="team-group-avatar-trigger"
                >
                  <TeamGroupAvatar group={{ avatar, name }} members={selectedMembers} size={48} stackSize={24} />
                  <span className="team-avatar-trigger-overlay" aria-hidden="true">
                    <Camera size={15} />
                  </span>
                </button>
                {isCustomAvatar(avatar) && (
                  <button
                    type="button"
                    onClick={() => setAvatar("")}
                    title={t("team.inspector.groupAvatarReset")}
                    aria-label={t("team.inspector.groupAvatarReset")}
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
              </div>
              <div className="grid min-w-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                  <span>{t("team.dialog.groupName")}</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("team.dialog.groupNamePlaceholder")}
                    className="h-10 rounded-xl border border-border bg-background px-3.5 text-sm text-foreground outline-none focus:border-foreground/40"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                  <span>{t("team.dialog.groupDesc")}</span>
                  <input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={t("team.dialog.groupDescPlaceholder")}
                    className="h-10 rounded-xl border border-border bg-background px-3.5 text-sm text-foreground outline-none focus:border-foreground/40"
                  />
                </label>
              </div>
            </section>
          </div>
        )}

        {/* 第 2 步：左右双栏挑选成员 + 右侧直接指定群统筹 */}
        {step === 1 && (
          <div className="team-wizard-split">
            <div className="flex min-h-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="relative flex min-w-[180px] flex-1 items-center">
                  <Search size={13} className="pointer-events-none absolute left-3 text-muted-foreground" />
                  <input
                    value={memberSearch}
                    onChange={(event) => setMemberSearch(event.target.value)}
                    placeholder={t("team.dialog.searchMembers")}
                    className="h-9 w-full rounded-xl border border-border bg-background pr-3 pl-8 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/40"
                  />
                </label>
                <button
                  type="button"
                  onClick={onRequestCreateBot}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-accent"
                >
                  <Plus size={13} />
                  {t("team.newBot")}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {(["all", "preset", "custom"] as const).map((source) => (
                  <button
                    key={source}
                    type="button"
                    onClick={() => setSourceFilter(source)}
                    className={cn(
                      "h-7 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors",
                      sourceFilter === source
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/80 bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {source === "all"
                      ? t("team.dialog.filterAll")
                      : t(`team.source.${source}` as Parameters<typeof t>[0])}
                  </button>
                ))}
              </div>

              <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                {filteredBots.map((bot) => {
                  const checked = memberIds.includes(bot.id);
                  return (
                    <button
                      key={bot.id}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() => toggleMember(bot.id)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-xl border p-2.5 text-left transition-colors",
                        checked
                          ? "border-foreground/40 bg-foreground/[0.045]"
                          : "border-border/75 bg-background hover:bg-foreground/[0.025]",
                      )}
                    >
                      <TeamAvatar bot={bot} size={38} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <strong className="truncate text-xs font-medium text-foreground">
                            {bot.name}
                          </strong>
                          {bot.source === "custom" && (
                            <span className="rounded bg-muted px-1 py-0.5 text-[9.5px] text-muted-foreground">
                              {t("team.source.custom")}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {bot.roleTitle}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "inline-flex size-4 shrink-0 items-center justify-center rounded-full border",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border",
                        )}
                      >
                        {checked && <Check size={10} />}
                      </span>
                    </button>
                  );
                })}
                {filteredBots.length === 0 && (
                  <p className="col-span-full py-10 text-center text-xs text-muted-foreground">
                    {t("team.emptyBotsTitle")}
                  </p>
                )}
              </div>
            </div>

            {/* 右栏：已选成员阵容 + 一键点皇冠设统筹 */}
            <div className="team-wizard-panel">
              <div className="flex items-center justify-between">
                <strong className="text-xs font-semibold text-foreground">
                  {t("team.dialog.selectedRoster")}
                </strong>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
                  {selectedMembers.length}
                </span>
              </div>

              <div className="mt-3 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
                {selectedMembers.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                    {t("team.dialog.noMemberSelected")}
                  </div>
                ) : (
                  selectedMembers.map((bot) => {
                    const isCoordinator = coordinatorId === bot.id;
                    return (
                      <div
                        key={bot.id}
                        className={cn(
                          "flex items-center gap-2.5 rounded-xl border px-2.5 py-2",
                          isCoordinator
                            ? "border-amber-500/40 bg-amber-500/[0.06]"
                            : "border-border/75 bg-background",
                        )}
                      >
                        <TeamAvatar bot={bot} size={32} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-foreground">{bot.name}</div>
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-[10.5px] text-muted-foreground">
                              {bot.roleTitle}
                            </span>
                            <BotModelChip bot={bot} onClick={() => onEditBot(bot)} />
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onEditBot(bot)}
                          title={t("team.editBot")}
                          aria-label={t("team.editBot")}
                          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setCoordinatorId(bot.id)}
                          title={t("team.setCoordinator")}
                          aria-label={t("team.setCoordinator")}
                          aria-pressed={isCoordinator}
                          className={cn(
                            "inline-flex size-6 items-center justify-center rounded-md transition-colors",
                            isCoordinator
                              ? "bg-amber-500/18 text-amber-600 dark:text-amber-300"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                        >
                          <Crown size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleMember(bot.id)}
                          title={t("team.removeMember")}
                          aria-label={t("team.removeMember")}
                          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* 第 3 步：执行环境（本机 + 多服务器智能调度）与创建总览 */}
        {step === 2 && (
          <div className="team-wizard-split-balanced">
            <div className="flex flex-col gap-3.5">
              <div>
                <h3 className="text-xs font-semibold text-foreground">{t("team.env.strategyTitle")}</h3>
                <div className="mt-2 flex flex-col gap-1.5">
                  {STRATEGIES.map((item) => {
                    const selected = strategy === item.id;
                    const disabled = item.id === "servers-preferred" && boundServers.length === 0;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => setStrategy(item.id)}
                        className={cn(
                          "team-strategy-card border border-border/75 bg-background",
                          selected && "is-selected",
                          disabled && "cursor-not-allowed opacity-45",
                        )}
                      >
                        <span className="mt-0.5 text-foreground">
                          {item.id === "smart" ? (
                            <Sparkles size={15} />
                          ) : item.id === "local-only" ? (
                            <Laptop size={15} />
                          ) : (
                            <CodexServerIcon className="size-4" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <strong className="block text-[13px] font-medium text-foreground">
                            {t(item.titleKey)}
                          </strong>
                          <small className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
                            {t(item.descKey)}
                          </small>
                        </span>
                        {selected && <Check size={15} className="mt-0.5 shrink-0 text-foreground" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {boundServers.length > 0 && strategy !== "local-only" && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-background px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground">
                      {t("team.env.allowLocalFallback")}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {t("team.env.allowLocalFallbackDesc")}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={allowLocal}
                    onClick={() => setAllowLocal((prev) => !prev)}
                    className={cn("settings-switch shrink-0", allowLocal && "is-on")}
                  >
                    <span />
                  </button>
                </div>
              )}

              {workspaces.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("team.env.workspace")}
                  </span>
                  <QoneSelect
                    value={workspaceId}
                    onChange={setWorkspaceId}
                    options={[
                      { value: "", label: t("team.env.noWorkspace") },
                      ...workspaces.map((ws) => ({
                        value: ws.id,
                        label: ws.name,
                        description: ws.path,
                      })),
                    ]}
                    ariaLabel={t("team.env.workspace")}
                    triggerClassName="qone-select-trigger-compact w-full"
                  />
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3.5">
              <div className="team-wizard-panel gap-3">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-xs font-semibold text-foreground">
                    {t("team.env.boundServers")}
                  </strong>
                  <button
                    type="button"
                    onClick={() => setServerPickerOpen(true)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent"
                  >
                    <CodexServerIcon className="size-3.5" />
                    {t("team.env.manageServers")}
                  </button>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2.5 rounded-xl border border-border/75 bg-background px-3 py-2 text-xs">
                    <Laptop size={14} className="text-emerald-500" />
                    <span className="font-medium text-foreground">{t("team.env.local")}</span>
                    <span className="ml-auto rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-300">
                      {t("team.presence.idle")}
                    </span>
                  </div>

                  {boundServers.map((server) => (
                    <div
                      key={server.id}
                      className="flex items-center gap-2.5 rounded-xl border border-sky-500/25 bg-sky-500/[0.06] px-3 py-2 text-xs"
                    >
                      <CodexServerIcon className="size-3.5 text-sky-600 dark:text-sky-300" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-foreground">{server.name}</div>
                        <div className="truncate text-[10.5px] text-muted-foreground">
                          {server.username}@{server.host}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setServerIds((prev) => prev.filter((id) => id !== server.id))}
                        className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                        aria-label={server.name}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}

                  {boundServers.length === 0 && (
                    <p className="px-1 pt-1 text-[11.5px] text-muted-foreground">
                      {t("team.env.noServersBound")}
                    </p>
                  )}
                </div>
              </div>

              {/* 即将创建总览卡片 */}
              <div className="rounded-xl border border-border/80 bg-background p-3.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {t("team.dialog.summaryPreview")}
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <TeamGroupAvatar group={{ avatar, name }} members={selectedMembers} size={36} stackSize={28} maxStack={4} />
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-sm font-semibold text-foreground">
                      {name.trim()}
                    </strong>
                    <span className="text-[11.5px] text-muted-foreground">
                      {t("team.membersCount", { count: selectedMembers.length })} ·{" "}
                      {t("team.coordinator")}:{" "}
                      {selectedMembers.find((bot) => bot.id === coordinatorId)?.name ??
                        selectedMembers[0]?.name ??
                        ""}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </TeamWizardDialog>

      <ServerPickerDialog
        open={serverPickerOpen}
        onOpenChange={setServerPickerOpen}
        title={t("servers.title")}
        description={t("team.env.serverPickerDesc")}
        ids={serverIds}
        onChange={setServerIds}
      />

      <TeamAvatarCropDialog
        open={Boolean(cropImageUrl)}
        imageUrl={cropImageUrl}
        onOpenChange={closeCropDialog}
        onRechoose={openGroupAvatarPicker}
        onConfirm={(dataUrl) => setAvatar(dataUrl)}
      />
    </>
  );
}
