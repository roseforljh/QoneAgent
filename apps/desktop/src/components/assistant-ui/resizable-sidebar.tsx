import { useLayoutEffect, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, defaultSidebarWidth,
  readSavedSidebarWidth, sidebarResizeState, sidebarWidthBounds, SIDEBAR_WIDTH_STORAGE_KEY,
} from "../../lib/sidebar-layout";
import { usePaneResize } from "../../lib/use-pane-resize";
import { usePaneMotion } from "../../lib/use-pane-motion";
import { SIDEBAR_VISIBILITY_TRANSITION } from "../../lib/pane-motion";
import "./pane-layout.css";

export function ResizableSidebar({ collapsed, onCollapsedChange, children }: {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  children: ReactNode;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [shellWidth, setShellWidth] = useState(() => typeof window === "undefined" ? Infinity : window.innerWidth);
  const [preferredWidth, setPreferredWidth] = useState(() => readSavedSidebarWidth() ?? DEFAULT_SIDEBAR_WIDTH);
  const width = clampSidebarWidth(preferredWidth, shellWidth);
  const { minimum, maximum } = sidebarWidthBounds(shellWidth);
  const reduceMotion = useReducedMotion();
  useLayoutEffect(() => {
    const shell = element?.parentElement;
    if (!shell) return;
    const measure = () => setShellWidth(shell.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    measure();
    return () => observer.disconnect();
  }, [element]);
  const applySize = (rawWidth: number) => {
    const next = sidebarResizeState(rawWidth, shellWidth);
    onCollapsedChange(!next.open);
    if (next.open) setPreferredWidth(clampSidebarWidth(rawWidth, Infinity));
  };
  const saveSize = (rawWidth: number) => {
    const next = sidebarResizeState(rawWidth, shellWidth);
    if (!next.open) return;
    try { window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(rawWidth, Infinity))); }
    catch { /* Session retains the preferred width even without storage. */ }
  };
  const { dragging, startResize, cancelResize } = usePaneResize({
    direction: 1, getSize: () => width, onSize: applySize, onEnd: saveSize,
  });
  const animatedWidth = usePaneMotion({
    open: !collapsed, size: width, transition: SIDEBAR_VISIBILITY_TRANSITION, immediate: Boolean(reduceMotion),
  });
  return (
    <motion.div ref={setElement} className="q-sidebar-pane relative h-full shrink-0"
      data-resizing={dragging || undefined}
      style={{ width: animatedWidth }}>
      <div className="q-sidebar-clip" inert={collapsed} aria-hidden={collapsed}>
        <div className="q-sidebar-frame" style={{ width, minWidth: width }}>{children}</div>
      </div>
      {(!collapsed || dragging) && <div role="separator" aria-label="调整左侧栏宽度"
        aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width}
        tabIndex={collapsed ? -1 : 0} className="q-sidebar-resizer" onPointerDown={startResize}
        onKeyDown={(event) => {
          const next = event.key === "ArrowLeft" ? width - 10 : event.key === "ArrowRight" ? width + 10
            : event.key === "Home" ? minimum : event.key === "End" ? maximum : undefined;
          if (next === undefined) return;
          event.preventDefault();
          const size = clampSidebarWidth(next, shellWidth);
          applySize(size); saveSize(size);
        }} onDoubleClick={() => {
          cancelResize();
          const size = defaultSidebarWidth(shellWidth);
          applySize(size); saveSize(size);
        }}><span /></div>}
    </motion.div>
  );
}
