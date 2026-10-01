import { getFloatingBoundaries } from "./floating-boundaries";

/** React ref for upward composer suggestions, whose positioning stays with assistant-ui. */
export function bindTopPopupHeight(popup: HTMLDivElement | null): (() => void) | undefined {
  const view = popup?.ownerDocument.defaultView;
  if (!popup || !view) return;
  const boundaries = getFloatingBoundaries(popup);
  let frame: number | undefined;
  let previousHeight: number | undefined;

  const update = () => {
    frame = undefined;
    const viewport = view.visualViewport;
    let top = viewport?.offsetTop ?? 0;
    let bottom = top + (viewport?.height ?? view.innerHeight);
    for (const boundary of boundaries) {
      const rect = boundary.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
    const height = Math.max(0, Math.min(bottom, popup.getBoundingClientRect().bottom) - top);
    if (height !== previousHeight) {
      previousHeight = height;
      popup.style.setProperty("--q-popup-available-height", `${height}px`);
    }
  };
  const schedule = () => {
    if (frame === undefined) frame = view.requestAnimationFrame(update);
  };
  const onScroll = (event: Event) => { if (event.target !== popup) schedule(); };
  update();
  const observer = new ResizeObserver(schedule);
  const targets = new Set([popup, ...boundaries]);
  if (popup.parentElement) targets.add(popup.parentElement);
  targets.forEach((target) => observer.observe(target));
  view.addEventListener("resize", schedule);
  view.addEventListener("scroll", onScroll, true);
  view.visualViewport?.addEventListener("resize", schedule);
  view.visualViewport?.addEventListener("scroll", schedule);

  return () => {
    observer.disconnect();
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    view.removeEventListener("resize", schedule);
    view.removeEventListener("scroll", onScroll, true);
    view.visualViewport?.removeEventListener("resize", schedule);
    view.visualViewport?.removeEventListener("scroll", schedule);
    popup.style.removeProperty("--q-popup-available-height");
  };
}
