import { useEffect, useRef } from "react";
import { bindSidebarDrag } from "../lib/sidebar-drag";
import { useSidebarPreferences } from "../lib/sidebar-preferences";
import { useStore } from "../store";

export function useSidebarDrag() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const reorder = ({ kind, source, target, after }: Parameters<NonNullable<Parameters<typeof bindSidebarDrag>[1]>>[0]) => {
      const store = useStore.getState();
      const preferences = useSidebarPreferences.getState();
      if (kind === "session") preferences.moveSession(store.sessions, source, target, after);
      else preferences.moveWorkspace(store.workspaces, source, target, after);
    };
    return bindSidebarDrag(ref.current, () => {}, reorder);
  }, []);
  return ref;
}
