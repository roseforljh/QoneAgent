import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const TRANSITION = { duration: 0.24, ease: [0.32, 0.72, 0, 1] as const };

export function MeasuredCollapse({ id, open, children, className, unmountOnClose = false }: {
  id?: string;
  open: boolean;
  children: ReactNode;
  className?: string;
  unmountOnClose?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">(open ? "auto" : 0);
  const opacity = useMotionValue(open ? 1 : 0);
  const [mounted, setMounted] = useState(open);
  const [settledOpen, setSettledOpen] = useState(open);
  const firstRun = useRef(true);

  useLayoutEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (open) setMounted(true);
    else setSettledOpen(false);
    // Animate between measured pixel heights. motion's "auto" keyframe resolves by
    // laying the panel out at its target height (0 when collapsing) in a forced
    // layout, which clamps the thread scroller's scrollTop and shakes the page.
    const from = rootRef.current?.getBoundingClientRect().height ?? 0;
    const to = open ? contentRef.current?.getBoundingClientRect().height ?? 0 : 0;
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      // At rest an open panel follows streamed content with natural layout.
      if (open) height.set("auto");
      setSettledOpen(open);
      if (!open && unmountOnClose) setMounted(false);
    };
    const duration = reduceMotion ? 0 : TRANSITION.duration;
    const heightAnimation = animate(height, [from, to], { ...TRANSITION, duration });
    const opacityAnimation = animate(opacity, open ? 1 : 0, { ...TRANSITION, duration });
    heightAnimation.then(finish);
    // A reversed toggle continues from the interrupted height.
    return () => { cancelled = true; heightAnimation.stop(); opacityAnimation.stop(); };
    // Runs per toggle only; the other inputs are read at toggle time.
  }, [open]);

  return (
    <motion.div
      ref={rootRef}
      id={id}
      aria-hidden={!open}
      inert={!open}
      className={className}
      // Unlike hidden, clip doesn't create a scroll container for sticky titles.
      style={{ height, opacity, overflow: open && settledOpen ? "visible" : "clip" }}
    >
      {/* flow-root contains child margins so the measured height equals the settled one. */}
      <div ref={contentRef} style={{ display: "flow-root" }}>{(open || mounted) && children}</div>
    </motion.div>
  );
}
