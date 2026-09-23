import { lazy, Suspense, useMemo, useState, type FC } from "react";
import {
  FileSearchIcon,
  GlobeIcon,
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
import { formatToolPayload, toolCallStatus } from "./tool-call-display";
import { useLocale } from "../../localization";
import { useStore } from "../../store";

type ToolMeta = { verb: string; icon: LucideIcon };
type ToolPartState = Extract<PartState, { type: "tool-call" }>;
const GenerativeUISurface = lazy(async () => ({ default: (await import("./generative-ui-block")).GenerativeUISurface }));

const TOOL_META: Record<string, ToolMeta> = {
  read: { verb: "读取", icon: FileSearchIcon },
  write: { verb: "写入", icon: PenLineIcon },
  edit: { verb: "编辑", icon: PenLineIcon },
  grep: { verb: "搜索", icon: SearchIcon },
  find: { verb: "查找", icon: SearchIcon },
  ls: { verb: "查看", icon: FileSearchIcon },
  powershell: { verb: "运行", icon: TerminalIcon },
  "browser.open": { verb: "打开", icon: GlobeIcon },
  "browser.inspect": { verb: "检查", icon: GlobeIcon },
};

function asArgs(part: ToolPartState): Record<string, unknown> {
  return part.args && typeof part.args === "object" && !Array.isArray(part.args)
    ? part.args as Record<string, unknown>
    : {};
}

function firstString(values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function toStep(part: ToolPartState, index: number): TimelineStep {
  const meta = TOOL_META[part.toolName] ?? (part.toolName.startsWith("browser.") ? { verb: "浏览", icon: GlobeIcon } : { verb: "调用", icon: WrenchIcon });
  const args = asArgs(part);
  const target = firstString([
    args.path,
    args.file,
    args.command,
    args.pattern,
    args.query,
    args.url,
    args.name,
  ]) ?? part.toolName;
  return { verb: meta.verb, chip: `${target} · ${index + 1}`, icon: meta.icon };
}

const ToolCallEntry: FC<{ part: ToolPartState; step: TimelineStep }> = ({ part, step }) => {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const call = useStore((state) => state.toolCalls.find((item) => item.toolCallId === part.toolCallId));
  const status = toolCallStatus(part, call);
  const failed = String(status) === "failed";
  const result = call?.result !== undefined ? call.result : part.result !== undefined ? part.result : call?.summary;
  const formattedResult = formatToolPayload(result);
  const resultText = formattedResult
    ? formattedResult
    : status === "waiting" ? t("chat.toolApprovalPending")
      : status === "failed" ? t("chat.toolFailed")
        : status === "success" ? t("chat.toolNoResult") : t("chat.toolResultPending");
  const command = firstString([asArgs(part).command]);
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

  if (part.toolName === "powershell" && command && status !== "waiting") return (
    <CodeRunner
      language="PowerShell"
      code={command}
      state={status === "running" ? "running" : "ok"}
      output={status === "running" && !formattedResult ? [] : resultText.split(/\r?\n/)}
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
      result={resultText}
      running={status === "running"}
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

export const SessionTimeline: FC = () => {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  // `useAuiState` compares selected values by reference. Select the stable
  // parts array first, then derive the filtered list during render; filtering
  // inside the selector would return a new array forever and trigger React's
  // maximum update depth guard.
  const parts = useAuiState((state) => state.message.parts);
  const toolCalls = useMemo(
    () => parts.filter((part): part is ToolPartState => part.type === "tool-call" && (part.toolName !== "present" || Boolean(part.isError))),
    [parts],
  );
  const streaming = useAuiState((state) => state.message.status?.type === "running");
  const steps = useMemo(() => toolCalls.map(toStep), [toolCalls]);
  const toolWorking = streaming && toolCalls.some((part) => part.result === undefined && !part.isError);

  if (steps.length === 0) return null;

  return (
    <ToolTimeline
      steps={steps}
      visibleSteps={steps.length}
      streaming={toolWorking}
      open={open}
      onOpenChange={setOpen}
      restingLabel={t("chat.toolSteps", { count: steps.length })}
      activeLabel={t("chat.toolWorking")}
      stats={[]}
      renderStep={(_, index) => <ToolCallEntry part={toolCalls[index]} step={steps[index]} />}
      className="q-tool-timeline max-w-2xl"
    />
  );
};

export const GenerativeUIPresentations: FC = () => {
  const parts = useAuiState((state) => state.message.parts);
  const presentations = useMemo(
    () => parts.filter((part): part is ToolPartState => part.type === "tool-call" && part.toolName === "present" && !Boolean(part.isError)),
    [parts],
  );
  if (presentations.length === 0) return null;
  return <Suspense fallback={null}>{presentations.map((part) => <GenerativeUISurface key={part.toolCallId} spec={part.args} />)}</Suspense>;
};
