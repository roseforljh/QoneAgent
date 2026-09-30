import { useLocale } from "../../localization";
import { useEffect, useRef, type MutableRefObject } from "react";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../../store";
import { getDockTerminalResource, type DockTerminalResource } from "../../lib/dock-terminal-resource";
import type { TerminalStatus } from "../../lib/dock-terminal-session";

export interface TerminalApi { clear: () => void; focus: () => void; restart: () => void }

export default function TerminalView({ tabId, workspaceId, active, apiRef, onStatus }: {
  tabId: string; workspaceId: string; active: boolean;
  apiRef: MutableRefObject<TerminalApi | undefined>;
  onStatus: (tabId: string, status: TerminalStatus, detail?: string) => void;
}) {
  const { t } = useLocale();
  const cwd = useStore((state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.path);
  const hostRef = useRef<HTMLDivElement>(null);
  const resourceRef = useRef<DockTerminalResource | undefined>(undefined);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !cwd) return;
    // The tab owns this resource. UI cleanup only detaches it; explicit tab/session
    // deletion is the only ordinary action that disposes the process and xterm.
    const resource = getDockTerminalResource(tabId, cwd);
    resourceRef.current = resource;
    const detach = resource.attach(host);
    const unsubscribe = resource.session.subscribe(({ status, detail }) => onStatus(tabId, status, detail));
    apiRef.current = { clear: resource.clear, focus: resource.focus, restart: () => { void resource.session.restart(); } };
    let frame: number | undefined;
    const fit = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = undefined; resource.fit(); });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    fit();
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      unsubscribe();
      detach();
      apiRef.current = undefined;
      resourceRef.current = undefined;
    };
  }, [tabId, workspaceId, cwd, apiRef, onStatus]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { resourceRef.current?.fit(); resourceRef.current?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [active, cwd]);
  return <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden p-2">
    <div ref={hostRef} className="min-h-0 min-w-0 flex-1 overflow-hidden" tabIndex={0} role="application" aria-label={t("dock.terminal")} onPointerDown={() => resourceRef.current?.focus()} />
  </div>;
}
