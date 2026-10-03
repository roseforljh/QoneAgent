import { conversationSession } from "../../lib/session-execution-state";
import { useConversationStore } from "../../lib/conversation-context";
import { useMemo } from "react";
import { openWorkspaceFile, resolveFileReferencePath, workspaceRelativeFilePath } from "../../lib/workspace-file-navigation";
import { RunFileChangesCard } from "./elements/run-file-tree";
import { openRunChanges } from "../../lib/run-changes-navigation";
import { collectRunFileChanges, isRunSummaryOwner } from "./run-file-changes";
import { runById } from "../../lib/store-indexes";

export function RunFileChangesAttachment({ messageId, runId }: { messageId: string; runId?: string }) {
  const messages = useConversationStore((state) => state.messages);
  const calls = useConversationStore((state) => state.toolCalls);
  const status = useConversationStore((state) => runById(state.runs, runId)?.status);
  const activeRunId = useConversationStore((state) => state.activeRunId);
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const workspace = useConversationStore((state) => {
    const id = conversationSession(state)?.workspaceId;
    return state.workspaces.find((item) => item.id === id);
  });
  const owner = isRunSummaryOwner(messageId, runId, messages, status, activeRunId);
  const changes = useMemo(() => owner && runId ? collectRunFileChanges(runId, calls, messages) : undefined, [owner, runId, calls, messages]);
  if (!changes?.nodes.length) return null;

  return <RunFileChangesCard key={runId} changes={changes}
    workspacePath={workspace?.path}
    displayPath={workspace ? (file) => workspaceRelativeFilePath(file.path, workspace.path) ?? file.path : undefined}
    onReview={sessionId && runId ? (path) => openRunChanges({ sessionId, runId, changes, path }) : undefined} onOpenFile={sessionId ? (file) => {
    if (file.changeKind === "deleted") return false;
    const path = resolveFileReferencePath(file.path, workspace?.path);
    if (!path) return false;
    openWorkspaceFile({ sessionId, workspaceId: workspace?.id, path });
    return true;
  } : undefined} />;
}
