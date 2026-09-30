import { animate, type MotionValue, type Transition } from "motion/react";

// Codex gIt/Tqr: live pane size multiplied by a separate open/close progress.
export function paneWidthAtProgress(size: number, progress: number) {
  return size * Math.max(0, Math.min(1, progress));
}

export const SIDEBAR_VISIBILITY_TRANSITION: Transition = { type: "spring", duration: 0.35, bounce: 0.1 };
export const DOCK_VISIBILITY_TRANSITION: Transition = { type: "spring", duration: 0.5, bounce: 0.1 };

export function animatePaneVisibility(progress: MotionValue<number>, open: boolean, transition: Transition, immediate: boolean) {
  progress.stop();
  if (immediate) {
    progress.set(Number(open));
    return undefined;
  }
  return animate(progress, Number(open), transition);
}
