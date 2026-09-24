import { lazy, Suspense, useEffect, useMemo, useState, type FC } from "react";
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
import { CodeRunner } from "./elements/code-runner";
import { ToolResultView } from "./elements/tool-result";
import { formatToolPayload, toolCallStatus } from "./tool-call-display";
import { toolActionSummary, toolTarget } from "./tool-action-summary";
import { detectToolPresentation, toolPresentationSummary } from "./tool-presentation";
import { useLocale } from "../../localization";
import { useStore, type ToolCall as StoreToolCall } from "../../store";

type ToolMeta = { verb: { zh: string; en: string }; icon: LucideIcon };
type ToolPartState = Extract<PartState, { type: "tool-call" }>;
const GenerativeUISurface = lazy(async () => ({ default: (await import("./generative-ui-block")).GenerativeUISurface }));

const TOOL_META: Record<string, ToolMeta> = {
  read: { verb: { zh: "读取", en: "Read" }, icon: FileSearchIcon },
  write: { verb: { zh: "写入", en: "Write" }, icon: PenLineIcon },
  edit: { verb: { zh: "编辑", en: "Edit" }, icon: PenLineIcon },
  grep: { verb: { zh: "搜索", en: "Search" }, icon: SearchIcon },
  find: { verb: { zh: "查找", en: "Find" }, icon: SearchIcon },
  ls: { verb: { zh: "查看", en: "List" }, icon: FileSearchIcon },
  bash: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon },
  powershell: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon },
  shell: { verb: { zh: "运行", en: "Run" }, icon: TerminalIcon },
};

function toStep(part: ToolPartState, index: number, locale: string, call?: StoreToolCall): TimelineStep {
  const meta = TOOL_META[part.toolName];
  const verb = meta?.verb[locale === "en" ? "en" : "zh"] ?? (locale === "en" ? "Call" : "调用");
  const target = toolTarget(part, call);
  return { verb, target, chip: `${target} · ${index + 1}`, icon: meta?.icon ?? WrenchIcon };
}

const ToolCallEntry: FC<{ part: ToolPartState; step: TimelineStep; prepared?: boolean }> = ({ part, step, prepared = false }) => {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const call = useStore((state) => state.toolCalls.find((item) => item.toolCallId === part.toolCallId));
  const status = toolCallStatus(part, call);
  const failed = String(status) === "failed";
  const result = call?.result !== undefined ? call.result : part.result !== undefined ? part.result : call?.summary;
  const formattedResult = formatToolPayload(result);
  const args = call?.args ?? part.args;
  const normalizedResult = result !== undefined ? detectToolPresentation(result, args) : undefined;
  const livePresentation = result === undefined ? detectToolPresentation(undefined, args) : undefined;
  const presentation = normalizedResult ?? (livePresentation?.kind === "terminal" ? livePresentation : undefined);
  const resultText = presentation
    ? toolPresentationSummary(presentation)
    : formattedResult
      ? formattedResult
      : status === "waiting" ? t("chat.toolApprovalPending")
        : status === "failed" ? t("chat.toolFailed")
          : status === "success" ? t("chat.toolNoResult") : t("chat.toolResultPending");
  const command = presentation?.kind === "terminal" ? presentation.command : undefined;
  const durationMs = call?.startedAt !== undefined && call.completedAt !== undefined
    ? Math.max(0, call.completedAt - call.startedAt)
    : undefined;

  if (status === "failed") return (
    <ToolError
      name={part.toolName}
      target={step.chip}
      message={resultText}
      className="min-w-0 max-w-none flex-1"
    />
  );

  if (presentation?.kind === "terminal" && command && (prepared || status === "running")) return (
    <CodeRunner
      language="Terminal"
      code={command}
      state={prepared ? "idle" : status === "running" ? "running" : "ok"}
      output={prepared || status === "running" && !formattedResult ? [] : resultText.split(/\r?\n/)}
      durationMs={durationMs}
      className="min-w-0 max-w-none flex-1"
    />
  );

  return (
    <ToolCall
      label={locale === "en" ? part.toolName : step.verb}
      activeLabel={t("chat.toolWorking")}
      query={step.chip}
      request={formatToolPayload(call?.argsText || part.argsText || part.args)}
      result={presentation ? <ToolResultView presentation={presentation} /> : <span className="px-1 py-1 text-xs text-foreground/70">{resultText}</span>}
      running={status === "running" && !prepared}
      pending={prepared}
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
  const executedToolParts = useMemo(
    () => toolParts.filter((part) => !messageRunning || liveCallsById.has(part.toolCallId) || part.result !== undefined || part.isError || preparedIds.has(part.toolCallId)),
    [liveCallsById, messageRunning, preparedIds, toolParts],
  );
  const pendingToolParts = useMemo(
    () => messageRunning
      ? toolParts.filter((part) => !liveCallsById.has(part.toolCallId) && part.result === undefined && !part.isError)
      : [],
    [liveCallsById, messageRunning, toolParts],
  );
  const steps = useMemo(
    () => executedToolParts.map((part, index) => toStep(part, index, locale, liveCallsById.get(part.toolCallId))),
    [executedToolParts, liveCallsById, locale],
  );
  const activeIndex = useMemo(() => {
    for (let index = executedToolParts.length - 1; index >= 0; index--) {
      const call = liveCallsById.get(executedToolParts[index]?.toolCallId ?? "");
      if (call?.status === "running" || call?.status === "waiting") return index;
    }
    return -1;
  }, [executedToolParts, liveCallsById]);
  const toolWorking = activeIndex >= 0;
  const activePart = activeIndex >= 0 ? executedToolParts[activeIndex] : undefined;
  const activeStep = activeIndex >= 0 ? steps[activeIndex] : undefined;
  const activeCall = activePart ? liveCallsById.get(activePart.toolCallId) : undefined;
  const lastIndex = steps.length - 1;
  const lastStep = lastIndex >= 0 ? steps[lastIndex] : undefined;
  const lastPart = lastIndex >= 0 ? executedToolParts[lastIndex] : undefined;
  const lastCall = lastPart ? liveCallsById.get(lastPart.toolCallId) : undefined;
  const pendingPart = pendingToolParts[0];
  const pendingKey = pendingPart?.toolCallId;
  const pendingPrepared = Boolean(pendingPart && preparedIds.has(pendingPart.toolCallId) && !liveCallsById.has(pendingPart.toolCallId));
  const preparedIndex = pendingPrepared
    ? executedToolParts.findIndex((part) => part.toolCallId === pendingPart?.toolCallId)
    : -1;
  const preparedStep = preparedIndex >= 0 ? steps[preparedIndex] : undefined;
  const [preparationKey, setPreparationKey] = useState<string>();

  useEffect(() => {
    if (!pendingKey) {
      setPreparationKey(undefined);
      return undefined;
    }
    const timer = setTimeout(() => setPreparationKey(pendingKey), 400);
    return () => clearTimeout(timer);
  }, [pendingKey]);

  const showingPreparation = pendingKey !== undefined && !pendingPrepared && preparationKey === pendingKey;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activeCall || activeCall.status !== "running" || activeCall.startedAt === undefined) return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [activeCall?.startedAt, activeCall?.status, activeCall?.toolCallId]);

  const activeLabel = toolWorking && activePart && activeStep
    ? toolActionSummary(activePart, activeStep, activeCall, true, now, locale)
    : pendingPrepared && pendingPart && preparedStep
      ? t("chat.toolSummaryPrepared", { operation: preparedStep.verb, target: preparedStep.target })
      : showingPreparation
        ? t("chat.toolPreparingNext")
        : t("chat.toolPreparingNext");
  const restingLabel = lastStep
    ? toolActionSummary(lastPart!, lastStep, lastCall, false, now, locale)
    : "";

  if (steps.length === 0 && !showingPreparation) return null;

  return (
    <ToolTimeline
      steps={steps}
      visibleSteps={steps.length}
      streaming={toolWorking || pendingPrepared || showingPreparation}
      activeStepIndex={activeIndex >= 0 ? activeIndex : preparedIndex >= 0 ? preparedIndex : undefined}
      open={open}
      onOpenChange={setOpen}
      restingLabel={restingLabel}
      activeLabel={activeLabel}
      stats={[]}
      renderStep={(_, index) => <ToolCallEntry part={executedToolParts[index]} step={steps[index]} prepared={preparedIds.has(executedToolParts[index]?.toolCallId ?? "")} />}
      className="q-tool-timeline max-w-2xl"
    />
  );
};

export const GenerativeUIPresentation: FC<{ index: number }> = ({ index }) => {
  const part = useAuiState((state) => state.message.parts[index]);
  if (part?.type !== "tool-call" || part.toolName !== "present" || part.isError) return null;
  return <Suspense fallback={null}><GenerativeUISurface spec={part.args} /></Suspense>;
};
