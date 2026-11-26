import type { Transition, Variants } from "motion/react";

export type PageTransitionKey = "chat" | "teams" | "schedules" | "browser" | "skills" | "permissions";
export type PageTransitionDirection = 1 | -1;

const PAGE_ORDER: Record<PageTransitionKey, number> = {
  chat: 0,
  teams: 1,
  schedules: 2,
  browser: 3,
  skills: 4,
  permissions: 5,
};

const PAGE_ENTER_TRANSITION: Transition = {
  duration: 0.24,
  ease: [0.22, 1, 0.36, 1],
};

const PAGE_EXIT_TRANSITION: Transition = {
  duration: 0.18,
  ease: [0.4, 0, 1, 1],
};

/** 将路由路径归一为主视图标识，避免同页子路径切换触发整页重挂载过渡。 */
export function pageTransitionKey(pathname: string): PageTransitionKey {
  if (pathname === "/teams") return "teams";
  if (pathname === "/schedules") return "schedules";
  if (pathname === "/browser") return "browser";
  if (pathname === "/skills") return "skills";
  if (pathname === "/permissions") return "permissions";
  return "chat";
}

/** 按主导航顺序计算页面切换方向：前进为 1，返回为 -1，同页为 0。 */
export function pageTransitionDirection(from: PageTransitionKey, to: PageTransitionKey): PageTransitionDirection | 0 {
  if (from === to) return 0;
  return PAGE_ORDER[to] > PAGE_ORDER[from] ? 1 : -1;
}

export const PAGE_TRANSITION_VARIANTS: Variants = {
  enter: (direction: PageTransitionDirection) => ({
    opacity: 0,
    x: direction > 0 ? 18 : -18,
    scale: 0.992,
  }),
  center: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: PAGE_ENTER_TRANSITION,
  },
  exit: (direction: PageTransitionDirection) => ({
    opacity: 0,
    x: direction > 0 ? -12 : 12,
    scale: 0.992,
    transition: PAGE_EXIT_TRANSITION,
  }),
};

export const REDUCED_PAGE_TRANSITION_VARIANTS: Variants = {
  enter: { opacity: 1, x: 0, scale: 1 },
  center: { opacity: 1, x: 0, scale: 1, transition: { duration: 0 } },
  exit: { opacity: 1, x: 0, scale: 1, transition: { duration: 0 } },
};

// 懒加载页面共享加载器，悬停或聚焦侧边栏入口时提前预热，消除首次切换的空白闪烁。
export const loadBrowserPage = () => import("../components/browser/BrowserPage");
export const loadTeamPage = () => import("../components/team/TeamPage");
export const loadSchedulesPage = () => import("../components/schedules/SchedulesPage");
