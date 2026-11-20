import type { ChatMessage, ToolCall } from "../store";

export const OPEN_BACKGROUND_JOB_EVENT = "qone-open-background-jobs";

export function openBackgroundJob(jobId: string, sessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_BACKGROUND_JOB_EVENT, { detail: { jobId, sessionId } }));
}

export interface BackgroundJobLink {
  id: string;
  command: string;
}

export function backgroundJobLink(args: unknown, result: unknown): BackgroundJobLink | undefined {
  if (!args || typeof args !== "object" || !result || typeof result !== "object") return;
  const { background, command } = args as { background?: unknown; command?: unknown };
  const id = (result as { details?: { jobId?: unknown } }).details?.jobId;
  if (background === true && typeof command === "string" && typeof id === "string" && id) return { id, command };
}

const indexes = new WeakMap<readonly ToolCall[], ReturnType<typeof indexLinks>>();

function indexLinks(calls: readonly ToolCall[]) {
  const byJobId = new Map<string, BackgroundJobLink>();
  const byParentCallId = new Map<string, BackgroundJobLink[]>();
  for (const call of calls) {
    const link = backgroundJobLink(call.args, call.result);
    if (!link) continue;
    byJobId.set(link.id, link);
    if (!call.parentToolCallId) continue;
    const siblings = byParentCallId.get(call.parentToolCallId);
    if (siblings) siblings.push(link);
    else byParentCallId.set(call.parentToolCallId, [link]);
  }
  return { byJobId, byParentCallId };
}

export function backgroundJobLinks(calls: readonly ToolCall[]) {
  let links = indexes.get(calls);
  if (!links) indexes.set(calls, links = indexLinks(calls));
  return links;
}

/** The invocation owns the link. Keep one compact legacy entry if the call is missing. */
export function withoutDuplicateBackgroundNotices(messages: ChatMessage[], calls: readonly ToolCall[]): ChatMessage[] {
  if (!messages.some((message) => message.communication?.backgroundJobId)) return messages;
  const { byJobId } = backgroundJobLinks(calls);
  const seen = new Set<string>();
  return messages.filter((message) => {
    const id = message.communication?.backgroundJobId;
    if (!id) return true;
    if (byJobId.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
