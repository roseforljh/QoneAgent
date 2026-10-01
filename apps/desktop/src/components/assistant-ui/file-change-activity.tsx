import { conversationSession } from "../../lib/session-execution-state";
import { useConversationStore } from "../../lib/conversation-context";
import { useMemo, useState } from "react";
import { useLocale } from "../../localization";
import { openWorkspaceFile, resolveFileReferencePath, workspaceRelativeFilePath } from "../../lib/workspace-file-navigation";
import { FileChangeHeader } from "./elements/file-change-header";
import { ToolCall } from "./elements/tool-call";
import { ToolResultView } from "./elements/tool-result";
import { toolDiffStats } from "./tool-presentation";
import type { FileChangeActivity } from "./file-change-activity-data";

export interface FileChangeActivityProps {
  activity: FileChangeActivity;
  status?: string;
  operation?: string;
  activeLabel?: string;
  fallbackText?: string;
  showIcon?: boolean;
  onOpenFile?: (path: string) => void;
}

/** The disclosure owns the diff; its sibling filename owns file navigation. */
export function FileChangeActivityRow({ activity, status = "success", operation, activeLabel, fallbackText, showIcon = true, onOpenFile }: FileChangeActivityProps) {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const workspace = useConversationStore((state) => {
    const workspaceId = conversationSession(state)?.workspaceId;
    return state.workspaces.find((item) => item.id === workspaceId);
  });
  const { path, changeKind, presentation } = activity;
  const name = path.replaceAll("\\", "/").split("/").at(-1) || path;
  const relativePath = workspace ? workspaceRelativeFilePath(path, workspace.path) : undefined;
  const fileRemoved = status === "success" && changeKind === "deleted";
  const navigate = fileRemoved ? undefined : onOpenFile ? () => onOpenFile(path) : sessionId && workspace && relativePath
    ? () => openWorkspaceFile({ sessionId, workspaceId: workspace.id, path: relativePath }) : undefined;
  const visiblePresentation = status === "failed" ? undefined : presentation;
  const stat = useMemo(() => visiblePresentation && status === "success" ? toolDiffStats(visiblePresentation) : undefined, [visiblePresentation, status]);
  const completedLabel = locale === "en"
    ? { created: "Created", edited: "Edited", deleted: "Deleted" }[changeKind ?? "edited"]
    : { created: "已创建", edited: "已编辑", deleted: "已删除" }[changeKind ?? "edited"];
  const applyingLabel = locale === "en"
    ? { created: "Creating", edited: "Editing", deleted: "Deleting" }[changeKind ?? "edited"]
    : { created: "正在创建", edited: "正在编辑", deleted: "正在删除" }[changeKind ?? "edited"];
  const running = status === "running" || status === "generating";
  const label = status === "failed" ? t("chat.toolActionFailed", { operation: operation ?? completedLabel })
    : status === "queued" || status === "waiting" ? activeLabel ?? applyingLabel
      : !changeKind && operation === "write" ? locale === "en" ? "Written" : "已写入" : completedLabel;
  const liveLabel = status === "generating" || status === "queued" || status === "waiting" ? activeLabel ?? applyingLabel
    : !changeKind && operation === "write" ? locale === "en" ? "Writing" : "正在写入" : applyingLabel;
  const emptyText = fallbackText ?? t(status === "failed" ? "chat.toolFailed" : status === "success" ? "chat.toolNoResult" : "chat.toolResultPending");

  return <div data-slot="file-change-activity" data-change-kind={changeKind} className="min-w-0 flex-1">
    <ToolCall label={label} activeLabel={liveLabel} query={name} fullTarget={path}
      header={(panelId) => <FileChangeHeader label={running ? liveLabel : label} name={name} path={path} open={open} panelId={panelId}
        menuPath={resolveFileReferencePath(path, workspace?.path)} fileRemoved={fileRemoved}
        diffLabel={locale === "en" ? `${open ? "Collapse" : "Show"} diff for ${name}` : `${open ? "收起" : "展开"}${name}的差异`}
        fileLabel={locale === "en" ? `Open file: ${path}` : `打开文件：${path}`} onOpenFile={navigate}
        running={running} failed={status === "failed"} waiting={status === "waiting"} showIcon={showIcon} changeKind={changeKind} stat={stat} />}
      resultHasOwnFrame={Boolean(visiblePresentation && visiblePresentation.kind !== "text")}
      result={<>
        {status !== "success" && status !== "failed" && visiblePresentation && <p className="mb-2 text-xs text-foreground/50">{t("chat.toolPreview")}</p>}
        {visiblePresentation ? visiblePresentation.kind === "diff" && stat && !stat.added && !stat.removed
          ? <p className="p-3 text-xs text-foreground/50">{locale === "en" ? "No line changes" : "无行内容变化"}</p>
          : <ToolResultView presentation={visiblePresentation} emptyText={emptyText} />
          : <p className="p-1 text-xs text-foreground/60">{emptyText}</p>}
      </>}
      running={running} pending={status === "generating" || status === "queued"} waiting={status === "waiting"} failed={status === "failed"}
      open={open} onOpenChange={setOpen} />
  </div>;
}
