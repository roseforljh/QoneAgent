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
