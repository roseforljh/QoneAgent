import { useConversationStore } from "../../lib/conversation-context";
import { CodexFileSearchIcon as FileSearchIcon, CodexPenLineIcon as PenLineIcon, CodexSearchIcon as SearchIcon, CodexTerminalIcon as TerminalIcon, CodexWrenchIcon as WrenchIcon, type ExecutionIcon } from "./execution-icons";
import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useState, type FC } from "react";
import { MessagePrimitive, useAuiState, type PartState } from "@assistant-ui/react";
import {
  ToolTimeline,
  ToolTimelineRow,
  type TimelineStep,
} from "./elements/tool-timeline";
import { ToolCall } from "./elements/tool-call";
import { ToolResultView } from "./elements/tool-result";
import { formatToolPayload, toolActivity, toolCallStatus, toolResultText } from "./tool-call-display";
import { detectToolPreview } from "./tool-preview";
import { toolActionSummary, toolFullTarget, toolOperationLabels, toolPreparationLabel, toolTarget } from "./tool-action-summary";
import { detectToolPresentation, toolDiffStats, toolPresentationSummary } from "./tool-presentation";
import { useLocale, type Locale } from "../../localization";
import { toolGroupSummary } from "./tool-group-summary";
import type { ToolCall as StoreToolCall } from "../../store";
import { toolActivityCategory } from "./tool-activity-category";
import { ACTIVITY_TITLE_TOOL, toolFileChanges } from "@qone/protocol";
import { selectActiveToolIndex } from "./tool-timeline-state";
import { openSubagent, subagentForTool } from "./subagent-navigation";
import { toolFileActivities } from "./file-change-activity-data";
import { FileChangeActivityRow } from "./file-change-activity";
import { collectToolFileChanges } from "./run-file-changes";
import { integrationIcon, toolIntegration, type ToolIntegration } from "./tool-integration";
import { isIntegrationTool } from "./tool-activity-category";
import type { McpServerInfo } from "@qone/protocol";
import type { AssistantPartRange } from "./assistant-part-ranges";
import { Reasoning } from "./reasoning";
import { ContextCompactionMarker } from "./context-compaction-marker";

type ToolMeta = { verb: { zh: string; en: string }; icon: ExecutionIcon };
type ToolPartState = Extract<PartState, { type: "tool-call" }>;
type SessionTimelineStep = TimelineStep & { target: string; fullTarget?: string; filePaths?: string[]; failed?: boolean; integration?: ToolIntegration };
const GenerativeUISurface = lazy(async () => ({ default: (await import("./generative-ui-block")).GenerativeUISurface }));

const TOOL_META: Record<string, ToolMeta> = {
  [ACTIVITY_TITLE_TOOL]: { verb: { zh: "更新执行阶段", en: "Update execution stage" }, icon: WrenchIcon },
  read: { verb: { zh: "读取", en: "Read" }, icon: FileSearchIcon },
  write: { verb: { zh: "写入", en: "Write" }, icon: PenLineIcon },
  edit: { verb: { zh: "编辑", en: "Edit" }, icon: PenLineIcon },
  apply_patch: { verb: { zh: "补丁", en: "Patch" }, icon: PenLineIcon },
  grep: { verb: { zh: "搜索", en: "Search" }, icon: SearchIcon },
  find: { verb: { zh: "查找", en: "Find" }, icon: SearchIcon },
  glob: { verb: { zh: "查找", en: "Find" }, icon: SearchIcon },
  ls: { verb: { zh: "查看", en: "List" }, icon: FileSearchIcon },
  bash: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon },
  powershell: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon },
  shell: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon },
  exec: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon },
  web_search: { verb: { zh: "搜索网页", en: "Search the web" }, icon: SearchIcon },
  web_fetch: { verb: { zh: "读取网页", en: "Read a web page" }, icon: FileSearchIcon },
};

function toStep(part: ToolPartState, locale: Locale, call: StoreToolCall | undefined, servers: readonly McpServerInfo[]): SessionTimelineStep {
  const meta = Object.hasOwn(TOOL_META, part.toolName) ? TOOL_META[part.toolName] : undefined;
  const integration = toolIntegration(part.toolName, servers, locale);
  const verb = meta?.verb[locale === "en" ? "en" : "zh"] ?? integration?.name ?? part.toolName;
  const target = toolTarget(part, call);
  const fullTarget = toolFullTarget(part, call);
  const done = call?.status === "success" || (call === undefined && part.result !== undefined && !part.isError);
  const result = call?.result ?? part.result;
  const baseCategory = toolActivityCategory(part.toolName, result);
  const category = baseCategory === "tool" && isIntegrationTool(part.toolName) ? "integration" : baseCategory;
  const filePaths = category === "file-change" && result !== undefined
    ? toolFileChanges(result).map((change) => change.path)
    : [];
  return { id: part.toolCallId, verb, target, chip: target, fullTarget, icon: integration ? integrationIcon(integration) : category === "file-change" ? PenLineIcon : meta?.icon ?? WrenchIcon, done, category, integration, filePaths, failed: toolCallStatus(part, call) === "failed" };
}

const ToolCallEntry: FC<{ part: ToolPartState; step: SessionTimelineStep; prepared?: boolean; showIcon?: boolean; messageRunning: boolean }> = ({ part, step, prepared = false, showIcon = false, messageRunning }) => {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const call = useConversationStore((state) => state.toolCalls.find((item) => item.toolCallId === part.toolCallId));
  const messageId = useAuiState((state) => state.message.id);
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const parentRunId = useConversationStore((state) => messageId === "streaming" ? state.activeRunId : state.messages.find((message) => message.id === messageId)?.runId);
  const subagents = useConversationStore((state) => state.subagents);
  const subagent = subagentForTool(part, call?.args, subagents, sessionId, parentRunId);
  const status = toolActivity(part, call, prepared, messageRunning);
  const failed = String(status) === "failed";
  const result = call?.result !== undefined ? call.result : part.result !== undefined ? part.result : call?.summary;
  const args = useDeferredValue(call?.args ?? part.args);
  const fileActivities = useMemo(() => toolFileActivities(part.toolName, result, args, status), [part.toolName, result, args, status]);
  const normalizedResult = useMemo(() => result !== undefined ? detectToolPresentation(part.toolName, result, failed ? undefined : args) : undefined, [part.toolName, result, args, failed]);
  const livePresentation = useMemo(() => detectToolPreview(part.toolName, args), [part.toolName, args]);
  const presentation = normalizedResult ?? (status !== "success" && status !== "failed" ? livePresentation : undefined);
  const editing = livePresentation?.kind === "diff" || livePresentation?.kind === "file" || step.icon === PenLineIcon;
  const operationLabels = toolOperationLabels(part, step.verb, locale);
  const activeLabel = status === "generating"
    ? editing ? t("chat.toolGeneratingEdit") : toolPreparationLabel(part, step, locale)
    : status === "queued" ? t("chat.toolQueued")
      : status === "waiting" ? t("chat.toolApprovalPending")
        : editing ? t("chat.toolApplyingEdit")
          : step.integration ? t("chat.toolUsingIntegration", { name: step.integration.name })
            : operationLabels.active;
  const preview = editing && status !== "success" && status !== "failed";
  const presentationText = presentation ? toolPresentationSummary(presentation, locale) : undefined;
  const resultText = toolResultText(
    presentationText,
    result,
    status === "waiting" ? t("chat.toolApprovalPending")
      : status === "failed" ? t("chat.toolFailed")
        : status === "success" ? t("chat.toolNoResult") : t("chat.toolResultPending"),
  );
  const stat = useMemo(() => presentation && status === "success" ? toolDiffStats(presentation) : undefined, [presentation, status]);

  // A failed mutation must not be presented as an applied diff.
  const visiblePresentation = failed && presentation?.kind === "diff" ? undefined : presentation;
  const visibleResultText = failed && !visiblePresentation && presentation?.kind === "diff"
    ? t("chat.toolFailed") : resultText;

  if (fileActivities.length) return <div className="flex min-w-0 flex-1 flex-col gap-2">
    {fileActivities.map((activity, index) => <FileChangeActivityRow key={`${activity.path}-${index}`} activity={activity}
      status={status} operation={part.toolName} activeLabel={activeLabel} fallbackText={resultText} showIcon={showIcon} />)}
  </div>;

  return (
    <ToolCall
      icon={showIcon ? step.icon : undefined}
      label={status === "queued" || status === "waiting" ? activeLabel : failed ? t("chat.toolActionFailed", { operation: step.integration?.name ?? step.verb })
        : step.integration ? t(step.integration.kind === "source" ? "chat.toolGroupSource" : "chat.toolGroupIntegrationOne", { sources: step.integration.name }) : operationLabels.completed}
      activeLabel={activeLabel}
      query={step.chip}
      fullTarget={step.fullTarget}
      targetAction={subagent && sessionId ? {
        label: subagent.title,
        ariaLabel: locale === "zh-CN" ? `打开子代理：${subagent.title}` : `Open subagent: ${subagent.title}`,
        onClick: () => openSubagent(subagent.id, sessionId),
      } : undefined}
      stat={stat && (stat.added > 0 || stat.removed > 0) ? stat : undefined}
      request={formatToolPayload(call?.argsText || part.argsText || part.args)}
      resultHasOwnFrame={visiblePresentation !== undefined && visiblePresentation.kind !== "text"}
      result={<>
        {preview && <p className="mb-2 text-xs text-foreground/50">{t("chat.toolPreview")}</p>}
        {visiblePresentation ? <ToolResultView presentation={visiblePresentation} emptyText={status === "success" ? t("chat.toolNoResult") : failed ? t("chat.toolFailed") : status === "waiting" ? t("chat.toolApprovalPending") : t("chat.toolResultPending")} /> : <span className="px-1 py-1 text-xs text-foreground/70">{status === "success" || failed ? visibleResultText : activeLabel}</span>}
      </>}
      running={status === "running" || status === "generating"}
      pending={status === "queued" || status === "generating"}
      waiting={status === "waiting"}
      failed={failed}
      requestLabel={t("chat.toolRequest")}
      resultLabel={t("chat.toolResult")}
      open={open}
      onOpenChange={setOpen}
      className="min-w-0 max-w-none flex-1"
    />
  );
};

export const SessionTimeline: FC<{ startIndex: number; endIndex: number; activityRanges?: readonly AssistantPartRange[]; title?: string }> = ({ startIndex, endIndex, activityRanges, title }) => {
  const { locale, t } = useLocale();
  const [runningClosed, setRunningClosed] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  // `useAuiState` compares selected values by reference. Select the stable
  // parts array first, then derive the filtered list during render; filtering
  // inside the selector would return a new array forever and trigger React's
  // maximum update depth guard.
  const parts = useAuiState((state) => state.message.parts);
  const messageRunning = useAuiState((state) => state.message.status?.type === "running");
  const toolParts = useMemo(
    () => parts.slice(startIndex, endIndex).filter((part): part is ToolPartState => part.type === "tool-call" && (part.toolName !== "present" || Boolean(part.isError))),
    [parts, startIndex, endIndex],
  );
  const liveToolCalls = useConversationStore((state) => state.toolCalls);
  const mcpServers = useConversationStore((state) => state.mcpServers);
  const preparedToolCallIds = useConversationStore((state) => state.preparedToolCallIds);
  const preparedIds = useMemo(() => new Set(preparedToolCallIds), [preparedToolCallIds]);
  const liveCallsById = useMemo(
    () => new Map(liveToolCalls.map((call) => [call.toolCallId, call])),
    [liveToolCalls],
  );
  // Show the row from block start, including while arguments are generated.
  const executedToolParts = useMemo(() => toolParts.filter((part) =>
    part.toolName !== ACTIVITY_TITLE_TOOL || toolCallStatus(part, liveCallsById.get(part.toolCallId)) === "failed"
  ), [toolParts, liveCallsById]);
  const steps = useMemo(
    () => executedToolParts.map((part) => toStep(part, locale, liveCallsById.get(part.toolCallId), mcpServers)),
    [executedToolParts, liveCallsById, locale, mcpServers],
  );
  const activeIndex = useMemo(
    () => selectActiveToolIndex(executedToolParts, liveCallsById, preparedIds, messageRunning),
    [executedToolParts, liveCallsById, preparedIds, messageRunning],
  );
  const toolWorking = activeIndex >= 0;
  const lastRange = activityRanges?.at(-1);
  const lastPart = lastRange?.type === "reasoning" ? parts[lastRange.index] : undefined;
  const thinking = !toolWorking && messageRunning && lastPart?.type === "reasoning" && Boolean(lastPart.text.trim()) && lastPart.status.type === "running";
  const awaitingStageWork = Boolean(title) && messageRunning && endIndex === parts.length;
  const stageCompacting = Boolean(title) && activityRanges?.some((range) => range.type === "compaction" && range.marker.status === "running");
  const working = toolWorking || thinking || awaitingStageWork || Boolean(stageCompacting);
  const open = working ? !runningClosed : completedOpen;
  const setOpen = (nextOpen: boolean) => {
    if (working) setRunningClosed(!nextOpen);
    else setCompletedOpen(nextOpen);
  };
  const activePart = activeIndex >= 0 ? executedToolParts[activeIndex] : undefined;
  const activeStep = activeIndex >= 0 ? steps[activeIndex] : undefined;
  const activeCall = activePart ? liveCallsById.get(activePart.toolCallId) : undefined;
  const lastIndex = steps.length - 1;
  const lastStep = lastIndex >= 0 ? steps[lastIndex] : undefined;
  const summaryStep = steps.find((step) => step.integration) ?? lastStep;
  const headerStat = useMemo(() => {
    const changes = collectToolFileChanges(executedToolParts.map((part) => {
      const call = liveCallsById.get(part.toolCallId);
      return { toolName: part.toolName, args: call?.args ?? part.args, result: call?.result ?? part.result, status: toolCallStatus(part, call) };
    }));
    return changes.nodes.length ? { added: changes.totalAdditions, removed: changes.totalDeletions } : undefined;
  }, [executedToolParts, liveCallsById]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activeCall || activeCall.status !== "running" || activeCall.startedAt === undefined) return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [activeCall?.startedAt, activeCall?.status, activeCall?.toolCallId]);

  const restingLabel = toolGroupSummary(steps, locale);
  const activity = activePart ? toolActivity(activePart, activeCall, preparedIds.has(activePart.toolCallId), messageRunning) : undefined;
  const describeActive = (part: ToolPartState, step: SessionTimelineStep) => activity === "generating"
    ? [step.category === "file-change" ? t("chat.toolGeneratingEdit") : toolPreparationLabel(part, step, locale), step.target].filter(Boolean).join(" · ")
    : activity === "queued" ? [t("chat.toolQueued"), step.target].filter(Boolean).join(" · ")
      : activity === "waiting" ? [t("chat.toolApprovalPending"), step.target].filter(Boolean).join(" · ")
        : toolActionSummary(part, step, activeCall, true, now, locale);
  const activeLabel = thinking ? t("chat.reasoningActive") : activePart && activeStep ? describeActive(activePart, activeStep) : "";
  const fullSummary = toolGroupSummary(steps, locale, { fullTargets: true });
  const fullActiveLabel = activePart && activeStep
    ? describeActive(activePart, { ...activeStep, target: activeStep.fullTarget ?? activeStep.target })
    : thinking ? activeLabel : fullSummary;

  const stepsById = useMemo(() => new Map(steps.map((step, index) => [step.id, index])), [steps]);
  const details = activityRanges?.flatMap((range) => {
    if (range.type === "reasoning") return [<MessagePrimitive.PartByIndex key={`reasoning-${range.index}`} index={range.index} components={{ Reasoning }} />];
    if (range.type === "compaction") return [<ContextCompactionMarker key={range.marker.id} {...range.marker} />];
    if (range.type !== "tools") return [];
    return parts.slice(range.startIndex, range.endIndex).flatMap((part) => {
      if (part.type !== "tool-call") return [];
      const index = stepsById.get(part.toolCallId);
      if (index === undefined) return [];
      return [<ToolTimelineRow key={part.toolCallId} step={steps[index]}>
        <ToolCallEntry part={part} step={steps[index]} prepared={preparedIds.has(part.toolCallId)} messageRunning={messageRunning} />
      </ToolTimelineRow>];
    });
  });

  if (steps.length === 0 && !title) return null;

  if (steps.length === 1 && !title) {
    const part = executedToolParts[0];
    return <ToolCallEntry showIcon part={part} step={steps[0]} prepared={preparedIds.has(part.toolCallId)} messageRunning={messageRunning} />;
  }

  return (
    <ToolTimeline
      steps={steps}
      visibleSteps={steps.length}
      streaming={working}
      open={open}
      onOpenChange={setOpen}
      restingLabel={title ?? restingLabel}
      fullSummary={title ?? fullSummary}
      fullActiveLabel={title ?? fullActiveLabel}
      activeLabel={title ?? activeLabel}
      headerIcon={title || thinking ? undefined : (toolWorking ? activeStep : undefined)?.icon ?? summaryStep?.icon}
      headerStat={title ? undefined : headerStat}
      canExpand={steps.length > 0 || Boolean(details?.length)}
      failureLabel={title && steps.some((step) => step.failed) ? t("chat.toolGroupFailedMany", { count: steps.filter((step) => step.failed).length }) : undefined}
      stats={[]}
      renderStep={(_, index) => <ToolCallEntry part={executedToolParts[index]} step={steps[index]} prepared={preparedIds.has(executedToolParts[index]?.toolCallId ?? "")} messageRunning={messageRunning} />}
      children={details}
      className="q-tool-timeline max-w-2xl"
    />
  );
};

export const GenerativeUIPresentation: FC<{ index: number }> = ({ index }) => {
  const part = useAuiState((state) => state.message.parts[index]);
  if (part?.type !== "tool-call" || part.toolName !== "present" || part.isError) return null;
  return <Suspense fallback={null}><GenerativeUISurface spec={part.args} /></Suspense>;
};
