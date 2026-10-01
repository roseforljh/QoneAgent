/** Bound nested popups to the visible scroll surfaces inside their owning dialog. */
export function getFloatingBoundaries(anchor: HTMLElement): HTMLElement[] {
  const view = anchor.ownerDocument.defaultView;
  if (!view) return [];

  const boundaries: HTMLElement[] = [];
  for (let parent = anchor.parentElement; parent && parent !== anchor.ownerDocument.body; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    const isDialog = ["dialog", "alertdialog"].includes(parent.getAttribute("role") ?? "") || parent.tagName === "DIALOG";
    if (isDialog || [style.overflowX, style.overflowY].some((overflow) => ["auto", "scroll", "hidden", "clip"].includes(overflow))) {
      boundaries.push(parent);
    }
    // A child dialog can have its own containing block outside an outer scrollport.
    if (isDialog) break;
  }
  return boundaries;
}
