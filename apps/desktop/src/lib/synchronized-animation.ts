/** Align CSS animations to the document clock, including animations mounted later. */
export function synchronizeDocumentAnimations(element: Element): void {
  const timeline = element.ownerDocument.timeline;
  for (const animation of element.getAnimations({ subtree: true })) {
    // Other timelines (for example scroll-driven ones) have a different origin.
    if (animation.timeline === timeline) animation.startTime = 0;
  }
}
