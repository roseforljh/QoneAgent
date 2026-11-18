import {
  nextThreadFollowMode, THREAD_BOTTOM_SCROLL_DURATION_MS, THREAD_BOTTOM_TOLERANCE_PX,
  THREAD_RESERVE_RELEASE_DURATION_MS, type ThreadFollowSnapshot, type ThreadPhase,
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
  let contentBottom = content.getBoundingClientRect().bottom;
  const endHeight = endContent ? endContent.getBoundingClientRect().height : 0;
  if (endContent && endHeight > 0) contentBottom = Math.max(contentBottom, endContent.getBoundingClientRect().bottom);
  const release = endHeight > 0 ? content.parentElement?.querySelector<HTMLElement>(":scope > [data-q-reserve-release]") : null;
  const releaseHeight = release?.getBoundingClientRect().height ?? 0;
  const footerTop = footer.getBoundingClientRect().top;
  return {
    // The reserve is excluded while deciding when streamed content overflows.
    distance: contentBottom - reserveHeight - releaseHeight - footerTop,
    // The reserve remains part of the native tail used by explicit bottom navigation.
    nativeDistance: contentBottom - footerTop,
    reserveHeight,
  };
}

function readReserveHeight(reserve: HTMLElement | null): number {
  if (!reserve) return 0;
  const rectHeight = reserve.getBoundingClientRect().height;
  if (rectHeight > 0) return rectHeight;
  return Number.parseFloat(reserve.style?.height ?? "0") || 0;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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
  let releaseAnimation: number | null = null;
  let releaseSpacer: HTMLElement | null = null;
  let lastReserveHeight = 0;
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
  const cancelRelease = () => {
    if (releaseAnimation !== null) cancelAnimationFrame(releaseAnimation);
    releaseAnimation = null;
    releaseSpacer?.remove();
    releaseSpacer = null;
  };
  const writeTop = (top: number) => {
    programmatic = true;
    viewport.scrollTo({ top: Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight)), behavior: "instant" });
    previousTop = viewport.scrollTop;
    programmatic = false;
  };
  // The top-anchor reserve is part of the native scrollable tail. Excluding it
  // here leaves restored/following turns one reserve height above P1.
  const bottomTop = () => viewport.scrollTop + geometry().nativeDistance;
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
    cancelRelease();
    if (turn.running || geometry().reserveHeight > THREAD_BOTTOM_TOLERANCE_PX
      || prefersReducedMotion()) {
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
    if (isFollowing() && animation === null && releaseAnimation === null) writeTop(bottomTop());
    publish();
    previousTop = viewport.scrollTop;
  };
  const schedule = () => { if (!disposed && frame === null) frame = requestAnimationFrame(refresh); };
  const scroll = () => {
    if (programmatic) return;
    const { distance, reserveHeight } = geometry();
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    // 收起动画或释放动画导致容器缩短并把 scrollTop 夹到新底部时，不属于用户主动上滚。
    const clampedAtBottom = !pointerActive && touchY === undefined
      && Math.abs(viewport.scrollTop - maxScrollTop) <= 1
      && distance <= THREAD_BOTTOM_TOLERANCE_PX;
    // Only a real change in scroll position releases intent; content growth does not.
    // Pointer dragging the scrollbar can happen while content height is being
    // measured, so it must not depend on scrollHeight staying unchanged.
    if (animation === null && touchY !== undefined && reserveHeight > THREAD_BOTTOM_TOLERANCE_PX
      && viewport.scrollTop !== previousTop) hold();
    else if (animation === null && pointerActive && viewport.scrollTop !== pointerStartTop
      && (distance > THREAD_BOTTOM_TOLERANCE_PX || reserveHeight > THREAD_BOTTOM_TOLERANCE_PX)) hold();
    else if (animation === null && releaseAnimation === null && !clampedAtBottom && viewport.scrollTop < previousTop) hold();
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
  const resize = new ResizeObserver(() => {
    if (observedReserve?.isConnected) lastReserveHeight = readReserveHeight(observedReserve);
    schedule();
  });
  [viewport, content, footer, endContent].forEach((element) => { if (element) resize.observe(element); });
  // Reserve shrinkage can exactly cancel message growth in the outer box.
  // Observe the reserve itself as well; rediscover it when the primitive moves
  // or replaces it, without observing every historical message.
  let observedReserve: HTMLElement | null = null;
  const observeReserve = () => {
    const reserve = content.querySelector<HTMLElement>("[data-aui-top-anchor-reserve]");
    if (reserve) lastReserveHeight = readReserveHeight(reserve);
    if (reserve === observedReserve) return;
    if (observedReserve) resize.unobserve(observedReserve);
    observedReserve = reserve;
    if (reserve) resize.observe(reserve);
  };
  observeReserve();
  const startReserveRelease = (dropPx: number) => {
    if (!content.parentElement || typeof content.after !== "function" || prefersReducedMotion()) return;
    const doc = content.ownerDocument ?? document;
    cancelAnimation();
    cancelRelease();
    const spacer = doc.createElement("div");
    spacer.dataset.qReserveRelease = "";
    spacer.style.height = `${dropPx}px`;
    spacer.style.flexShrink = "0";
    spacer.style.pointerEvents = "none";
    spacer.setAttribute("aria-hidden", "true");
    content.after(spacer);
    // 若容器在无留白时靠 footer 的 mt-auto 贴底，需补齐这部分差值，让缓动恰好在触底时归零。
    const actualMax = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const deficit = Math.max(0, previousTop - actualMax);
    const startHeight = dropPx + deficit;
    const endHeight = deficit;
    if (deficit > 0) spacer.style.height = `${startHeight}px`;
    releaseSpacer = spacer;
    writeTop(previousTop);
    const startTime = performance.now();
    const step = (time: number) => {
      releaseAnimation = null;
      if (disposed || releaseSpacer !== spacer) return;
      const progress = Math.max(0, Math.min(1, (time - startTime) / THREAD_RESERVE_RELEASE_DURATION_MS));
      const eased = 1 - (1 - progress) ** 3;
      const nextHeight = progress >= 1 ? endHeight : Math.max(endHeight, startHeight - (startHeight - endHeight) * eased);
      const previousMax = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const shouldFollowClamp = viewport.scrollTop >= previousMax - 2;
      spacer.style.height = `${nextHeight}px`;
      const nextMax = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (shouldFollowClamp || viewport.scrollTop > nextMax) writeTop(nextMax);
      else previousTop = viewport.scrollTop;
      if (progress < 1) {
        releaseAnimation = requestAnimationFrame(step);
      } else {
        spacer.remove();
        if (releaseSpacer === spacer) releaseSpacer = null;
        previousTop = viewport.scrollTop;
        publish();
      }
    };
    releaseAnimation = requestAnimationFrame(step);
  };
  const mutation = new MutationObserver(() => {
    observeReserve();
    schedule();
  });
  mutation.observe(content, { childList: true, subtree: true, characterData: true });

  // The primitive restores native anchor state. Never overwrite it with a second restore.
  if (!options.hasRestoration && !turn.running) followBottom();
  else publish();

  return {
    scrollToBottom,
    sync(next: ThreadScrollTurn) {
      const wasRunning = turn.running;
      const sameTurn = next.turnId === turn.turnId;
      const previousReserve = observedReserve;
      if (!sameTurn || next.running) cancelRelease();
      if (!sameTurn) {
        lastReserveHeight = 0;
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
      observeReserve();
      if (sameTurn && wasRunning && !next.running && !observedReserve) {
        const hadReserve = Math.max(lastReserveHeight, readReserveHeight(previousReserve)) > 1;
        lastReserveHeight = 0;
        if (hadReserve) {
          const naturalMaxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
          const dropPx = previousTop - naturalMaxTop;
          if (dropPx > 1) startReserveRelease(dropPx);
        }
      }
      schedule();
    },
    reveal(message: HTMLElement) {
      const rect = message.getBoundingClientRect();
      const padding = viewport.ownerDocument?.defaultView?.getComputedStyle(viewport).scrollPaddingTop;
      const topInset = (Number.parseFloat(padding ?? "") || 0) * (padding?.endsWith("%") ? viewport.clientHeight / 100 : 1);
      const vpTop = viewport.getBoundingClientRect().top;
      const target = viewport.scrollTop + rect.top - (vpTop + topInset);
      cancelAnimation();
      cancelRelease();
      held = false;
      mode = nextThreadFollowMode("static", { type: "phase", previous: "idle", phase: turn.phase });
      writeTop(target);
      publish();
    },
    dispose() {
      // 卸载时不能再采样阅读位置：父级 Viewport 的 layout cleanup 先于本组件执行，
      // 已移除 top-anchor reserve，scrollTop 被浏览器夹到更小的最大值，
      // 此刻量到的是被夹过的错位位置。阅读位置以最后一次真实 scroll 事件为准。
      options.onSave({ turnId: turn.turnId, mode });
      disposed = true;
      cancelAnimation();
      cancelRelease();
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
