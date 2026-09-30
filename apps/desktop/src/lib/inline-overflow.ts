/** Observe both available width and natural content width (including streamed labels). */
export function observeInlineOverflow(
  viewport: HTMLElement,
  content: HTMLElement,
  onChange: (overflow: boolean) => void,
): () => void {
  let available = viewport.getBoundingClientRect().width;
  let natural = content.getBoundingClientRect().width;
  let previous: boolean | undefined;
  const publish = () => {
    // Hidden/collapsed ancestors have no usable width; rounding is not overflow.
    const overflow = available > 0 && natural > available + 1;
    if (overflow !== previous) {
      previous = overflow;
      onChange(overflow);
    }
  };
  publish();
  const observer = new ResizeObserver((entries) => {
    // RO already performed layout. Reuse its sizes rather than force layout
    // reads on every frame of SwapLabel's width transition.
    for (const entry of entries) {
      if (entry.target === viewport) available = entry.contentRect.width;
      if (entry.target === content) natural = entry.contentRect.width;
    }
    publish();
  });
  observer.observe(viewport);
  observer.observe(content);
  return () => observer.disconnect();
}
