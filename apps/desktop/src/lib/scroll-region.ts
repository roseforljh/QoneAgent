export interface ScrollRegionOptions {
  autoFollow?: () => boolean;
  onEdgesChange: (edges: { top: boolean; bottom: boolean }) => void;
}

function maxScrollTop(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function atBottom(element: HTMLElement): boolean {
  // scrollTop can be fractional while scrollHeight/clientHeight are integers.
  return maxScrollTop(element) - element.scrollTop <= 1;
}

/** Observe native scrolling without replacing its smoothing, momentum or
 * ancestor chaining with synchronous scrollTop writes on every wheel event. */
export function bindScrollRegion(
  element: HTMLElement,
  content: HTMLElement,
  options: ScrollRegionOptions,
): () => void {
  // Initial overflowing stream content has not been scrolled away by the user.
  let following = element.clientHeight === 0 || atBottom(element)
    || (element.scrollTop === 0 && Boolean(options.autoFollow?.()));
  let frame: number | null = null;
  let edges: { top: boolean; bottom: boolean } | undefined;
  let touchY: number | undefined;
  let previousScrollHeight = element.scrollHeight;
  let pointerActive = false;

  const updateEdges = () => {
    frame = null;
    const next = {
      top: element.scrollTop > 1,
      bottom: !atBottom(element),
    };
    if (edges?.top === next.top && edges.bottom === next.bottom) return;
    edges = next;
    options.onEdgesChange(next);
  };
  const scheduleEdges = () => {
    if (frame === null) frame = requestAnimationFrame(updateEdges);
  };
  const onScroll = () => {
    const scrollHeightChanged = element.scrollHeight !== previousScrollHeight;
    // Browser scroll anchoring can emit a scroll event before ResizeObserver
    // reports streamed content growth. That event is not user intent and
    // must not disable following. A scrollbar drag remains explicit intent
    // even when the content height changes during the drag.
    if (!scrollHeightChanged || pointerActive) following = atBottom(element);
    previousScrollHeight = element.scrollHeight;
    scheduleEdges();
  };
  const ownsGesture = (target: EventTarget | null) =>
    typeof Element === "undefined" || !(target instanceof Element)
      || (target.closest("[data-scroll-region]") ?? element) === element;
  const onWheel = (event: WheelEvent) => {
    if (!ownsGesture(event.target) || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey
      || Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.deltaY === 0) return;

    // Cancel following before ResizeObserver can pin an upward reading gesture.
    if (event.deltaY < 0) following = false;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!ownsGesture(event.target) || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (typeof Element !== "undefined" && target instanceof Element
      && target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (typeof Element !== "undefined" && target instanceof Element
      && target.closest("button, [role='button']") && (event.key === " " || event.key === "Spacebar")) return;
    if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home"
      || (event.shiftKey && (event.key === " " || event.key === "Spacebar"))) following = false;
  };
  const onTouchStart = (event: TouchEvent) => { touchY = ownsGesture(event.target) ? event.touches[0]?.clientY : undefined; };
  const onTouchMove = (event: TouchEvent) => {
    if (!ownsGesture(event.target)) return;
    const next = event.touches[0]?.clientY;
    if (next !== undefined && touchY !== undefined && next > touchY) following = false;
    touchY = next;
  };
  const onTouchEnd = () => { touchY = undefined; };
  const onPointerDown = () => { pointerActive = true; };
  const onPointerUp = () => { pointerActive = false; };
  const observer = new ResizeObserver(() => {
    // Stream following belongs only to this region. Reaching its bottom during
    // a resize is NOT user intent to jump the entire conversation to the end.
    if (element.clientHeight > 0 && options.autoFollow?.() && following && !atBottom(element)) {
      element.scrollTo({ top: maxScrollTop(element), behavior: "instant" });
    }
    previousScrollHeight = element.scrollHeight;
    scheduleEdges();
  });

  updateEdges();
  element.addEventListener("scroll", onScroll, { passive: true });
  element.addEventListener("wheel", onWheel, { passive: true });
  element.addEventListener("keydown", onKeyDown);
  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchmove", onTouchMove, { passive: true });
  element.addEventListener("touchend", onTouchEnd, { passive: true });
  element.addEventListener("touchcancel", onTouchEnd, { passive: true });
  element.addEventListener("pointerdown", onPointerDown, { passive: true });
  element.addEventListener("pointerup", onPointerUp, { passive: true });
  element.addEventListener("pointercancel", onPointerUp, { passive: true });
  observer.observe(element);
  observer.observe(content);
  return () => {
    element.removeEventListener("scroll", onScroll);
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("keydown", onKeyDown);
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchmove", onTouchMove);
    element.removeEventListener("touchend", onTouchEnd);
    element.removeEventListener("touchcancel", onTouchEnd);
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointerup", onPointerUp);
    element.removeEventListener("pointercancel", onPointerUp);
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
