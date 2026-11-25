import { create } from "zustand";

export interface AgentBrowserTask {
  id: string;
  sessionId: string;
  url: string;
  site: string;
  active: boolean;
  startedAt: number;
  updatedAt: number;
}

interface BrowserTasksState {
  tasks: AgentBrowserTask[];
  upsert: (task: { id: string; sessionId: string; url: string; site: string; active: boolean; at?: number }) => void;
  setActive: (id: string, active: boolean) => void;
  updateUrl: (id: string, url: string) => void;
  clear: () => void;
}

/** 跟踪会话内 AI 驱动的内置浏览器任务，驱动右上角后台任务卡片与时间线下划线跳转。 */
export const useBrowserTasks = create<BrowserTasksState>((set) => ({
  tasks: [],
  upsert: ({ id, sessionId, url, site, active, at = Date.now() }) => set((state) => {
    const index = state.tasks.findIndex((item) => item.id === id);
    if (index >= 0) {
      const current = state.tasks[index]!;
      const nextUrl = url || current.url;
      if (current.sessionId === sessionId && current.url === nextUrl && current.site === site && current.active === active) {
        return state;
      }
      const next = [...state.tasks];
      next[index] = { ...current, sessionId, url: nextUrl, site, active, updatedAt: at };
      return { tasks: next };
    }
    return {
      tasks: [...state.tasks, { id, sessionId, url, site, active, startedAt: at, updatedAt: at }],
    };
  }),
  setActive: (id, active) => set((state) => {
    const index = state.tasks.findIndex((item) => item.id === id);
    if (index < 0 || state.tasks[index]!.active === active) return state;
    const next = [...state.tasks];
    next[index] = { ...next[index]!, active, updatedAt: Date.now() };
    return { tasks: next };
  }),
  updateUrl: (id, url) => set((state) => {
    const index = state.tasks.findIndex((item) => item.id === id);
    if (index < 0 || !url || state.tasks[index]!.url === url) return state;
    const next = [...state.tasks];
    next[index] = { ...next[index]!, url, updatedAt: Date.now() };
    return { tasks: next };
  }),
  clear: () => set({ tasks: [] }),
}));
