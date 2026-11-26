import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import {
  PAGE_TRANSITION_VARIANTS,
  REDUCED_PAGE_TRANSITION_VARIANTS,
  pageTransitionDirection,
  type PageTransitionDirection,
  type PageTransitionKey,
} from "../../lib/page-transition";

function PageTransitionLayer({ direction, children }: { direction: PageTransitionDirection; children: ReactNode }) {
  const isPresent = useIsPresent();
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className="q-app-page-layer"
      custom={direction}
      variants={reduceMotion ? REDUCED_PAGE_TRANSITION_VARIANTS : PAGE_TRANSITION_VARIANTS}
      initial="enter"
      animate="center"
      exit="exit"
      style={{ zIndex: isPresent ? 2 : 1, pointerEvents: isPresent ? "auto" : "none" }}
      inert={!isPresent}
      aria-hidden={!isPresent}
    >
      {children}
    </motion.div>
  );
}

/** 顶层页面过渡容器：双层叠加切换，任意时刻打断或反向切换都能平滑衔接且无空白帧。 */
export function PageTransitionStage({ pageKey, children }: { pageKey: PageTransitionKey; children: ReactNode }) {
  const [transition, setTransition] = useState<{ key: PageTransitionKey; direction: PageTransitionDirection }>({
    key: pageKey,
    direction: 1,
  });
  let direction = transition.direction;
  if (transition.key !== pageKey) {
    direction = pageTransitionDirection(transition.key, pageKey) || 1;
    setTransition({ key: pageKey, direction });
  }

  return (
    <AnimatePresence initial={false} custom={direction}>
      <PageTransitionLayer key={pageKey} direction={direction}>
        {children}
      </PageTransitionLayer>
    </AnimatePresence>
  );
}
