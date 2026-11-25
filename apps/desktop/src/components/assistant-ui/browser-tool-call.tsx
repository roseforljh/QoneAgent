import type { PartState } from "@assistant-ui/react";
import { useConversationStore } from "../../lib/conversation-context";
import { toolCallById } from "../../lib/store-indexes";
import { useBrowserTasks } from "../../lib/browser-tasks";
import { browserUrlFromTool, formatBrowserTarget, latestBrowserTaskForSession, openBuiltInBrowserTask, type NestedBrowserActivity } from "../../lib/browser-navigation";
import { useLocale } from "../../localization";
import { ToolCall } from "./elements/tool-call";
import { CodexBrowserIcon, type ExecutionIcon } from "./execution-icons";
import { toolOperationLabels, toolPreparationLabel } from "./tool-action-summary";
import { toolActivity } from "./tool-call-display";

export interface BrowserToolCallProps {
  part: Extract<PartState, { type: "tool-call" }>;
  step: { verb: string; icon?: ExecutionIcon };
  prepared?: boolean;
  showIcon?: boolean;
  messageRunning: boolean;
}

/** 与子代理、后台命令统一的单行底部下划线跳转样式，单击直接打开右侧栏内置浏览器。 */
export function BrowserToolCall({ part, step, prepared = false, showIcon = false, messageRunning }: BrowserToolCallProps) {
  const { locale, t } = useLocale();
  const call = useConversationStore((state) => toolCallById(state.toolCalls, part.toolCallId));
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const browserTasks = useBrowserTasks((state) => state.tasks);
  const task = latestBrowserTaskForSession(browserTasks, sessionId);
  const status = toolActivity(part, call, prepared, messageRunning);
  const labels = toolOperationLabels(part, step.verb, locale);
  const activeLabel = status === "generating" ? toolPreparationLabel(part, step, locale)
    : status === "queued" ? t("chat.toolQueued")
      : status === "waiting" ? t("chat.toolApprovalPending") : labels.active;
  const label = status === "cancelled" ? t("servers.view.cancelled")
    : status === "failed" ? t("chat.browserFailed")
      : status === "queued" || status === "waiting" ? activeLabel : labels.completed;
  const rawUrl = browserUrlFromTool(call?.args ?? part.args, call?.result ?? part.result) ?? task?.url;
  const targetLabel = formatBrowserTarget(rawUrl, t("browser.title"));
  const openLabel = t("chat.browserOpen");
  const running = status === "running" || status === "generating";
  return (
    <ToolCall
      icon={showIcon ? (step.icon ?? CodexBrowserIcon) : undefined}
      label={label}
      activeLabel={activeLabel}
      query=""
      fullTarget={rawUrl || targetLabel}
      targetAction={sessionId ? {
        label: targetLabel,
        ariaLabel: rawUrl ? `${openLabel}: ${rawUrl}` : openLabel,
        onClick: () => openBuiltInBrowserTask(sessionId, { browserId: task?.id, url: rawUrl }),
      } : undefined}
      result={null}
      canExpand={false}
      open={false}
      onOpenChange={() => {}}
      running={running}
      pending={status === "queued" || status === "generating"}
      waiting={status === "waiting"}
      cancelled={status === "cancelled"}
      failed={status === "failed"}
      className="min-w-0 max-w-none flex-1"
    />
  );
}

/** codemode 脚本内嵌套调用内置浏览器时，展示同一风格的底部下划线直达入口。 */
export function NestedBrowserRow({ activity, showIcon = true }: { activity: NestedBrowserActivity; showIcon?: boolean }) {
  const { t } = useLocale();
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const browserTasks = useBrowserTasks((state) => state.tasks);
  const task = latestBrowserTaskForSession(browserTasks, sessionId);
  const rawUrl = activity.url ?? task?.url;
  const targetLabel = formatBrowserTarget(rawUrl, t("browser.title"));
  const openLabel = t("chat.browserOpen");
  const active = activity.running || Boolean(task?.active);
  const activeLabel = t("chat.browserBrowsing");
  const label = activity.failed ? t("chat.browserFailed") : t("chat.browserBrowsed");
  return (
    <ToolCall
      icon={showIcon ? CodexBrowserIcon : undefined}
      label={label}
      activeLabel={activeLabel}
      query=""
      fullTarget={rawUrl || targetLabel}
      targetAction={sessionId ? {
        label: targetLabel,
        ariaLabel: rawUrl ? `${openLabel}: ${rawUrl}` : openLabel,
        onClick: () => openBuiltInBrowserTask(sessionId, { browserId: task?.id, url: rawUrl }),
      } : undefined}
      result={null}
      canExpand={false}
      open={false}
      onOpenChange={() => {}}
      running={active}
      failed={activity.failed}
      className="min-w-0 max-w-none flex-1"
    />
  );
}
