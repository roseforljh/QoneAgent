import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { trackPanePointerResize } from "./pane-pointer-resize";

export function usePaneResize(options: {
  direction: 1 | -1;
  getSize: () => number;
  onSize: (size: number) => void;
  onEnd: (size: number) => void;
  onFinish?: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => cleanup.current?.(), []);
  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || cleanup.current) return;
    event.preventDefault();
    const target = event.currentTarget;
    const container = target.parentElement;
    const scale = container && container.offsetWidth > 0
      ? container.getBoundingClientRect().width / container.offsetWidth : 1;
    const root = document.documentElement;
    const previous = root.dataset.paneResizing;
    root.dataset.paneResizing = "true";
    setDragging(true);
    cleanup.current = trackPanePointerResize({
      events: window, target, pointerId: event.pointerId, startX: event.clientX,
      startSize: latest.current.getSize(), direction: latest.current.direction, scale,
      onSize: (size) => latest.current.onSize(size),
      onEnd: (size) => latest.current.onEnd(size),
      onFinish: () => {
        cleanup.current = undefined;
        if (previous === undefined) delete root.dataset.paneResizing;
        else root.dataset.paneResizing = previous;
        setDragging(false);
        latest.current.onFinish?.();
      },
    });
  }, []);
  return { dragging, startResize, cancelResize: () => cleanup.current?.() };
}
