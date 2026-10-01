import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { SessionInfo } from "@qone/protocol";
import { ConversationProvider } from "../../lib/conversation-context";
import { useSideConversationRuntime } from "../../lib/use-side-conversation-runtime";
import { Thread } from "./Thread";
import { PendingApprovals } from "./pending-approvals";

function SideConversationThread({ sessionId }: { sessionId: string }) {
  const runtime = useSideConversationRuntime(sessionId);
  return <AssistantRuntimeProvider runtime={runtime}>
    <Thread><PendingApprovals /></Thread>
  </AssistantRuntimeProvider>;
}

export function SideConversationPanel({ session }: { session: SessionInfo }) {
  return <ConversationProvider sessionId={session.id}>
    <SideConversationThread key={session.id} sessionId={session.id} />
  </ConversationProvider>;
}
