import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "../../store";

export type AppDestination = { path: string; sessionId?: string };

export interface AppNavigationHistory {
  entries: AppDestination[];
  index: number;
}

const HOME_PATH = "/";

const normalizeDestination = (destination: AppDestination): AppDestination =>
  destination.path === HOME_PATH ? { path: HOME_PATH, sessionId: destination.sessionId } : { path: destination.path };

const sameDestination = (a: AppDestination, b: AppDestination) => {
  const left = normalizeDestination(a);
  const right = normalizeDestination(b);
  return left.path === right.path && left.sessionId === right.sessionId;
};

/** 初始导航栈：若在非主页面（如 /teams）直接启动或刷新，自动将项目主页 "/" 垫在栈底，保证永远可返回主页。 */
export function createInitialNavigationState(path: string, sessionId?: string): AppNavigationHistory {
  const current = normalizeDestination({ path, sessionId });
  if (current.path !== HOME_PATH) {
    return { entries: [{ path: HOME_PATH, sessionId }, current], index: 1 };
  }
  return { entries: [current], index: 0 };
}

export function pushNavigationState(previous: AppNavigationHistory, destination: AppDestination): AppNavigationHistory {
  const current = normalizeDestination(destination);
  const active = previous.entries[previous.index];
  if (active && sameDestination(active, current)) return previous;
  // 启动初期主页面尚未选中首个会话，收到首个 sessionId 时原地替换启动占位项，避免多出一条空白返回项。
  if (
    previous.entries.length === 1 &&
    previous.index === 0 &&
    previous.entries[0].path === HOME_PATH &&
    current.path === HOME_PATH &&
    previous.entries[0].sessionId === undefined &&
    current.sessionId !== undefined
  ) {
    return { entries: [current], index: 0 };
  }
  return { entries: [...previous.entries.slice(0, previous.index + 1), current], index: previous.index + 1 };
}

export function canNavigateBack(history: AppNavigationHistory, currentPath: string): boolean {
  return history.index > 0 || currentPath !== HOME_PATH;
}

export function stepNavigationState(
  previous: AppNavigationHistory,
  offset: -1 | 1,
  currentSessionId?: string,
): { next: AppNavigationHistory; target?: AppDestination } {
  const nextIndex = previous.index + offset;
  const existing = previous.entries[nextIndex];
  if (existing) {
    return { next: { ...previous, index: nextIndex }, target: existing };
  }
  // 在非主页且处于栈底时，始终允许退回项目主页 "/"，并保留当前页供前进按钮返回。
  if (offset === -1 && previous.entries[previous.index]?.path !== HOME_PATH) {
    const home: AppDestination = { path: HOME_PATH, sessionId: currentSessionId };
    return { next: { entries: [home, ...previous.entries], index: 0 }, target: home };
  }
  return { next: previous };
}

export function useAppNavigation(path: string) {
  const navigate = useNavigate();
  const currentSessionId = useStore((state) => state.currentSessionId);
  const selectSession = useStore((state) => state.selectSession);
  const [history, setHistory] = useState<AppNavigationHistory>(() => createInitialNavigationState(path, currentSessionId));
  const pending = useRef<AppDestination | null>(null);

  useEffect(() => {
    const current = normalizeDestination({ path, sessionId: currentSessionId });
    if (pending.current) {
      const target = normalizeDestination(pending.current);
      // 路由到达目标（且主页面会话已对齐或目标无指定会话）即解除挂起，避免会话异步变化导致历史记录锁死。
      if (target.path === current.path && (target.path !== HOME_PATH || !target.sessionId || target.sessionId === current.sessionId)) {
        pending.current = null;
        return;
      }
      // 若用户手动跳转到了非预期路由，放弃旧的挂起目标并正常记录新路由。
      if (target.path !== current.path) {
        pending.current = null;
      } else {
        return;
      }
    }
    setHistory((previous) => pushNavigationState(previous, current));
  }, [path, currentSessionId]);

  const go = useCallback((offset: -1 | 1) => {
    const { next, target } = stepNavigationState(history, offset, currentSessionId);
    if (!target) return;
    pending.current = target;
    setHistory(next);
    if (target.path !== path) {
      void navigate({ to: target.path as "/" });
    }
    if (target.path === HOME_PATH && target.sessionId && target.sessionId !== currentSessionId) {
      selectSession(target.sessionId);
    }
    if (target.path === path && (target.path !== HOME_PATH || !target.sessionId || target.sessionId === currentSessionId)) {
      pending.current = null;
    }
  }, [history, path, currentSessionId, navigate, selectSession]);

  return {
    canGoBack: canNavigateBack(history, path),
    canGoForward: history.index < history.entries.length - 1,
    goBack: () => go(-1),
    goForward: () => go(1),
  };
}
