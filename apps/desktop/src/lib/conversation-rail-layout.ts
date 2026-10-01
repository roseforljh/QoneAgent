// floating-navigation-rail-layout / h in Codex 26.928.2636.
const MIN_NAVIGATION_GUTTER = 48;

export function hasConversationRailSpace(gutter: number | undefined, rectWidth: number, offsetWidth: number) {
  if (gutter === undefined) return false;
  const scale = offsetWidth > 0 && rectWidth > 0 ? rectWidth / offsetWidth : 1;
  return gutter / scale >= MIN_NAVIGATION_GUTTER;
}

/** Measure the fixed content column, never a bubble or a content-visibility turn. */
export function hasConversationRailSpaceInViewport(viewport: Pick<HTMLElement, "getBoundingClientRect" | "offsetWidth"> & {
  querySelector(selector: string): Pick<HTMLElement, "getBoundingClientRect"> | null;
}, side: "left" | "right" = "left") {
  const content = viewport.querySelector("[data-conversation-rail-content]");
  if (!content) return false;
  const view = viewport.getBoundingClientRect();
  const column = content.getBoundingClientRect();
  if (view.width <= 0 || column.width <= 0) return false;
  const gutter = side === "left" ? column.left - view.left : view.right - column.right;
  return hasConversationRailSpace(gutter, view.width, viewport.offsetWidth);
}

type RailBlock = { dataset: { turnId?: string }; getBoundingClientRect(): { top: number; bottom: number } };

/** Turn blocks follow document order. Only measure search boundaries and visible turns. */
export function measureConversationRail(blocks: ArrayLike<RailBlock>, view: { top: number; bottom: number }, line: number) {
  const boxes = new Map<number, { top: number; bottom: number }>();
  const box = (index: number) => {
    let value = boxes.get(index);
    if (!value) { value = blocks[index]!.getBoundingClientRect(); boxes.set(index, value); }
    return value;
  };
  const first = (matches: (index: number) => boolean, end = blocks.length) => {
    let start = 0;
    while (start < end) {
      const middle = start + Math.floor((end - start) / 2);
      if (matches(middle)) end = middle;
      else start = middle + 1;
    }
    return start;
  };
  const end = first((index) => box(index).top >= view.bottom);
  const activeEnd = first((index) => box(index).top > line, end);
  let activeId: string | undefined;
  for (let index = activeEnd - 1; index >= 0 && activeId === undefined; index--) activeId = blocks[index]!.dataset.turnId;
  if (activeId === undefined) {
    for (let index = 0; index < end && activeId === undefined; index++) activeId = blocks[index]!.dataset.turnId;
  }
  const start = first((index) => box(index).bottom > view.top, end);
  const visible = new Set<string>();
  for (let index = start; index < end; index++) {
    const id = blocks[index]!.dataset.turnId;
    if (id !== undefined) visible.add(id);
  }
  return { activeId, visibleIds: [...visible] };
}
