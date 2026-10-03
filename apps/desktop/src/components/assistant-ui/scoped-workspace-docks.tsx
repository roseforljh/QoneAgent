import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { dockScopeKey } from "../../lib/dock-state";
import { WorkspaceDock } from "./workspace-dock";

type DockOwner = { key: string; sessionId?: string; workspaceId?: string; hasTabs: boolean };

export function ScopedWorkspaceDocks({ onViewChange }: { onViewChange: (view: string | undefined) => void }) {
  const sessionId = useStore((state) => state.currentSessionId);
  const workspaceId = useStore((state) => state.currentWorkspaceId);
  const draftDockId = useStore((state) => state.draftDockId);
  const sessions = useStore((state) => state.sessions);
  const sessionsLoaded = useStore((state) => state.sessionsLoaded);
  const current: DockOwner = { key: dockScopeKey(sessionId, workspaceId, draftDockId), sessionId, workspaceId, hasTabs: false };
  const [retained, setRetained] = useState<DockOwner[]>([]);

  useEffect(() => {
    setRetained((owners) => owners.some((owner) => owner.key === current.key) ? owners : [...owners, current]);
  }, [current.key, current.sessionId, current.workspaceId]);

  useEffect(() => {
    if (!sessionsLoaded) return;
    const sessionIds = new Set(sessions.map((session) => session.id));
    setRetained((owners) => owners.filter((owner) => owner.key === current.key || (
      owner.hasTabs && !!owner.sessionId && sessionIds.has(owner.sessionId)
    )));
  }, [sessions, sessionsLoaded, current.key]);

  // Render the selected owner immediately, before the retention effect runs.
  const owners = retained.some((owner) => owner.key === current.key) ? retained : [...retained, current];
  return <>{owners.map((owner) => {
    const active = owner.key === current.key;
    const ownerWorkspaceId = owner.sessionId
      ? sessions.find((session) => session.id === owner.sessionId)?.workspaceId ?? owner.workspaceId
      : owner.workspaceId;
    return <WorkspaceDock
      key={owner.key}
      scopeKey={owner.key}
      scopeActive={active}
      sessionId={owner.sessionId}
      workspaceId={ownerWorkspaceId}
      onViewChange={active ? onViewChange : undefined}
      onTabsChange={(hasTabs) => setRetained((owners) => {
        const existing = owners.find((item) => item.key === owner.key);
        if (!existing) return hasTabs ? [...owners, { ...owner, hasTabs }] : owners;
        if (existing.hasTabs === hasTabs) return owners;
        return owners.map((item) => item.key === owner.key ? { ...item, hasTabs } : item);
      })}
    />;
  })}</>;
}
