import type { QuoteInfo } from "@assistant-ui/react";

export interface MessageSelection {
  quote: QuoteInfo;
  rect: DOMRect;
  target: HTMLElement;
}

const selectable = '[data-aui-quote-selectable="true"]';
const excluded = 'button, input, textarea, [contenteditable="true"], [data-aui-quote-selectable="false"]';
const elementOf = (node: Node | null) => node?.nodeType === 1 ? node as HTMLElement : node?.parentElement;

/** DOM ownership matters: a side chat can contain copies of the same message IDs. */
export function readMessageSelection(scope: HTMLElement): MessageSelection | null {
  const view = scope.ownerDocument.defaultView;
  const selection = view?.getSelection();
  if (!view || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const anchor = elementOf(selection.anchorNode);
  const focus = elementOf(selection.focusNode);
  const target = anchor?.closest<HTMLElement>(selectable);
  if (!target || !scope.contains(target) || focus?.closest(selectable) !== target) return null;
  if (anchor?.closest(excluded) || focus?.closest(excluded)) return null;
  const message = target.closest<HTMLElement>("[data-message-id]");
  const messageId = message?.dataset.messageId;
  if (!messageId || !scope.contains(message)) return null;
  const range = selection.getRangeAt(0);
  if (!target.contains(range.commonAncestorContainer)) return null;
  for (const node of target.querySelectorAll(excluded)) if (range.intersectsNode(node)) return null;
  const text = selection.toString().trim();
  if (!text) return null;

  const bounds = scope.getBoundingClientRect();
  const viewport = target.closest<HTMLElement>(".aui-viewport")?.getBoundingClientRect() ?? bounds;
  const footer = scope.querySelector<HTMLElement>("[data-thread-scroll-footer]")?.getBoundingClientRect();
  const top = Math.max(0, bounds.top, viewport.top);
  const bottom = Math.min(view.innerHeight, bounds.bottom, viewport.bottom, footer?.top ?? Infinity);
  const left = Math.max(0, bounds.left, viewport.left);
  const right = Math.min(view.innerWidth, bounds.right, viewport.right);
  // Use the first visible line, including reverse and multi-line selections.
  const line = Array.from(range.getClientRects()).find((rect) => rect.width > 0 && rect.height > 0
    && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right);
  if (!line) return null;
  const rect = new view.DOMRect(Math.max(left, line.left), Math.max(top, line.top),
    Math.min(right, line.right) - Math.max(left, line.left), Math.min(bottom, line.bottom) - Math.max(top, line.top));
  return { quote: { text, messageId }, rect, target };
}

/** One scoped listener per visible thread; no work per message or per streamed token. */
export function watchMessageSelection(scope: HTMLElement, toolbar: () => HTMLElement | null, onChange: (selection: MessageSelection | null) => void) {
  const doc = scope.ownerDocument;
  const view = doc.defaultView!;
  let frame: number | undefined;
  let dragging = false;
  const cancel = () => { if (frame !== undefined) view.cancelAnimationFrame(frame); frame = undefined; };
  const update = () => {
    cancel();
    if (dragging) return;
    frame = view.requestAnimationFrame(() => { frame = undefined; onChange(readMessageSelection(scope)); });
  };
  const insideToolbar = (event: Event) => event.target instanceof view.Node && toolbar()?.contains(event.target);
  const down = (event: Event) => {
    if (insideToolbar(event)) return;
    dragging = true; cancel(); onChange(null);
  };
  const up = () => { dragging = false; update(); };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") { cancel(); onChange(null); return; }
    if (!insideToolbar(event)) update();
  };
  const blur = () => { dragging = false; cancel(); onChange(null); };
  doc.addEventListener("selectionchange", update);
  doc.addEventListener("pointerdown", down);
  doc.addEventListener("pointerup", up);
  doc.addEventListener("pointercancel", up);
  doc.addEventListener("keyup", key);
  doc.addEventListener("scroll", update, true);
  view.addEventListener("resize", update);
  view.addEventListener("blur", blur);
  const observer = new view.ResizeObserver(update);
  observer.observe(scope);
  return () => {
    cancel(); observer.disconnect();
    doc.removeEventListener("selectionchange", update);
    doc.removeEventListener("pointerdown", down);
    doc.removeEventListener("pointerup", up);
    doc.removeEventListener("pointercancel", up);
    doc.removeEventListener("keyup", key);
    doc.removeEventListener("scroll", update, true);
    view.removeEventListener("resize", update);
    view.removeEventListener("blur", blur);
  };
}
