import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAui, useAuiState, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import { createContext, useContext } from "react";
import type { SessionInfo } from "@qone/protocol";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { useSideConversationRuntime } from "../../lib/use-side-conversation-runtime";
import { sessionStore } from "../../lib/session-execution-state";
import { getQoneMessageQueue } from "../../lib/qone-message-queue";
import { ToolCard, ApprovalCard } from "../tool-ui/ToolCard";
import { MarkdownText } from "./markdown-text";
import { Reasoning } from "./reasoning";
import { Image } from "./elements/image";
import { File } from "./elements/file";
import { ComposerAttachments, ComposerAddAttachment } from "./elements/attachment.aui";
import { ComposerQueue } from "./composer-queue";
import { ComposerQueueEnterPlugin } from "./composer-queue-enter";
import { ComposerActionGlyph } from "./composer-action-glyph";
import { TooltipIconButton } from "./tooltip-icon-button";
import { cn } from "../../lib/utils";

const SessionContext = createContext<SessionInfo | undefined>(undefined);

const SideTool: ToolCallMessagePartComponent = ({ toolCallId, toolName, args, result, status }) => {
  const session = useContext(SessionContext)!;
  const call = useStore((state) => state.backgroundSessions[session.id]?.toolCalls.find((item) => item.toolCallId === toolCallId));
  return <ToolCard call={call ?? { toolCallId, toolName, args, result, runId: "", status: status.type === "running" ? "running" : status.type === "incomplete" ? "failed" : "success" }} />;
};

function SideMessage() {
  const session = useContext(SessionContext)!;
  const { t } = useLocale();
  const id = useAuiState((state) => state.message.id);
  const role = useAuiState((state) => state.message.role);
  if (id === session.sideChat?.boundaryMessageId) return <div className="my-4 border-y border-border/60 py-3 text-center text-xs text-muted-foreground">{t("chat.sideChatBoundary")}</div>;
  return <MessagePrimitive.Root className={cn("my-3 min-w-0 text-sm", role === "user" && "ml-6 rounded-2xl bg-muted px-3 py-2")}>
    <MessagePrimitive.Parts components={{ Text: MarkdownText, Image, File, Reasoning, tools: { Fallback: SideTool } }} />
  </MessagePrimitive.Root>;
}

function SideComposer({ sessionId }: { sessionId: string }) {
  const { t } = useLocale();
  const aui = useAui();
  const running = useAuiState((state) => state.thread.isRunning);
  const canSend = useAuiState((state) => state.composer.canSend);
  const editing = useStore((state) => state.backgroundSessions[sessionId]?.editingQueueItem);
  const queueing = useStore((state) => state.followUpQueueMode === "queue");
  const connected = useStore((state) => state.connected);
  const ready = useStore((state) => Boolean(state.backgroundSessions[sessionId]?.queueLoadedSessionId === sessionId && state.workspaces.some((workspace) => workspace.id === state.sideChats[sessionId]?.workspaceId)));
  return <ComposerPrimitive.Root className="relative mx-3 mb-3 flex shrink-0 flex-col">
    <ComposerQueue sessionId={sessionId} allowSideChat={false} />
    <ComposerPrimitive.AttachmentDropzone asChild>
      <div className="q-composer-shell relative flex flex-col rounded-(--composer-radius) bg-(--composer-bg)">
        {editing && <div className="flex justify-between px-3 pt-2 text-xs text-muted-foreground"><span>{t("chat.queueEditing")}</span><button type="button" onClick={() => {
          void aui.composer().reset();
          getQoneMessageQueue(sessionId)?.cancelEdit();
          sessionStore(useStore, sessionId).setState({ editingQueueItem: undefined });
        }}>{t("common.cancel")}</button></div>}
        <ComposerAttachments />
        <LexicalComposerInput submitMode="none" placeholder={t("chat.sendMessage")} className="aui-composer-input relative min-h-12 max-h-48 px-3 py-2 text-sm outline-none [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:top-2 [&_.aui-lexical-placeholder]:text-muted-foreground">
          <ComposerQueueEnterPlugin menuOpen={false} compacting={!connected || !ready} />
        </LexicalComposerInput>
        <div className="flex items-center justify-between px-2 pb-2">
          <ComposerAddAttachment />
          <div className="flex gap-1">
            {running && <ComposerPrimitive.Cancel asChild><TooltipIconButton tooltip={t("chat.stopGenerating")} className="size-7 rounded-full"><ComposerActionGlyph stopped /></TooltipIconButton></ComposerPrimitive.Cancel>}
            <ComposerPrimitive.Send asChild><TooltipIconButton disabled={!connected || !ready || !canSend} tooltip={t(editing ? "chat.queueSave" : running ? queueing ? "chat.queueSend" : "chat.queueSteer" : "chat.sendMessage")} className="size-7 rounded-full bg-foreground text-background hover:bg-foreground/85"><ComposerActionGlyph stopped={false} /></TooltipIconButton></ComposerPrimitive.Send>
          </div>
        </div>
      </div>
    </ComposerPrimitive.AttachmentDropzone>
  </ComposerPrimitive.Root>;
}

export function SideConversationPanel({ session }: { session: SessionInfo }) {
  const runtime = useSideConversationRuntime(session.id);
  const approvals = useStore((state) => state.backgroundSessions[session.id]?.approvals ?? []);
  const resolve = (approvalId: string, decision: "approved" | "rejected") => {
    void useStore.getState().send({ type: decision === "approved" ? "tool.approve" : "tool.reject", requestId: crypto.randomUUID(), approvalId });
    sessionStore(useStore, session.id).setState((state) => ({ approvals: state.approvals.filter((item) => item.id !== approvalId) }));
  };
  return <SessionContext.Provider value={session}><AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-4">
        <ThreadPrimitive.Messages components={{ Message: SideMessage }} />
      </ThreadPrimitive.Viewport>
      {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onApprove={() => resolve(approval.id, "approved")} onReject={() => resolve(approval.id, "rejected")} />)}
      <SideComposer sessionId={session.id} />
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider></SessionContext.Provider>;
}
