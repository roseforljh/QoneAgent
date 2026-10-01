import {
  nextThreadFollowMode, THREAD_BOTTOM_SCROLL_DURATION_MS, THREAD_BOTTOM_TOLERANCE_PX,
  userMessageRevealScrollTop, type ThreadFollowSnapshot, type ThreadPhase,
} from "./thread-scroll-policy";

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
  let previousHeight = viewport.scrollHeight;
  let touchY: number | undefined;

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
    previousHeight = viewport.scrollHeight;
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
    const { distance, reserveHeight } = geometry();
    if (!held) {
      mode = nextThreadFollowMode(mode, { type: "content", phase: turn.phase, overflow: distance });
    }
    if (isFollowing() && animation === null) writeTop(bottomTop());
    publish();
    previousTop = viewport.scrollTop;
    previousHeight = viewport.scrollHeight;
  };
  const schedule = () => { if (!disposed && frame === null) frame = requestAnimationFrame(refresh); };
  const scroll = () => {
    if (programmatic) return;
    const distance = geometry().distance;
    // Only a real change in scroll position releases intent; content growth does not.
    if (animation === null && viewport.scrollHeight === previousHeight && viewport.scrollTop < previousTop) hold();
    else if (animation === null && viewport.scrollTop > previousTop && distance <= THREAD_BOTTOM_TOLERANCE_PX) {
      held = false;
      mode = nextThreadFollowMode(mode, { type: "bottom", phase: turn.phase });
    }
    previousTop = viewport.scrollTop;
    previousHeight = viewport.scrollHeight;
    publish();
  };
  const gesture = (away: boolean, target: EventTarget | null) => {
    if (nestedScrollConsumes(target, viewport, away)) return;
    if (away) hold();
    else if (geometry().distance <= THREAD_BOTTOM_TOLERANCE_PX) followBottom();
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
  const pointer = (event: PointerEvent) => {
    // Cancel smooth navigation on any pointer gesture, but preserve normal button actions.
    if (animation !== null) hold();
    if (event.target instanceof Element && event.target.closest('[data-slot="collapsible"], [data-slot="assistant-execution"], [data-slot="tool-timeline"], [data-slot="tool-call"], [data-slot="reasoning"], [data-slot="sources"]')) hold();
  };
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
  viewport.addEventListener("pointerdown", pointer, { passive: true });
  viewport.addEventListener("touchstart", touchStart, { passive: true });
  viewport.addEventListener("touchmove", touchMove, { passive: true });
  viewport.addEventListener("touchend", touchEnd, { passive: true });
  viewport.addEventListener("touchcancel", touchEnd, { passive: true });
  const resize = new ResizeObserver(schedule);
  [viewport, content, footer, endContent].forEach((element) => { if (element) resize.observe(element); });
  const mutation = new MutationObserver(schedule);
  mutation.observe(content, { childList: true, subtree: true });

  // The primitive restores native anchor state. Never overwrite it with a second restore.
  if (!options.hasRestoration && !turn.running) followBottom();
  else publish();

  return {
    scrollToBottom,
    sync(next: ThreadScrollTurn) {
      if (next.turnId !== turn.turnId) {
        cancelAnimation();
        held = false;
        mode = nextThreadFollowMode(mode, { type: "placed" });
        turn = { ...next, phase: "idle" };
      }
      mode = nextThreadFollowMode(mode, { type: "phase", previous: turn.phase, phase: next.phase });
      turn = next;
      schedule();
    },
    reveal(message: HTMLElement) {
      const rect = message.getBoundingClientRect();
      const target = userMessageRevealScrollTop(viewport.scrollTop, rect.top, rect.bottom, viewport.getBoundingClientRect().top, footer.getBoundingClientRect().top);
      if (target !== null) { cancelAnimation(); writeTop(target); schedule(); }
    },
    dispose() {
      options.onSave({ turnId: turn.turnId, mode });
      disposed = true;
      cancelAnimation();
      if (frame !== null) cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      viewport.removeEventListener("scroll", scroll);
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("keydown", key);
      viewport.removeEventListener("pointerdown", pointer);
      viewport.removeEventListener("touchstart", touchStart);
      viewport.removeEventListener("touchmove", touchMove);
      viewport.removeEventListener("touchend", touchEnd);
      viewport.removeEventListener("touchcancel", touchEnd);
    },
  };
}
