import { useLayoutEffect, useState, type RefObject } from "react";
import { getFloatingBoundaries } from "../lib/floating-boundaries";

export function useFloatingBoundaries(anchorRef: RefObject<HTMLElement | null>, open: boolean) {
  const [boundaries, setBoundaries] = useState<HTMLElement[]>([]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!open || !anchor) {
      setBoundaries([]);
      return;
    }
    const next = getFloatingBoundaries(anchor);
    setBoundaries(next);
    if (!next.length) return;

    // Floating UI observes the trigger and popup; also update on parent-only resizes.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setBoundaries([...next]));
    next.forEach((boundary) => observer.observe(boundary));
    return () => observer.disconnect();
  }, [anchorRef, open]);

  return boundaries;
}
