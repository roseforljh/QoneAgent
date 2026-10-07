import { Link } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useLocale } from "../../localization";
import { SIDEBAR_VISIBILITY_TRANSITION } from "../../lib/pane-motion";
import { AnimatedSidebarIcon } from "../ui/AnimatedSidebarIcon";
import { CodexIcon } from "../ui/CodexIcon";
import sidebarIcon from "../../assets/codex-icons/sidebar-light-16.svg";
import gearIcon from "../../assets/codex-icons/gear-light-16.svg";
import { ThreadListNew } from "./thread-list";
import { TooltipIconButton } from "./tooltip-icon-button";
import { SidebarProjectsPopover } from "./sidebar-projects-popover";
import "./collapsed-sidebar.css";

export function CollapsedSidebar({ collapsed, onOpenSidebar, onOpenSettings }: {
  collapsed: boolean;
  onOpenSidebar: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useLocale();
  const reduceMotion = useReducedMotion();
  return <motion.aside className="q-collapsed-sidebar" initial={false}
    animate={{ width: collapsed ? "3rem" : "0rem" }}
    transition={reduceMotion ? { duration: 0 } : SIDEBAR_VISIBILITY_TRANSITION}
    inert={!collapsed} aria-hidden={!collapsed}>
    <div className="q-collapsed-sidebar-content">
      <div className="flex h-12 shrink-0 items-center justify-center">
        <TooltipIconButton tooltip={t("sidebar.expand")} onClick={onOpenSidebar} className="q-sidebar-rail-action">
          <CodexIcon src={sidebarIcon} className="size-4" />
        </TooltipIconButton>
      </div>
      <nav className="flex flex-col items-center gap-0.5">
        <ThreadListNew className="q-sidebar-rail-action" labelClassName="sr-only"
          title={t("sidebar.newChat")} aria-label={t("sidebar.newChat")} />
        <Link to="/browser" className="q-sidebar-rail-action" title={t("browser.title")} aria-label={t("browser.title")}>
          <AnimatedSidebarIcon kind="browser" />
        </Link>
        {collapsed && <SidebarProjectsPopover />}
      </nav>
      <div className="mt-auto flex justify-center py-2">
        <TooltipIconButton tooltip={t("common.settings")} onClick={onOpenSettings} className="q-sidebar-rail-action">
          <CodexIcon src={gearIcon} className="size-4" />
        </TooltipIconButton>
      </div>
    </div>
  </motion.aside>;
}
