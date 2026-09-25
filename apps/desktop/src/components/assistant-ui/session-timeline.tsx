import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useState, type FC } from "react";
import {
  FileSearchIcon,
  PenLineIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { useAuiState, type PartState } from "@assistant-ui/react";
import {
  ToolTimeline,
  type TimelineStep,
} from "./elements/tool-timeline";
import { ToolCall } from "./elements/tool-call";
import { ToolError } from "./elements/tool-error";
import { ToolResultView } from "./elements/tool-result";
import { formatToolPayload, toolActivity } from "./tool-call-display";
import { detectToolPreview } from "./tool-preview";
import { toolActionSummary, toolTarget } from "./tool-action-summary";
import { detectToolPresentation, toolDiffStats, toolPresentationSummary } from "./tool-presentation";
import { useLocale } from "../../localization";
import { formatDuration } from "../../lib/utils";
import { useStore, type ToolCall as StoreToolCall } from "../../store";

type ToolMeta = { verb: { zh: string; en: string }; icon: LucideIcon; tint: string };
type ToolPartState = Extract<PartState, { type: "tool-call" }>;
type SessionTimelineStep = TimelineStep & { target: string };
const GenerativeUISurface = lazy(async () => ({ default: (await import("./generative-ui-block")).GenerativeUISurface }));

const TOOL_META: Record<string, ToolMeta> = {
  read: { verb: { zh: "读取", en: "Read" }, icon: FileSearchIcon, tint: "text-sky-500 dark:text-sky-400" },
  write: { verb: { zh: "写入", en: "Write" }, icon: PenLineIcon, tint: "text-emerald-500 dark:text-emerald-400" },
  edit: { verb: { zh: "编辑", en: "Edit" }, icon: PenLineIcon, tint: "text-amber-500 dark:text-amber-400" },
  apply_patch: { verb: { zh: "补丁", en: "Patch" }, icon: PenLineIcon, tint: "text-amber-500 dark:text-amber-400" },
  grep: { verb: { zh: "搜索", en: "Search" }, icon: SearchIcon, tint: "text-cyan-500 dark:text-cyan-400" },
  find: { verb: { zh: "查找", en: "Find" }, icon: SearchIcon, tint: "text-teal-500 dark:text-teal-400" },
  glob: { verb: { zh: "查找", en: "Find" }, icon: SearchIcon, tint: "text-teal-500 dark:text-teal-400" },
  ls: { verb: { zh: "查看", en: "List" }, icon: FileSearchIcon, tint: "text-indigo-500 dark:text-indigo-400" },
  bash: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon, tint: "text-lime-500 dark:text-lime-400" },
  powershell: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon, tint: "text-blue-500 dark:text-blue-400" },
  shell: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon, tint: "text-lime-500 dark:text-lime-400" },
  exec: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon, tint: "text-lime-500 dark:text-lime-400" },
  web_search: { verb: { zh: "联网", en: "Search" }, icon: SearchIcon, tint: "text-violet-500 dark:text-violet-400" },
  web_fetch: { verb: { zh: "联网", en: "Fetch" }, icon: FileSearchIcon, tint: "text-violet-500 dark:text-violet-400" },
};
const FALLBACK_TINT = "text-foreground/60";

function toStep(part: ToolPartState, locale: string, call?: StoreToolCall): SessionTimelineStep {
  const meta = TOOL_META[part.toolName];
  const verb = meta?.verb[locale === "en" ? "en" : "zh"] ?? (locale === "en" ? "Call" : "调用");
  const target = toolTarget(part, call);
  const done = call?.status === "success" || (call === undefined && part.result !== undefined && !part.isError);
  return { id: part.toolCallId, verb, target, chip: target, icon: meta?.icon ?? WrenchIcon, tint: meta?.tint ?? FALLBACK_TINT, done };
}

const ToolCallEntry: FC<{ part: ToolPartState; step: SessionTimelineStep; prepared?: boolean; messageRunning: boolean }> = ({ part, step, prepared = false, messageRunning }) => {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const call = useStore((state) => state.toolCalls.find((item) => item.toolCallId === part.toolCallId));
  const status = toolActivity(part, call, prepared, messageRunning);
  const failed = String(status) === "failed";
  const result = call?.result !== undefined ? call.result : part.result !== undefined ? part.result : call?.summary;
  const formattedResult = formatToolPayload(result);
  const args = useDeferredValue(call?.args ?? part.args);
  const normalizedResult = useMemo(() => result !== undefined ? detectToolPresentation(result, failed ? undefined : args) : undefined, [result, args, failed]);
  const livePresentation = useMemo(() => detectToolPreview(args), [args]);
  const presentation = normalizedResult ?? (status !== "success" && status !== "failed" ? livePresentation : undefined);
  const editing = livePresentation?.kind === "diff" || livePresentation?.kind === "file" || step.icon === PenLineIcon;
  const activeLabel = status === "generating"
    ? editing ? t("chat.toolGeneratingEdit") : t("chat.toolGenerating", { operation: step.verb })
    : status === "queued" ? t("chat.toolQueued")
      : status === "waiting" ? t("chat.toolApprovalPending")
        : editing ? t("chat.toolApplyingEdit") : t("chat.toolWorking");
  const preview = editing && status !== "success" && status !== "failed";
  const resultText = presentation
    ? toolPresentationSummary(presentation)
    : formattedResult
      ? formattedResult
      : status === "waiting" ? t("chat.toolApprovalPending")
        : status === "failed" ? t("chat.toolFailed")
          : status === "success" ? t("chat.toolNoResult") : t("chat.toolResultPending");
  const stat = useMemo(() => presentation && status === "success" ? toolDiffStats(presentation) : undefined, [presentation, status]);

  if (status === "failed") return (
    <ToolError
      name={part.toolName}
      target={step.chip}
      message={presentation?.kind === "diff" ? t("chat.toolFailed") : resultText}
      className="min-w-0 max-w-none flex-1"
    />
  );

  return (
    <ToolCall
      label={status === "queued" || status === "waiting" ? activeLabel : locale === "en" ? part.toolName : step.verb}
      activeLabel={activeLabel}
      query={step.chip}
      stat={stat && (stat.added > 0 || stat.removed > 0) ? stat : undefined}
      request={formatToolPayload(call?.argsText || part.argsText || part.args)}
      result={<>
        {preview && <p className="mb-2 text-xs text-foreground/50">{t("chat.toolPreview")}</p>}
        {presentation ? <ToolResultView presentation={presentation} /> : <span className="px-1 py-1 text-xs text-foreground/70">{status === "success" ? resultText : activeLabel}</span>}
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

export const SessionTimeline: FC<{ startIndex: number; endIndex: number }> = ({ startIndex, endIndex }) => {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
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
  const liveToolCalls = useStore((state) => state.toolCalls);
  const preparedToolCallIds = useStore((state) => state.preparedToolCallIds);
  const preparedIds = useMemo(() => new Set(preparedToolCallIds), [preparedToolCallIds]);
  const liveCallsById = useMemo(
    () => new Map(liveToolCalls.map((call) => [call.toolCallId, call])),
    [liveToolCalls],
  );
  // Show the row from block start, including while arguments are generated.
  const executedToolParts = toolParts;
  const steps = useMemo(
    () => executedToolParts.map((part) => toStep(part, locale, liveCallsById.get(part.toolCallId))),
    [executedToolParts, liveCallsById, locale],
  );
  const activeIndex = useMemo(() => {
    for (let index = executedToolParts.length - 1; index >= 0; index--) {
      const call = liveCallsById.get(executedToolParts[index]?.toolCallId ?? "");
      if (call?.status === "running" || call?.status === "waiting") return index;
    }
    return executedToolParts.findIndex((part) => {
      const activity = toolActivity(part, liveCallsById.get(part.toolCallId), preparedIds.has(part.toolCallId), messageRunning);
      return activity === "generating" || activity === "queued";
    });
  }, [executedToolParts, liveCallsById, preparedIds, messageRunning]);
  const toolWorking = activeIndex >= 0;
  const activePart = activeIndex >= 0 ? executedToolParts[activeIndex] : undefined;
  const activeStep = activeIndex >= 0 ? steps[activeIndex] : undefined;
  const activeCall = activePart ? liveCallsById.get(activePart.toolCallId) : undefined;
  const lastIndex = steps.length - 1;
  const lastStep = lastIndex >= 0 ? steps[lastIndex] : undefined;
  const lastPart = lastIndex >= 0 ? executedToolParts[lastIndex] : undefined;
  const lastCall = lastPart ? liveCallsById.get(lastPart.toolCallId) : undefined;
  const headerPart = toolWorking ? activePart : lastPart;
  const headerCall = toolWorking ? activeCall : lastCall;
  const headerResult = headerCall?.result !== undefined ? headerCall.result : headerPart?.result;
  const headerStat = headerResult !== undefined
    ? toolDiffStats(detectToolPresentation(headerResult, headerCall?.args ?? headerPart?.args))
    : undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activeCall || activeCall.status !== "running" || activeCall.startedAt === undefined) return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [activeCall?.startedAt, activeCall?.status, activeCall?.toolCallId]);

  const regionOpen = messageRunning && endIndex === parts.length;
  const summaryLabel = lastStep
    ? toolActionSummary(lastPart!, lastStep, lastCall, false, now, locale)
    : "";
  const regionElapsed = useMemo(() => {
    let start = Infinity;
    let end = 0;
    for (const part of executedToolParts) {
      const call = liveCallsById.get(part.toolCallId);
      if (call?.startedAt !== undefined && Number.isFinite(call.startedAt)) start = Math.min(start, call.startedAt);
      if (call?.completedAt !== undefined && Number.isFinite(call.completedAt)) end = Math.max(end, call.completedAt);
    }
    return start !== Infinity && end > start ? Math.max(1, Math.round((end - start) / 1000)) : undefined;
  }, [executedToolParts, liveCallsById]);
  const activity = activePart ? toolActivity(activePart, activeCall, preparedIds.has(activePart.toolCallId), messageRunning) : undefined;
  const activeLabel = activePart && activeStep
    ? activity === "generating"
      ? `${t("chat.toolGenerating", { operation: activeStep.verb })} · ${activeStep.target}`
      : activity === "queued" ? `${t("chat.toolQueued")} · ${activeStep.target}`
        : activity === "waiting" ? `${t("chat.toolApprovalPending")} · ${activeStep.target}`
          : toolActionSummary(activePart, activeStep, activeCall, true, now, locale)
    : regionOpen ? summaryLabel : "";
  const restingLabel = !messageRunning && regionElapsed !== undefined
    ? t("chat.toolRegionElapsed", { duration: formatDuration(regionElapsed, locale) })
    : summaryLabel;

  if (steps.length === 0) return null;

  if (steps.length === 1) {
    const part = executedToolParts[0];
    return <ToolCallEntry part={part} step={steps[0]} prepared={preparedIds.has(part.toolCallId)} messageRunning={messageRunning} />;
  }

  return (
    <ToolTimeline
      steps={steps}
      visibleSteps={steps.length}
      streaming={toolWorking || regionOpen}
      open={open}
      onOpenChange={setOpen}
      restingLabel={restingLabel}
      activeLabel={activeLabel}
      headerIcon={(activeStep ?? lastStep)?.icon}
      headerTint={toolWorking ? undefined : lastStep?.tint}
      headerStat={headerStat}
      stats={[]}
      renderStep={(_, index) => <ToolCallEntry part={executedToolParts[index]} step={steps[index]} prepared={preparedIds.has(executedToolParts[index]?.toolCallId ?? "")} messageRunning={messageRunning} />}
      className="q-tool-timeline max-w-2xl"
    />
  );
};

export const GenerativeUIPresentation: FC<{ index: number }> = ({ index }) => {
  const part = useAuiState((state) => state.message.parts[index]);
  if (part?.type !== "tool-call" || part.toolName !== "present" || part.isError) return null;
  return <Suspense fallback={null}><GenerativeUISurface spec={part.args} /></Suspense>;
};
