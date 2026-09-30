import { useMemo } from "react";
import { useStore } from "../../store";
import { openWorkspaceFile, workspaceRelativeFilePath } from "../../lib/workspace-file-navigation";
import { RunFileChangesCard } from "./elements/run-file-tree";
import { openRunChanges } from "../../lib/run-changes-navigation";
import { collectRunFileChanges, isRunSummaryOwner } from "./run-file-changes";

export function RunFileChangesAttachment({ messageId, runId }: { messageId: string; runId?: string }) {
  const messages = useStore((state) => state.messages);
  const calls = useStore((state) => state.toolCalls);
  const status = useStore((state) => state.runs.find((run) => run.id === runId)?.status);
  const activeRunId = useStore((state) => state.activeRunId);
  const sessionId = useStore((state) => state.currentSessionId);
  const workspace = useStore((state) => {
    const id = state.sessions.find((session) => session.id === state.currentSessionId)?.workspaceId;
    return state.workspaces.find((item) => item.id === id);
  });
  const owner = isRunSummaryOwner(messageId, runId, messages, status, activeRunId);
  const changes = useMemo(() => owner && runId ? collectRunFileChanges(runId, calls, messages) : undefined, [owner, runId, calls, messages]);
  if (!changes?.nodes.length) return null;

  return <RunFileChangesCard key={runId} changes={changes}
    displayPath={workspace ? (file) => workspaceRelativeFilePath(file.path, workspace.path) ?? file.path : undefined}
    onReview={sessionId && runId ? (path) => openRunChanges({ sessionId, runId, changes, path }) : undefined} onOpenFile={sessionId && workspace ? (file) => {
    const path = workspaceRelativeFilePath(file.path, workspace.path);
    if (!path) return false;
    openWorkspaceFile({ sessionId, workspaceId: workspace.id, path });
    return true;
  } : undefined} />;
}
