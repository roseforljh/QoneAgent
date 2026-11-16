import { useEffect, useRef, useState } from "react";

const DRAIN_MS = 250;
const MAX_CHAR_MS = 5;

/** Next revealed prefix: drains the backlog within ~250ms, at least one char per 5ms. */
export function nextSmoothText(shown: string, goal: string, elapsedMs: number): string {
  if (!goal.startsWith(shown)) return goal;
  const remaining = goal.length - shown.length;
  if (remaining <= 0) return shown;
  const chars = Math.max(1, Math.ceil(remaining * Math.min(1, elapsedMs / DRAIN_MS)), Math.floor(elapsedMs / MAX_CHAR_MS));
  let end = Math.min(goal.length, shown.length + chars);
  // Never cut a surrogate pair (emoji) in half for a frame.
  const code = goal.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff && end < goal.length) end += 1;
  return goal.slice(0, end);
}

/**
 * Reveals text appended while `running` frame by frame. Text present at mount
 * shows at once, so remounting a live message never retypes it.
 */
export function useSmoothText(text: string, running: boolean): string {
  const animate = running && typeof matchMedia === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shown = useRef(text);
  const [, rerender] = useState(0);
  // Replaced text, finished runs and reduced motion show the full text at once.
  if (!animate || !text.startsWith(shown.current)) shown.current = text;

  useEffect(() => {
    if (!animate || shown.current === text) return undefined;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      shown.current = nextSmoothText(shown.current, text, now - last);
      last = now;
      rerender((tick) => tick + 1);
      if (shown.current !== text) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [animate, text]);

  return shown.current;
}
