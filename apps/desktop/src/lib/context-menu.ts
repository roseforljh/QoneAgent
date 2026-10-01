import type { KeyboardEvent, MouseEvent } from "react";

/** Radix handles pointer gestures; keyboard gestures enter the same event path. */
export function openContextMenuFromKeyboard(event: KeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
  const target = event.target as HTMLElement;
  if (!event.currentTarget.contains(target)) return;
  if (target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
  const view = event.currentTarget.ownerDocument.defaultView;
  if (!view) return;
  const rect = event.currentTarget.getBoundingClientRect();
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.dispatchEvent(new view.MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom,
  }));
}

/** Linked media keep their native image menu instead of the enclosing link menu. */
export function preserveLinkedImageMenu(event: MouseEvent<HTMLElement>): void {
  const target = event.target as HTMLElement;
  if (target.closest?.("img:not([data-favicon]):not([data-favicon-fallback])")) event.stopPropagation();
}

/** Capture only this surface's selection, keeping code whitespace intact. */
export function contextMenuSelection(container: HTMLElement | null): string {
  const selection = container?.ownerDocument.getSelection();
  if (!container || !selection?.rangeCount || selection.isCollapsed) return "";
  if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return "";
  return selection.toString();
}
