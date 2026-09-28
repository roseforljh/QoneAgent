import { motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function MeasuredCollapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [hasOpened, setHasOpened] = useState(open);
  const [settled, setSettled] = useState(false);
  const renderContent = open || hasOpened;

  useEffect(() => {
    if (open) setHasOpened(true);
  }, [open]);

  useLayoutEffect(() => {
    if (!renderContent || !contentRef.current) return undefined;
    const content = contentRef.current;
    const update = () => setHeight(content.scrollHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  }, [renderContent]);

  return (
    <motion.div
      initial={false}
      animate={{ height: open ? height : 0, opacity: open ? 1 : 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.32, 0.72, 0, 1] }}
      onAnimationStart={() => setSettled(false)}
      onAnimationComplete={() => setSettled(true)}
      aria-hidden={!open}
      inert={!open}
      className={className}
      style={{ overflow: open && settled ? "visible" : "hidden", pointerEvents: open ? "auto" : "none" }}
    >
      {renderContent && <div ref={contentRef}>{children}</div>}
    </motion.div>
  );
}
