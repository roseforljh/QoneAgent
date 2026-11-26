import type { PartState } from "@assistant-ui/react";
import { useState } from "react";
import { attachmentFileKind } from "../../lib/attachment-file-kind";
import { conversationSession } from "../../lib/session-execution-state";
import { useConversationStore } from "../../lib/conversation-context";
import { fileTypeIconInfo } from "../../lib/markdown-file-icon";
import { openWorkspaceFile, resolveFileReferencePath } from "../../lib/workspace-file-navigation";
import { useLocale } from "../../localization";
import type { ToolCall as StoreToolCall } from "../../store";
import { CodexIcon } from "../ui/CodexIcon";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { WorkspacePathContextMenu } from "./dock-context-menu";
import { CodexClock3Icon, type ExecutionIcon } from "./execution-icons";
import { MeasuredCollapse } from "./elements/measured-collapse";
import { FadeScroll, ShimmerLabel, detailViewport } from "./elements/surfaces";
import { toolOperationLabels, toolPreparationLabel } from "./tool-action-summary";
import { toolActivity, toolResultText } from "./tool-call-display";

const DIRECT_FILE_READ_TOOLS = new Set(["read", "qone_video_use_file"]);

export interface FileReadTarget {
  rawPath: string;
  name: string;
  mimeType?: string;
  line?: number;
  endLine?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function extractResultMimeType(result: unknown): string | undefined {
  const record = asRecord(result);
  const details = asRecord(record?.details);
  if (typeof details?.mimeType === "string" && details.mimeType.trim()) return details.mimeType.trim();
  const content = Array.isArray(record?.content) ? record.content : undefined;
  if (content) {
    for (const block of content) {
      const item = asRecord(block);
      if (item?.type === "image" && typeof item.mimeType === "string" && item.mimeType.trim()) {
        return item.mimeType.trim();
      }
    }
  }
  return undefined;
}

export function isFileReadTool(toolName: string): boolean {
  return DIRECT_FILE_READ_TOOLS.has(toolName);
}

/** 提取本地文件/媒体读取目标，用于单行文件按钮和右侧栏直达预览。 */
export function extractFileReadTarget(toolName: string, args: unknown, result: unknown): FileReadTarget | undefined {
  const argRecord = asRecord(args);
  const resultRecord = asRecord(result);
  const details = asRecord(resultRecord?.details);
  const candidate = [argRecord?.path, argRecord?.file, details?.path].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!candidate) return undefined;
  const rawPath = candidate.trim();
  const normalized = rawPath.replace(/[\\/]+$/, "");
  const name = normalized.split(/[\\/]/).at(-1) || normalized;
  const mimeType = extractResultMimeType(result);
  if (toolName !== "read") return { rawPath, name, mimeType };
  // 图片、音视频、PDF、办公文档与压缩包没有文本行号，忽略模型默认传的 offset/limit。
  const kind = attachmentFileKind(name, mimeType ?? "");
  const nonLineKind = kind === "image" || kind === "audio" || kind === "video" || kind === "pdf"
    || kind === "spreadsheet" || kind === "presentation" || kind === "archive" || kind === "folder"
    || /\.(?:docx?|odt|pages|rtf)$/i.test(name);
  if (nonLineKind) return { rawPath, name, mimeType };
  const offset = positiveInt(argRecord?.offset);
  const limit = positiveInt(argRecord?.limit);
  // 跳过整文件默认读取参数（例如模型默认传 offset=1, limit=2000），仅保留真实局部行号范围。
  const isDefaultWholeFileRead = offset === 1 && (limit === undefined || limit >= 1000);
  const line = offset && !isDefaultWholeFileRead ? offset : undefined;
  const endLine = line && limit && limit > 1 ? line + limit - 1 : undefined;
  return { rawPath, name, mimeType, line, endLine };
}

function fileButtonLabel(target: FileReadTarget): string {
  if (!target.line) return target.name;
  return target.endLine && target.endLine > target.line
    ? `${target.name}:${target.line}–${target.endLine}`
    : `${target.name}:${target.line}`;
}

export interface FileReadActivityRowProps {
  part: Extract<PartState, { type: "tool-call" }>;
  step: { verb: string; icon?: ExecutionIcon; integration?: { name: string } };
  call?: StoreToolCall;
  prepared?: boolean;
  showIcon?: boolean;
  messageRunning: boolean;
}

/** 读取文件/附件/文档时不再展开收起，改为单行展示并通过带类型图标的按钮单击打开右侧栏预览。 */
export function FileReadActivityRow({
  part,
  step,
  call,
  prepared = false,
  showIcon = false,
  messageRunning,
}: FileReadActivityRowProps) {
  const { locale, t } = useLocale();
  const [errorOpen, setErrorOpen] = useState(false);
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const workspace = useConversationStore((state) => {
    const workspaceId = conversationSession(state)?.workspaceId;
    return state.workspaces.find((item) => item.id === workspaceId);
  });

  const status = toolActivity(part, call, prepared, messageRunning);
  const running = status === "running" || status === "generating";
  const failed = status === "failed";
  const waiting = status === "waiting";
  const cancelled = status === "cancelled";

  const mergedArgs = { ...asRecord(part.args), ...asRecord(call?.args) };
  const result = call?.result !== undefined ? call.result : part.result !== undefined ? part.result : call?.summary;
  const target = extractFileReadTarget(part.toolName, mergedArgs, result);
  const fullPath = target ? resolveFileReferencePath(target.rawPath, workspace?.path) : undefined;
  const displayPath = fullPath ?? target?.rawPath;
  const canOpen = Boolean(fullPath);

  const labels = toolOperationLabels(part, step.verb, locale);
  const activeLabel = status === "generating"
    ? toolPreparationLabel(part, step, locale)
    : status === "queued" ? t("chat.toolQueued")
      : waiting ? t("chat.toolApprovalPending")
        : labels.active;
  const completedLabel = cancelled
    ? t("servers.view.cancelled")
    : failed ? t("chat.toolActionFailed", { operation: step.verb })
      : status === "queued" || waiting ? activeLabel
        : labels.completed;
  const statusLabel = running ? activeLabel : completedLabel;

  const navigate = canOpen && fullPath ? () => {
    openWorkspaceFile({
      sessionId: sessionId ?? undefined,
      workspaceId: workspace?.id,
      path: fullPath,
      line: target?.line,
      endLine: target?.endLine,
    });
  } : undefined;

  const iconInfo = target ? fileTypeIconInfo(displayPath ?? target.name, target.mimeType ?? "") : undefined;
  const buttonText = target ? fileButtonLabel(target) : undefined;
  const openAriaLabel = displayPath
    ? (locale === "en" ? `Preview file: ${displayPath}` : `在右侧预览：${displayPath}`)
    : undefined;
  const rowIcon = showIcon ? step.icon : undefined;
  const RowIcon = rowIcon;
  const errorText = failed ? toolResultText(undefined, result, t("chat.toolFailed")) : "";
  const canExpandError = failed && Boolean(errorText.trim());

  const fileButton = target && iconInfo && buttonText ? (
    <WorkspacePathContextMenu path={displayPath ?? target.rawPath} onOpen={navigate}>
      <button
        type="button"
        data-slot="tool-target-link"
        data-file-read-button="true"
        disabled={!navigate}
        onClick={navigate}
        title={displayPath}
        aria-label={openAriaLabel}
        className="group/file-btn inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-border/55 bg-foreground/[0.035] px-1.5 py-0.5 text-[12.5px] leading-snug font-medium text-foreground/85 transition-[background-color,border-color,color] duration-150 hover:border-border/90 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:border-border/55 disabled:hover:bg-foreground/[0.035] disabled:hover:text-foreground/85"
      >
        <CodexIcon
          src={iconInfo.icon}
          data-file-type-icon="true"
          className={`size-3.5 shrink-0 ${iconInfo.colorClass}`}
        />
        <span className="min-w-0 truncate font-mono text-[12px]">{buttonText}</span>
      </button>
    </WorkspacePathContextMenu>
  ) : null;

  const actionNode = canExpandError ? (
    <CollapsibleTrigger
      title={displayPath ? `${statusLabel} ${displayPath}` : statusLabel}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md py-0.5 text-[13px] font-medium text-foreground/60 transition-colors hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring bg-transparent"
    >
      {RowIcon && <RowIcon className="size-3.5 shrink-0 opacity-60" />}
      <span>{statusLabel}</span>
    </CollapsibleTrigger>
  ) : (
    <span
      title={displayPath ? `${statusLabel} ${displayPath}` : statusLabel}
      className="inline-flex shrink-0 items-center gap-1.5 py-0.5 text-[13px] font-medium text-foreground/60"
    >
      {RowIcon && <RowIcon className="size-3.5 shrink-0 opacity-60" />}
      <ShimmerLabel active={running} className="relative inline-block">{statusLabel}</ShimmerLabel>
    </span>
  );

  const row = (
    <div
      data-slot="file-read-activity"
      data-status={cancelled ? "cancelled" : failed ? "failed" : waiting ? "waiting" : status === "queued" || status === "generating" ? "pending" : running ? "running" : "success"}
      className="flex min-h-6 min-w-0 max-w-full flex-1 items-center gap-1.5"
    >
      {actionNode}
      {fileButton}
      {waiting && (
        <span className="ms-auto flex w-4 shrink-0 items-center justify-end">
          <CodexClock3Icon className="size-3.5 text-amber-500/80" />
        </span>
      )}
    </div>
  );

  if (!canExpandError) return row;

  return (
    <Collapsible open={errorOpen} onOpenChange={setErrorOpen} className="min-w-0 w-full max-w-full flex-1">
      {row}
      <MeasuredCollapse open={errorOpen} className="outline-none" unmountOnClose>
        <div data-slot="tool-result-panel" className="mt-1.5 overflow-hidden rounded-lg border border-border/40 bg-muted/20 dark:bg-muted/10 shadow-xs">
          <FadeScroll className={`${detailViewport} p-2.5`}>
            <span className="px-1 py-1 text-xs text-foreground/70">{errorText}</span>
          </FadeScroll>
        </div>
      </MeasuredCollapse>
    </Collapsible>
  );
}
