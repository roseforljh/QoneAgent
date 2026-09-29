import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import { CodexIcon } from "./CodexIcon";
import newChatIcon from "../../assets/codex-icons/square-and-pencil-light-16.svg";
import pluginsIcon from "../../assets/codex-icons/plugin-light-16.svg";
import searchIcon from "../../assets/codex-icons/magnifying-glass-lg-light-16.svg";

export type SidebarIconKind = "new-chat" | "plugins" | "search";

const iconSources: Record<SidebarIconKind, string> = {
  "new-chat": newChatIcon,
  plugins: pluginsIcon,
  search: searchIcon,
};

function SearchSidebarIcon() {
  return (
    <span data-slot="q-sidebar-search-icon" className="relative inline-flex size-full" aria-hidden="true">
      <CodexIcon
        src={searchIcon}
        data-slot="q-sidebar-search-static"
        className="size-full"
      />
      <svg
        data-slot="q-sidebar-search-motion"
        className="pointer-events-none absolute inset-0 size-full"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g transform="rotate(-45 9.172 9.082)">
          <ellipse
            className="q-sidebar-search-lens"
            cx="9.172"
            cy="9.082"
            rx="6.0625"
            ry="6.0625"
            stroke="currentColor"
            strokeWidth="1.333"
          />
        </g>
        <path
          d="M13.738 13.748L17.095 17.092"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

type AnimatedSidebarIconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  kind: SidebarIconKind;
};

/** Local equivalent of GPT's animated sidebar icon with a stable static fallback. */
export function AnimatedSidebarIcon({ kind, className, ...props }: AnimatedSidebarIconProps) {
  return (
    <span
      data-slot="q-sidebar-animated-icon"
      data-kind={kind}
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0", className)}
      {...props}
    >
      {kind === "search" ? <SearchSidebarIcon /> : <CodexIcon src={iconSources[kind]} className="size-full" />}
    </span>
  );
}
