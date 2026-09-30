import { useLayoutEffect } from "react";
import { animate, useMotionValue, useTransform, type Transition } from "motion/react";
import { animatePaneVisibility, paneWidthAtProgress } from "./pane-motion";

export function usePaneMotion({ open, size, transition, immediate = false, animateSize = false }: {
  open: boolean;
  size: number;
  transition: Transition;
  immediate?: boolean;
  animateSize?: boolean;
}) {
  const progress = useMotionValue(Number(open));
  const frameWidth = useMotionValue(size);
  const width = useTransform(() => paneWidthAtProgress(frameWidth.get(), progress.get()));

  // Pointer moves update only the frame size; they never cancel visibility animation.
  useLayoutEffect(() => {
    const animation = animatePaneVisibility(progress, open, transition, immediate);
    return () => animation?.stop();
  }, [progress, open, transition, immediate]);

  useLayoutEffect(() => {
    frameWidth.stop();
    if (!animateSize || immediate) {
      frameWidth.set(size);
      return;
    }
    const animation = animate(frameWidth, size, transition);
    return () => animation.stop();
  }, [frameWidth, size, animateSize, transition, immediate]);

  return width;
}
