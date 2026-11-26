import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import type { BaseComposerRuntimeCore } from "@assistant-ui/core/internal";
import type { RuntimeEvent } from "@qone/protocol";
import { translateCurrent as t } from "../localization";
import { useStore, type ChatMessage } from "../store";
import { composerDrafts, type ComposerDraft } from "./composer-drafts";
import { localizeError } from "./error-localization";
import { appendInlineQuote } from "./inline-quote";
import { attachmentsFromMessageInfo } from "./message-attachments";
import { withoutMessageQuote } from "./message-quote";
import { sessionStore } from "./session-execution-state";

type PendingTruncate = {
  sessionId: string;
  messageId: string;
  resolve: (truncated: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

const TRUNCATE_TIMEOUT_MS = 15_000;
const pendingTruncates = new Map<string, PendingTruncate>();
const truncatingSessions = new Set<string>();

function finishTruncate(requestId: string, truncated: boolean) {
  const pending = pendingTruncates.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingTruncates.delete(requestId);
  truncatingSessions.delete(pending.sessionId);
  if (truncated) {
    // 若该回合曾伴随 chatRunError，session.messages 合并时会短暂保留它；在同批次 pong 中同步清掉。
    sessionStore(useStore, pending.sessionId).setState((st) => {
      const leftoverIndex = st.messages.findIndex((item) => item.id === pending.messageId);
      const messages = leftoverIndex >= 0 ? st.messages.slice(0, leftoverIndex) : st.messages;
      return {
        ...(leftoverIndex >= 0 ? { messages } : {}),
        chatRunError: undefined,
        contextUsage: undefined,
        contextUsageRequestId: undefined,
        ...(messages.length === 0 ? { titleGeneratingSessionIds: st.titleGeneratingSessionIds.filter((id) => id !== pending.sessionId) } : {}),
      };
    });
  }
  pending.resolve(truncated);
}

/** 处理 session.truncate 的响应事件，命中则返回 true。 */
export function handleTruncateEvent(event: RuntimeEvent): boolean {
  if ((event.type !== "pong" && event.type !== "error") || !event.requestId || !pendingTruncates.has(event.requestId)) {
    return false;
  }
  if (event.type === "error") {
    useStore.setState({ lastError: localizeError(event) });
    finishTruncate(event.requestId, false);
    return true;
  }
  finishTruncate(event.requestId, true);
  return true;
}

/** 运行时意外退出时清理所有未完成的截断请求。 */
export function resetTruncateRequests() {
  for (const requestId of [...pendingTruncates.keys()]) finishTruncate(requestId, false);
}

/** 将已发送的用户消息还原为发送前的输入框草稿（文本、指令标签、目标标签、引用与附件）。 */
export function userMessageDraft(
  message: Pick<ChatMessage, "content" | "attachments" | "quote" | "goalId">,
  options?: { goalKickoff?: boolean; goalLabel?: string },
): ComposerDraft {
  let text = withoutMessageQuote(message.content, message.quote);
  const command = /^\/((?:skill|mcp):[^\]\s]+)(?=\s|$)/u.exec(text);
  if (command) {
    const id = command[1]!;
    const chip = unstable_defaultDirectiveFormatter.serialize({ id, type: "qone-command", label: id });
    text = `${chip}${text.slice(command[0].length)}`;
  }
  if (options?.goalKickoff && message.goalId && options.goalLabel) {
    const goalChip = unstable_defaultDirectiveFormatter.serialize({ id: "qone-goal", type: "qone-tool", label: options.goalLabel });
    text = text ? `${goalChip} ${text}` : `${goalChip} `;
  }
  if (message.quote?.text.trim()) text = appendInlineQuote(text, message.quote.text);
  return { text, attachments: attachmentsFromMessageInfo(message.attachments), quote: undefined };
}

export function requestSessionTruncate(sessionId: string, messageId: string): Promise<boolean> {
  if (truncatingSessions.has(sessionId)) return Promise.resolve(false);
  const requestId = crypto.randomUUID();
  truncatingSessions.add(sessionId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      useStore.setState({ lastError: t("error.runtimeUnavailable") });
      finishTruncate(requestId, false);
    }, TRUNCATE_TIMEOUT_MS);
    pendingTruncates.set(requestId, { sessionId, messageId, resolve, timer });
    void useStore.getState().send({ type: "session.truncate", requestId, sessionId, messageId }).then((sent) => {
      if (!sent) finishTruncate(requestId, false);
    });
  });
}

/** 真实撤回该用户消息及其后续回合，并将原始草稿与附件直接放回底部输入框。 */
export async function returnUserMessageToComposer(input: {
  sessionId: string;
  messageId: string;
  composer: BaseComposerRuntimeCore;
  isActive: () => boolean;
  focusComposer?: () => void;
  goalLabel?: string;
}): Promise<boolean> {
  const owner = sessionStore(useStore, input.sessionId);
  const state = owner.getState();
  if (state.running || useStore.getState().compactionStatuses[input.sessionId]) return false;
  const hasDraft = Boolean(input.composer.text.trim() || input.composer.attachments.length > 0 || input.composer.quote !== undefined);
  if (hasDraft || state.editingQueueItem) {
    useStore.setState({ lastError: t("chat.editMessageDraftBlocked") });
    return false;
  }
  const index = state.messages.findIndex((item) => item.id === input.messageId && item.role === "user" && !item.communication);
  if (index < 0) return false;
  const source = state.messages[index]!;
  const goalKickoff = Boolean(source.goalId && !state.messages.slice(0, index).some((item) => item.goalId === source.goalId));
  const draft = userMessageDraft(source, { goalKickoff, goalLabel: input.goalLabel });

  if (source.persisted === false) {
    if (!input.composer.restoreDraft(draft)) return false;
    const kept = state.messages.slice(0, index);
    const keptRunIds = new Set(kept.flatMap((item) => item.runId ? [item.runId] : []));
    owner.setState((st) => ({
      messages: kept,
      compactions: st.compactions.filter((marker) => kept.some((item) => item.id === marker.throughMessageId)),
      toolCalls: st.toolCalls.filter((call) => keptRunIds.has(call.runId)),
      runs: st.runs.filter((run) => keptRunIds.has(run.id)),
      chatRunError: undefined,
      contextUsage: undefined,
      contextUsageRequestId: undefined,
      ...(kept.length === 0 ? { titleGeneratingSessionIds: st.titleGeneratingSessionIds.filter((id) => id !== input.sessionId) } : {}),
    }));
    input.focusComposer?.();
    return true;
  }

  if (!useStore.getState().connected) {
    useStore.setState({ lastError: t("error.runtimeDisconnected") });
    return false;
  }
  const truncated = await requestSessionTruncate(input.sessionId, input.messageId);
  if (!truncated) return false;
  if (input.isActive()) {
    if (input.composer.restoreDraft(draft)) input.focusComposer?.();
    else if (!composerDrafts.get(input.sessionId)) composerDrafts.set(input.sessionId, draft);
  } else if (!composerDrafts.get(input.sessionId)) {
    composerDrafts.set(input.sessionId, draft);
  }
  return true;
}
