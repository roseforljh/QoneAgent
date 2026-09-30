export interface ScrollRegionOptions {
  autoFollow?: () => boolean;
  getViewport?: () => HTMLElement | null;
  onEdgesChange: (edges: { top: boolean; bottom: boolean }) => void;
}

function maxScrollTop(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function atBottom(element: HTMLElement): boolean {
  // scrollTop can be fractional while scrollHeight/clientHeight are integers.
  return maxScrollTop(element) - element.scrollTop <= 1;
}

function wheelPixels(event: WheelEvent, element: HTMLElement): number {
  if (event.deltaMode === 0) return event.deltaY;
  if (event.deltaMode === 2) return event.deltaY * element.clientHeight;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const lineHeight = parseFloat(style?.lineHeight ?? "");
  const fontSize = parseFloat(style?.fontSize ?? "");
  const lineSize = Number.isFinite(lineHeight) ? lineHeight : fontSize;
  return Number.isFinite(lineSize) ? event.deltaY * lineSize : 0;
}

function boundedTop(element: HTMLElement, delta: number): number {
  return Math.max(0, Math.min(maxScrollTop(element), element.scrollTop + delta));
}

/** Own one wheel gesture end-to-end so Chromium scroll latching cannot lose
 * the remainder at a nested boundary. The parent comes from the real viewport
 * registration, not a CSS selector or a guessed DOM ancestor. */
export function bindScrollRegion(
  element: HTMLElement,
  content: HTMLElement,
  options: ScrollRegionOptions,
): () => void {
  let following = element.clientHeight === 0 || atBottom(element);

  const updateEdges = () => {
    options.onEdgesChange({
      top: element.scrollTop > 1,
      bottom: !atBottom(element),
    });
  };
  const onScroll = () => {
    following = atBottom(element);
    updateEdges();
  };
  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey
      || Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.deltaY === 0) return;

    // Cancel following before ResizeObserver can pin an upward reading gesture.
    if (event.deltaY < 0) following = false;
    if (!event.cancelable || element.clientHeight === 0) return;
    const viewport = options.getViewport?.();
    if (!viewport || viewport === element || !viewport.contains(element)) return;

    const delta = wheelPixels(event, element);
    if (!Number.isFinite(delta) || delta === 0) return;
    const innerTop = boundedTop(element, delta);
    const innerConsumed = innerTop - element.scrollTop;
    const outerTop = boundedTop(viewport, delta - innerConsumed);
    if (innerConsumed === 0 && outerTop === viewport.scrollTop) return;

    // Non-passive listener: native scrolling must not run a second time.
    event.preventDefault();
    if (!event.defaultPrevented) return;
    if (innerConsumed !== 0) element.scrollTo({ top: innerTop, behavior: "instant" });
    if (outerTop !== viewport.scrollTop) viewport.scrollTo({ top: outerTop, behavior: "instant" });
    following = event.deltaY > 0 && atBottom(element);
    updateEdges();
  };
  const observer = new ResizeObserver(() => {
    // Stream following belongs only to this region. Reaching its bottom during
    // a resize is NOT user intent to jump the entire conversation to the end.
    if (element.clientHeight > 0 && options.autoFollow?.() && following) {
      element.scrollTo({ top: maxScrollTop(element), behavior: "instant" });
    }
    updateEdges();
  });

  updateEdges();
  element.addEventListener("scroll", onScroll, { passive: true });
  element.addEventListener("wheel", onWheel, { passive: false });
  observer.observe(element);
  observer.observe(content);
  return () => {
    element.removeEventListener("scroll", onScroll);
    element.removeEventListener("wheel", onWheel);
    observer.disconnect();
  };
}
