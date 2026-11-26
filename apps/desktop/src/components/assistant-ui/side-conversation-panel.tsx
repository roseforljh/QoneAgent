import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { SessionInfo } from "@qone/protocol";
import { ConversationProvider } from "../../lib/conversation-context";
import { useSideConversationRuntime } from "../../lib/use-side-conversation-runtime";
import { Thread } from "./Thread";
import { PendingApprovals } from "./pending-approvals";

function SideConversationThread({ sessionId }: { sessionId: string }) {
  const runtime = useSideConversationRuntime(sessionId);
  return <AssistantRuntimeProvider runtime={runtime}>
    <div className="q-chat-content relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Thread><PendingApprovals /></Thread>
    </div>
  </AssistantRuntimeProvider>;
}

export function SideConversationPanel({ session }: { session: SessionInfo }) {
  return <ConversationProvider sessionId={session.id}>
    <SideConversationThread key={session.id} sessionId={session.id} />
  </ConversationProvider>;
}
