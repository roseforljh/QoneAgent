import { create } from "zustand";

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
