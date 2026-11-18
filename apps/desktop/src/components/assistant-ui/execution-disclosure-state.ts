import { create } from "zustand";
import type { RunInfo } from "@qone/protocol";

interface ExecutionDisclosureState {
  overrides: Record<string, boolean>;
  setCollapsed: (key: string, collapsed: boolean) => void;
}

/** Only user choices are retained. Automatic collapse remains derived from the run. */
export const useExecutionDisclosureState = create<ExecutionDisclosureState>((set) => ({
  overrides: {},
  setCollapsed: (key, collapsed) => set((state) => ({
    overrides: { ...state.overrides, [key]: collapsed },
  })),
}));

export function executionCollapsed(override: boolean | undefined, finalAnswerStarted: boolean, activitySettled: boolean, cancelled: boolean): boolean {
  return override ?? (finalAnswerStarted && activitySettled && !cancelled);
}

export function executionStatusAtStart(finalAnswerStarted: boolean, runStatus: RunInfo["status"] | undefined, messageRunning: boolean): boolean {
  return finalAnswerStarted && runStatus !== "cancelled" && runStatus !== "interrupted"
    || runStatus === "completed"
    || runStatus === "failed"
    || runStatus === "created" || runStatus === "running" || runStatus === "paused" || runStatus === "waiting_approval"
    || !runStatus && messageRunning;
}

// 流式消息 "streaming" 在运行结束被替换为持久化消息 ID 时会触发组件重建，
// 记录其卸载前尚未完成的折叠高度，让重建后的组件无缝续播收起动画。
const collapseHandoffs = new Map<string, { height: number; at: number }>();
const COLLAPSE_HANDOFF_TTL_MS = 200;

export function saveCollapseHandoff(key: string, height: number): void {
  if (height <= 1) return;
  collapseHandoffs.set(key, { height, at: performance.now() });
}

export function clearCollapseHandoff(key: string): void {
  collapseHandoffs.delete(key);
}

export function takeCollapseHandoff(key: string): number | null {
  const entry = collapseHandoffs.get(key);
  collapseHandoffs.delete(key);
  if (!entry || performance.now() - entry.at > COLLAPSE_HANDOFF_TTL_MS) return null;
  return entry.height;
}
