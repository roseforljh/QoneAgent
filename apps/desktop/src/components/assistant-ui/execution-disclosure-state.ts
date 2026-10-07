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
