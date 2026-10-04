import {
  nextThreadFollowMode, THREAD_BOTTOM_SCROLL_DURATION_MS, THREAD_BOTTOM_TOLERANCE_PX,
  type ThreadFollowSnapshot, type ThreadPhase,
} from "./thread-scroll-policy";
import { captureThreadReadingAnchor, type ThreadReadingAnchor } from "./thread-scroll-position";

export interface ThreadScrollTurn { turnId?: string; running: boolean; phase: ThreadPhase }
interface ControllerOptions {
  viewport: HTMLElement;
  content: HTMLElement;
  footer: HTMLElement;
  endContent: HTMLElement | null;
  turn: ThreadScrollTurn;
  restored?: ThreadFollowSnapshot;
  hasRestoration: boolean;
  onVisibility: (visible: boolean) => void;
  onSave: (snapshot: ThreadFollowSnapshot) => void;
  onPosition?: (anchor: ThreadReadingAnchor | undefined) => void;
}

/** Measure the transcript tail, never the temporary assistant-ui anchor reserve. */
export function measureThreadBottom({ content, footer, endContent }: Pick<ControllerOptions, "content" | "footer" | "endContent">) {
  const reserve = content.querySelector<HTMLElement>("[data-aui-top-anchor-reserve]");
  const reserveHeight = reserve?.getBoundingClientRect().height ?? 0;
  let bottom = content.getBoundingClientRect().bottom - reserveHeight;
  if (endContent && endContent.getBoundingClientRect().height > 0) bottom = Math.max(bottom, endContent.getBoundingClientRect().bottom - reserveHeight);
  return { distance: bottom - footer.getBoundingClientRect().top, reserveHeight };
}

// A wheel/key gesture inside a code block belongs to that block while it can scroll.
function nestedScrollConsumes(target: EventTarget | null, viewport: HTMLElement, away: boolean) {
  if (!(target instanceof Element)) return false;
  for (let node: Element | null = target; node && node !== viewport; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight) continue;
    if (!/auto|scroll/.test(getComputedStyle(node).overflowY)) continue;
    if (away ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight) return true;
  }
  return false;
}

/** One owner for tail visibility, user intent and content growth. */
export function mountThreadScrollController(options: ControllerOptions) {
  const { viewport, content, footer, endContent } = options;
  let turn = options.turn;
  const restored = options.restored;
  let mode: ThreadFollowSnapshot["mode"] = "static";
  if (restored && restored.turnId === turn.turnId) mode = restored.mode;
  else if (!restored) mode = nextThreadFollowMode(mode, { type: "phase", previous: "idle", phase: turn.phase });
  let frame: number | null = null;
  let animation: number | null = null;
  let programmatic = false;
  let held = false;
  let disposed = false;
  let previousTop = viewport.scrollTop;
  let touchY: number | undefined;
  let pointerActive = false;
  let pointerStartTop = viewport.scrollTop;

  const geometry = () => measureThreadBottom(options);
  const isFollowing = () => mode === "prework_follow" || mode === "user_follow";
  const publish = () => options.onVisibility(geometry().distance > THREAD_BOTTOM_TOLERANCE_PX);
  const cancelAnimation = () => {
    if (animation !== null) cancelAnimationFrame(animation);
    animation = null;
  };
  const writeTop = (top: number) => {
    programmatic = true;
    viewport.scrollTo({ top: Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight)), behavior: "instant" });
    previousTop = viewport.scrollTop;
    programmatic = false;
  };
  const bottomTop = () => viewport.scrollTop + geometry().distance;
  const hold = () => {
    held = true;
    mode = nextThreadFollowMode(mode, { type: "hold" });
    cancelAnimation();
  };
  const followBottom = () => {
    held = false;
    mode = nextThreadFollowMode(mode, { type: "bottom", phase: turn.phase });
    cancelAnimation();
    writeTop(bottomTop());
    publish();
  };
  const scrollToBottom = () => {
    held = false;
    mode = nextThreadFollowMode(mode, { type: "bottom", phase: turn.phase });
    cancelAnimation();
    if (turn.running || geometry().reserveHeight > THREAD_BOTTOM_TOLERANCE_PX
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      writeTop(bottomTop());
      publish();
      return;
    }
    const startTop = viewport.scrollTop;
    const startTime = performance.now();
    const animate = (time: number) => {
      animation = null;
      if (disposed) return;
      const progress = Math.min(1, (time - startTime) / THREAD_BOTTOM_SCROLL_DURATION_MS);
      const eased = 1 - (1 - progress) ** 3;
      writeTop(startTop + (bottomTop() - startTop) * eased);
      publish();
      if (progress < 1) animation = requestAnimationFrame(animate);
    };
    animation = requestAnimationFrame(animate);
  };

  const refresh = () => {
    frame = null;
    if (disposed) return;
    observeReserve();
    const { distance } = geometry();
    if (!held) {
      mode = nextThreadFollowMode(mode, { type: "content", phase: turn.phase, overflow: distance });
    }
    if (isFollowing() && animation === null) writeTop(bottomTop());
    publish();
    previousTop = viewport.scrollTop;
  };
  const schedule = () => { if (!disposed && frame === null) frame = requestAnimationFrame(refresh); };
  const scroll = () => {
    if (programmatic) return;
    const { distance, reserveHeight } = geometry();
    // Only a real change in scroll position releases intent; content growth does not.
    // Pointer dragging the scrollbar can happen while content height is being
    // measured, so it must not depend on scrollHeight staying unchanged.
    if (animation === null && touchY !== undefined && reserveHeight > THREAD_BOTTOM_TOLERANCE_PX
      && viewport.scrollTop !== previousTop) hold();
    else if (animation === null && pointerActive && viewport.scrollTop !== pointerStartTop
      && (distance > THREAD_BOTTOM_TOLERANCE_PX || reserveHeight > THREAD_BOTTOM_TOLERANCE_PX)) hold();
    else if (animation === null && viewport.scrollTop < previousTop) hold();
    // A top-anchor placement also scrolls downward, but its blank response
    // reserve is not a user request to resume tail following.
    else if (animation === null && viewport.scrollTop > previousTop && distance <= THREAD_BOTTOM_TOLERANCE_PX
      && (reserveHeight === 0 || pointerActive || touchY !== undefined)) {
      held = false;
      mode = nextThreadFollowMode(mode, { type: "bottom", phase: turn.phase });
    }
    previousTop = viewport.scrollTop;
    publish();
    options.onPosition?.(captureThreadReadingAnchor(viewport, content));
  };
  const gesture = (away: boolean, target: EventTarget | null) => {
    if (nestedScrollConsumes(target, viewport, away)) return;
    if (away) hold();
    else {
      const { distance, reserveHeight } = geometry();
      // Scrolling into the top-anchor reserve is still explicit user intent.
      // Keep that position stable instead of letting the following refresh
      // snap back to the real transcript tail.
      if (reserveHeight > THREAD_BOTTOM_TOLERANCE_PX) hold();
      else if (distance <= THREAD_BOTTOM_TOLERANCE_PX) followBottom();
    }
  };
  const wheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    gesture(event.deltaY < 0, event.target);
  };
  const key = (event: KeyboardEvent) => {
    const target = event.target;
    if (event.defaultPrevented || event.repeat || !(target instanceof Element)
      || target.closest("input, textarea, select, [contenteditable='true']")) return;
    if ((event.key === " " || event.key === "Spacebar") && target.closest("button, [role='button']")) return;
    if (["ArrowUp", "Home", "PageUp"].includes(event.key)) gesture(true, target);
    else if (["ArrowDown", "End", "PageDown"].includes(event.key)) gesture(false, target);
    else if (event.key === " " || event.key === "Spacebar") gesture(event.shiftKey, target);
  };
  const pointerDown = () => {
    pointerActive = true;
    pointerStartTop = viewport.scrollTop;
    // Cancel smooth navigation on any pointer gesture. A disclosure click is
    // not a scroll gesture: keep bottom following active so its height
    // animation remains visible above the sticky footer.
    cancelAnimation();
  };
  const pointerUp = () => { pointerActive = false; };
  const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
  const touchMove = (event: TouchEvent) => {
    const next = event.touches[0]?.clientY;
    if (next !== undefined && touchY !== undefined && next !== touchY) gesture(next > touchY, event.target);
    touchY = next;
  };
  const touchEnd = () => { touchY = undefined; };
  viewport.addEventListener("scroll", scroll, { passive: true });
  viewport.addEventListener("wheel", wheel, { passive: true });
  viewport.addEventListener("keydown", key);
  viewport.addEventListener("pointerdown", pointerDown, { passive: true });
  viewport.addEventListener("pointerup", pointerUp, { passive: true });
  viewport.addEventListener("pointercancel", pointerUp, { passive: true });
  viewport.addEventListener("touchstart", touchStart, { passive: true });
  viewport.addEventListener("touchmove", touchMove, { passive: true });
  viewport.addEventListener("touchend", touchEnd, { passive: true });
  viewport.addEventListener("touchcancel", touchEnd, { passive: true });
  const resize = new ResizeObserver(schedule);
  [viewport, content, footer, endContent].forEach((element) => { if (element) resize.observe(element); });
  // Reserve shrinkage can exactly cancel message growth in the outer box.
  // Observe the reserve itself as well; rediscover it when the primitive moves
  // or replaces it, without observing every historical message.
  let observedReserve: HTMLElement | null = null;
  const observeReserve = () => {
    const reserve = content.querySelector<HTMLElement>("[data-aui-top-anchor-reserve]");
    if (reserve === observedReserve) return;
    if (observedReserve) resize.unobserve(observedReserve);
    observedReserve = reserve;
    if (reserve) resize.observe(reserve);
  };
  observeReserve();
  const mutation = new MutationObserver(schedule);
  mutation.observe(content, { childList: true, subtree: true, characterData: true });

  // The primitive restores native anchor state. Never overwrite it with a second restore.
  if (!options.hasRestoration && !turn.running) followBottom();
  else publish();

  return {
    scrollToBottom,
    sync(next: ThreadScrollTurn) {
      if (next.turnId !== turn.turnId) {
        cancelAnimation();
        // Placement is not a user hold. Watch the new reply for overflow once
        // prework starts, without consuming its initial response reserve.
        held = false;
        mode = nextThreadFollowMode(mode, { type: "placed" });
        turn = { ...next, phase: "idle" };
      }
      if (!held) {
        mode = nextThreadFollowMode(mode, { type: "phase", previous: turn.phase, phase: next.phase });
      }
      turn = next;
      schedule();
    },
    reveal(message: HTMLElement) {
      const rect = message.getBoundingClientRect();
      const padding = viewport.ownerDocument?.defaultView?.getComputedStyle(viewport).scrollPaddingTop;
      const topInset = (Number.parseFloat(padding ?? "") || 0) * (padding?.endsWith("%") ? viewport.clientHeight / 100 : 1);
      const vpTop = viewport.getBoundingClientRect().top;
      const target = viewport.scrollTop + rect.top - (vpTop + topInset);
      cancelAnimation();
      held = false;
      mode = nextThreadFollowMode("static", { type: "phase", previous: "idle", phase: turn.phase });
      writeTop(target);
      publish();
    },
    dispose() {
      options.onPosition?.(captureThreadReadingAnchor(viewport, content));
      options.onSave({ turnId: turn.turnId, mode });
      disposed = true;
      cancelAnimation();
      if (frame !== null) cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      viewport.removeEventListener("scroll", scroll);
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("keydown", key);
      viewport.removeEventListener("pointerdown", pointerDown);
      viewport.removeEventListener("pointerup", pointerUp);
      viewport.removeEventListener("pointercancel", pointerUp);
      viewport.removeEventListener("touchstart", touchStart);
      viewport.removeEventListener("touchmove", touchMove);
      viewport.removeEventListener("touchend", touchEnd);
      viewport.removeEventListener("touchcancel", touchEnd);
    },
  };
}
