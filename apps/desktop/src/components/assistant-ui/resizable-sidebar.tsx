import { useLocale } from "../../localization";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  clampSidebarWidth, defaultSidebarWidth, sidebarResizeState, sidebarWidthBounds,
} from "../../lib/sidebar-layout";
import { usePaneSizes } from "../../lib/pane-size-preferences";
import { usePaneResize } from "../../lib/use-pane-resize";
import { usePaneMotion } from "../../lib/use-pane-motion";
import { SIDEBAR_VISIBILITY_TRANSITION } from "../../lib/pane-motion";
import "./pane-layout.css";

export function ResizableSidebar({ collapsed, onCollapsedChange, children, collapsedContent }: {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  children: ReactNode;
  collapsedContent?: ReactNode;
}) {
  const { t } = useLocale();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [shellWidth, setShellWidth] = useState(() => typeof window === "undefined" ? Infinity : window.innerWidth);
  const preferredWidth = usePaneSizes((state) => state.sidebarWidth);
  const setPreferredWidth = usePaneSizes((state) => state.setSidebarWidth);
  const [dragWidth, setDragWidth] = useState<number>();
  const width = clampSidebarWidth(dragWidth ?? preferredWidth, shellWidth);
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
    if (next.open) setDragWidth(next.width);
  };
  const saveSize = (rawWidth: number) => {
    const next = sidebarResizeState(rawWidth, shellWidth);
    if (!next.open) return;
    // Store the user's chosen width in the unconstrained coordinate space.
    // The current window only limits what can be rendered right now.
    setPreferredWidth(clampSidebarWidth(rawWidth, Infinity));
  };
  const { dragging, startResize, cancelResize } = usePaneResize({
    direction: 1, getSize: () => width, onSize: applySize, onEnd: saveSize,
    onFinish: () => setDragWidth(undefined),
  });
  const animatedWidth = usePaneMotion({
    open: !collapsed, size: width, transition: SIDEBAR_VISIBILITY_TRANSITION, immediate: Boolean(reduceMotion),
  });
  return (
    <div ref={setElement} className="q-sidebar-pane relative flex h-full shrink-0"
      data-resizing={dragging || undefined}>
      <motion.div className="relative h-full shrink-0" style={{ width: animatedWidth }}>
        <div className="q-sidebar-clip" inert={collapsed} aria-hidden={collapsed}>
          <div className="q-sidebar-frame" style={{ width, minWidth: width }}>{children}</div>
        </div>
        {(!collapsed || dragging) && <div role="separator" aria-label={t("sidebar.resize")}
          aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width}
          tabIndex={collapsed ? -1 : 0} className="q-sidebar-resizer" onPointerDown={startResize}
          onKeyDown={(event) => {
            const next = event.key === "ArrowLeft" ? width - 10 : event.key === "ArrowRight" ? width + 10
              : event.key === "Home" ? minimum : event.key === "End" ? maximum : undefined;
            if (next === undefined) return;
            event.preventDefault();
            const size = clampSidebarWidth(next, shellWidth);
            onCollapsedChange(false); saveSize(size);
          }} onDoubleClick={() => {
            cancelResize();
            const size = defaultSidebarWidth(shellWidth);
            onCollapsedChange(false); saveSize(size);
          }}><span /></div>}
      </motion.div>
      {collapsedContent}
    </div>
  );
}
