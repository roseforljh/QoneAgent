import { measureConversationRail } from "./conversation-rail-layout";

export function observeConversationRail(viewport: HTMLElement, onChange: (value: { activeId?: string; visibleIds: string[] }) => void) {
  let blocks: HTMLElement[] = [];
  let positions = new Map<HTMLElement, number>();
  let measured: Parameters<typeof measureConversationRail>[0] = [];
  const boxes = new Map<HTMLElement, { top: number; bottom: number }>();
  let view: { top: number; bottom: number } | undefined;
  let scrollHeight = viewport.scrollHeight;
  const inset = Number.parseFloat(getComputedStyle(viewport).scrollPaddingTop) || 0;
  const update = () => {
    if (!view || boxes.size < blocks.length) return;
    const scrollTop = viewport.scrollTop;
    const top = Math.min(view.bottom, view.top + inset);
    const height = view.bottom - top;
    const remaining = scrollHeight - viewport.clientHeight - scrollTop;
    const line = top + height * Math.min(1, Math.max(0, height > 0 ? (height - remaining) / height : 0)) + 1;
    onChange(measureConversationRail(measured, view, line));
  };
  const intersection = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!positions.has(entry.target as HTMLElement)) continue;
      if (entry.rootBounds) view = { top: entry.rootBounds.top, bottom: entry.rootBounds.bottom };
      boxes.set(entry.target as HTMLElement, { top: entry.boundingClientRect.top + viewport.scrollTop, bottom: entry.boundingClientRect.bottom + viewport.scrollTop });
    }
    update();
  }, { root: viewport, threshold: [0, 1] });
  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const block = entry.target as HTMLElement;
      const box = boxes.get(block);
      const size = entry.borderBoxSize[0]?.blockSize;
      if (!box || size === undefined) continue;
      const difference = size - (box.bottom - box.top);
      if (!difference) continue;
      box.bottom += difference;
      const index = positions.get(block)!;
      for (let next = index + 1; next < blocks.length; next++) {
        const following = boxes.get(blocks[next]!);
        if (following) { following.top += difference; following.bottom += difference; }
      }
    }
    scrollHeight = viewport.scrollHeight;
    update();
  });
  const content = viewport.querySelector<HTMLElement>("[data-conversation-rail-content]")?.parentElement;
  resize.observe(viewport);
  if (content) resize.observe(content);
  const refresh = () => {
    const next = [...viewport.querySelectorAll<HTMLElement>("[data-turn-id]")];
    const nextPositions = new Map(next.map((block, index) => [block, index]));
    const removed = blocks.filter((block) => !nextPositions.has(block));
    for (const block of removed) { intersection.unobserve(block); resize.unobserve(block); boxes.delete(block); }
    for (const block of next) if (!positions.has(block)) { intersection.observe(block); resize.observe(block); }
    blocks = next;
    positions = nextPositions;
    measured = blocks.map((block) => ({ dataset: block.dataset, getBoundingClientRect: () => {
      const box = boxes.get(block)!;
      return { top: box.top - viewport.scrollTop, bottom: box.bottom - viewport.scrollTop };
    } }));
    scrollHeight = viewport.scrollHeight;
    update();
  };
  refresh();
  viewport.addEventListener("scroll", update, { passive: true });
  return { refresh, dispose: () => { intersection.disconnect(); resize.disconnect(); viewport.removeEventListener("scroll", update); } };
}
