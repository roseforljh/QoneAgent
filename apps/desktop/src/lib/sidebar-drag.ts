export interface SidebarDrop {
  kind: "session" | "workspace";
  source: string;
  target: string;
  after: boolean;
}

const ROW = "[data-sidebar-drag-id]";
const HANDLE = "[data-sidebar-drag-handle]";
const PRESS_SLOP_PX = 6;
const SCROLL_EDGE_PX = 40;
const SCROLL_SPEED_PX = 600;

/** One delegated pointer gesture for both sidebar layouts; no native HTML drag dependency. */
export function bindSidebarDrag(root: HTMLElement, onDrop: (drop: SidebarDrop) => void, onMove?: (drop: SidebarDrop) => void) {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (!view) return () => {};
  let press: {
    row: HTMLElement; pointerId: number; startX: number; startY: number;
    x: number; y: number; active: boolean; scroller?: HTMLElement;
  } | undefined;
  let frame: number | undefined;
  let previousTime: number | undefined;
  let ghost: HTMLElement | undefined;
  let target: HTMLElement | undefined;
  let after = false;
  let lastMoveKey: string | undefined;
  let suppressClick = false;

  const clearTarget = () => { target?.removeAttribute("data-drop-edge"); target = undefined; };
  const findScroller = (row: HTMLElement) => {
    for (let node = row.parentElement; node && root.contains(node); node = node.parentElement) {
      if (/(auto|scroll)/.test(view.getComputedStyle(node).overflowY)) return node;
    }
    return undefined;
  };
  const updateTarget = () => {
    clearTarget();
    if (!press?.active) return;
    const bounds = (press.scroller ?? root).getBoundingClientRect();
    if (press.x < bounds.left || press.x > bounds.right || press.y < bounds.top || press.y > bounds.bottom) return;
    const row = doc.elementFromPoint(press.x, press.y)?.closest<HTMLElement>(ROW);
    if (!row || row === press.row || !root.contains(row) || row.dataset.sidebarDragGroup !== press.row.dataset.sidebarDragGroup || row.dataset.sidebarDragKind !== press.row.dataset.sidebarDragKind) return;
    const rect = row.getBoundingClientRect();
    after = press.y >= rect.top + rect.height / 2;
    target = row;
    target.dataset.dropEdge = after ? "after" : "before";
    const kind = press.row.dataset.sidebarDragKind;
    const source = press.row.dataset.sidebarDragId;
    const targetId = row.dataset.sidebarDragId;
    if ((kind === "session" || kind === "workspace") && source && targetId) {
      const drop: SidebarDrop = { kind, source, target: targetId, after };
      const moveKey = `${drop.kind}:${drop.source}:${drop.target}:${drop.after}`;
      if (moveKey !== lastMoveKey) {
        lastMoveKey = moveKey;
        onMove?.(drop);
      }
    }
  };
  const renderFrame = (time: number) => {
    frame = undefined;
    if (!press?.active) return;
    if (!press.row.isConnected || !root.contains(press.row)) { finish(); return; }
    if (ghost) ghost.style.transform = `translate3d(${press.x - press.startX}px, ${press.y - press.startY}px, 0)`;
    const dt = Math.min(previousTime === undefined ? 1 / 60 : (time - previousTime) / 1000, 0.05);
    previousTime = time;
    let scrolling = false;
    if (press.scroller) {
      const scroller = press.scroller;
      const rect = scroller.getBoundingClientRect();
      const edge = Math.min(SCROLL_EDGE_PX, rect.height / 3);
      if (edge > 0 && press.x >= rect.left && press.x <= rect.right && press.y >= rect.top && press.y <= rect.bottom) {
        const speed = press.y < rect.top + edge ? -(rect.top + edge - press.y) / edge
          : press.y > rect.bottom - edge ? (press.y - rect.bottom + edge) / edge : 0;
        const before = scroller.scrollTop;
        scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, before + speed * SCROLL_SPEED_PX * dt));
        scrolling = before !== scroller.scrollTop;
      }
    }
    updateTarget();
    if (scrolling) frame = view.requestAnimationFrame(renderFrame);
  };
  const scheduleFrame = () => { if (frame === undefined) frame = view.requestAnimationFrame(renderFrame); };
  const activate = () => {
    if (!press || !press.row.isConnected || !root.contains(press.row)) { finish(); return; }
    press.active = true;
    suppressClick = true;
    press.scroller = findScroller(press.row);
    const rect = press.row.getBoundingClientRect();
    ghost = doc.createElement("div");
    ghost.className = "q-sidebar q-sidebar-drag-preview";
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
    const clone = press.row.cloneNode(true) as HTMLElement;
    clone.removeAttribute("data-sidebar-drag-id");
    clone.removeAttribute("id");
    clone.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    ghost.append(clone);
    doc.body.append(ghost);
    press.row.dataset.sidebarDragging = "true";
    root.dataset.sidebarDragging = "true";
    scheduleFrame();
  };
  const move = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.pointerId) return;
    press.x = event.clientX;
    press.y = event.clientY;
    if (!press.active) {
      if (Math.hypot(press.x - press.startX, press.y - press.startY) > PRESS_SLOP_PX) activate();
      return;
    }
    event.preventDefault();
    scheduleFrame();
  };
  const finish = (event?: PointerEvent) => {
    if (event && event.pointerId !== press?.pointerId) return;
    let drop: SidebarDrop | undefined;
    if (event?.type === "pointerup" && press?.active) {
      press.x = event.clientX;
      press.y = event.clientY;
      updateTarget();
      const kind = press.row.dataset.sidebarDragKind;
      if (target?.isConnected && press.row.isConnected && (kind === "session" || kind === "workspace")) {
        drop = { kind, source: press.row.dataset.sidebarDragId!, target: target.dataset.sidebarDragId!, after };
      }
    }
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    press?.row.removeAttribute("data-sidebar-dragging");
    root.removeAttribute("data-sidebar-dragging");
    ghost?.remove();
    clearTarget();
    press = undefined;
    ghost = undefined;
    frame = previousTime = undefined;
    lastMoveKey = undefined;
    doc.removeEventListener("pointermove", move, true);
    doc.removeEventListener("pointerup", finish, true);
    doc.removeEventListener("pointercancel", finish, true);
    if (drop) onDrop(drop);
  };
  const down = (event: PointerEvent) => {
    if (press) { finish(); return; }
    suppressClick = false;
    if (event.button !== 0 || !event.isPrimary) return;
    const element = event.target as HTMLElement | null;
    const handle = element?.closest<HTMLElement>(HANDLE);
    const row = handle?.closest<HTMLElement>(ROW);
    if (!row || !root.contains(row)) return;
    press = { row, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
    doc.addEventListener("pointermove", move, { capture: true, passive: false });
    doc.addEventListener("pointerup", finish, true);
    doc.addEventListener("pointercancel", finish, true);
  };
  const click = (event: MouseEvent) => {
    if (!suppressClick || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape" && press) { event.preventDefault(); finish(); } };
  const cancel = () => finish();
  const visibility = () => { if (doc.hidden) finish(); };
  const nativeDrag = (event: DragEvent) => { if ((event.target as HTMLElement | null)?.closest(HANDLE)) event.preventDefault(); };
  root.addEventListener("pointerdown", down);
  root.addEventListener("click", click, true);
  root.addEventListener("dragstart", nativeDrag);
  doc.addEventListener("keydown", key, true);
  doc.addEventListener("visibilitychange", visibility);
  view.addEventListener("blur", cancel);
  return () => {
    finish();
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("click", click, true);
    root.removeEventListener("dragstart", nativeDrag);
    doc.removeEventListener("keydown", key, true);
    doc.removeEventListener("visibilitychange", visibility);
    view.removeEventListener("blur", cancel);
  };
}
