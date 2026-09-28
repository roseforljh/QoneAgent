import { PinIcon, PinOffIcon } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useLocale } from "../../localization";

export const SidebarSessionPinAction: FC<{ pinned: boolean; onToggle: () => void }> = ({ pinned, onToggle }) => {
  const { t } = useLocale();
  const label = t(pinned ? "sidebar.unpin" : "sidebar.pin");

  return <button
    type="button"
    className="q-sidebar-session-pin-action text-muted-foreground hover:text-foreground grid size-6 shrink-0 place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-ring"
    aria-label={label}
    title={label}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); onToggle(); }}
  >
    {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
  </button>;
};

export const SidebarSessionActions: FC<{ pinned: boolean; onTogglePinned: () => void; status?: ReactNode; children: ReactNode }> = ({ pinned, onTogglePinned, status, children }) => (
  <div className="q-sidebar-session-rail">
    {(status || pinned) && <span className="q-sidebar-session-status text-muted-foreground">
      {status ?? <PinIcon className="size-3" />}
    </span>}
    <div className="q-sidebar-session-actions">
      <SidebarSessionPinAction pinned={pinned} onToggle={onTogglePinned} />
      {children}
    </div>
  </div>
);
