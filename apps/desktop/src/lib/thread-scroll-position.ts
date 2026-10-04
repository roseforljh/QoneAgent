export interface ThreadReadingAnchor {
  messageId: string;
  offsetPx: number;
}

const messageSelector = ".q-message-root[data-message-id]";

function messageElements(content: HTMLElement) {
  return [...content.querySelectorAll<HTMLElement>(messageSelector)];
}

function isWithinViewport(rect: DOMRect, viewportRect: DOMRect) {
  return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
}

/** Capture a stable message position instead of relying only on scrollHeight. */
export function captureThreadReadingAnchor(viewport: HTMLElement, content: HTMLElement): ThreadReadingAnchor | undefined {
  const viewportRect = viewport.getBoundingClientRect();
  const candidates = messageElements(content)
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => isWithinViewport(rect, viewportRect));
  const visible = candidates.find(({ rect }) => rect.top >= viewportRect.top) ?? candidates.at(-1);
  const messageId = visible?.element.dataset.messageId;
  return messageId ? { messageId, offsetPx: visible!.rect.top - viewportRect.top } : undefined;
}

/** Restore the captured message to the same viewport offset after layout. */
export function restoreThreadReadingAnchor(viewport: HTMLElement, content: HTMLElement, anchor: ThreadReadingAnchor) {
  const target = messageElements(content).find((element) => element.dataset.messageId === anchor.messageId);
  if (!target) return false;
  const viewportRect = viewport.getBoundingClientRect();
  const offsetPx = target.getBoundingClientRect().top - viewportRect.top;
  const delta = offsetPx - anchor.offsetPx;
  if (Math.abs(delta) > 1) viewport.scrollTo({ top: viewport.scrollTop + delta, behavior: "instant" });
  return true;
}
