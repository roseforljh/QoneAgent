import { afterAll, beforeAll, expect, test } from "bun:test";
import { motionValue, type Transition } from "motion/react";
import {
  animatePaneVisibility, paneWidthAtProgress, SIDEBAR_VISIBILITY_TRANSITION, DOCK_VISIBILITY_TRANSITION,
} from "../src/lib/pane-motion";
import { trackPanePointerResize } from "../src/lib/pane-pointer-resize";
import { sidebarResizeState } from "../src/lib/sidebar-layout";
import { dockResizeState } from "../src/lib/dock-layout";

// No browser: ownerless MotionValues use JS animation. Only DOM capability checks
// need constructors; the clock below drives the installed engine deterministically.
const descriptors = ["HTMLElement", "SVGElement"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
beforeAll(() => {
  for (const [name] of descriptors) Object.defineProperty(globalThis, name, { configurable: true, value: class {} });
});
afterAll(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function animationClock(transition: Transition) {
  let tick: (time: number) => void = () => {};
  const driver = (update: (time: number) => void) => {
    tick = update;
    return { start() {}, stop() {}, now: () => 100 };
  };
  return {
    transition: { ...transition, driver },
    seek(animation: NonNullable<ReturnType<typeof animatePaneVisibility>>, seconds: number) {
      animation.time = seconds;
      tick(100);
    },
  };
}

function pointer(type: string, clientX: number) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, { clientX: { value: clientX }, pointerId: { value: 1 } });
  return event;
}

for (const side of ["left", "right"] as const) {
  test(`${side}: continued pointer moves do not cancel the close/reopen spring`, () => {
    const clock = animationClock(side === "left" ? SIDEBAR_VISIBILITY_TRANSITION : DOCK_VISIBILITY_TRANSITION);
    const progress = motionValue(1);
    const size = motionValue(340);
    const events = new EventTarget();
    let open = true;
    let animation: ReturnType<typeof animatePaneVisibility>;
    let starts = 0;
    const direction = side === "left" ? 1 : -1;
    const moveTo = (rawWidth: number) => events.dispatchEvent(pointer("pointermove", direction * (rawWidth - 340)));
    const cleanup = trackPanePointerResize({
      events, target: new EventTarget(), pointerId: 1, startX: 0, startSize: 340, direction, scale: 1,
      onSize: (rawWidth) => {
        const next = side === "left" ? sidebarResizeState(rawWidth, 1200) : dockResizeState(rawWidth, 1200, false);
        if (next.open !== open) {
          open = next.open;
          animation = animatePaneVisibility(progress, open, clock.transition, false);
          starts++;
        }
        if (open) size.set(next.width);
      },
      onEnd() {}, onFinish() {},
    });
    try {
      moveTo(0);
      expect(starts).toBe(1);
      expect(progress.get()).toBe(1);
      clock.seek(animation!, 1);
      expect(progress.get()).toBe(0);

      moveTo(side === "left" ? 120 : 160);
      expect(starts).toBe(2);
      expect(paneWidthAtProgress(size.get(), progress.get())).toBe(0);
      clock.seek(animation!, 0.05);
      const partiallyOpen = progress.get();
      expect(partiallyOpen).toBeGreaterThan(0);
      expect(partiallyOpen).toBeLessThan(1);

      for (const rawWidth of [360, 390, 430]) moveTo(rawWidth);
      expect(starts).toBe(2);
      expect(progress.get()).toBe(partiallyOpen);
      expect(paneWidthAtProgress(size.get(), progress.get())).toBeLessThan(size.get());
      clock.seek(animation!, 0.1);
      expect(progress.get()).toBeGreaterThan(partiallyOpen);
      clock.seek(animation!, 1);
      expect(paneWidthAtProgress(size.get(), progress.get())).toBe(430);
    } finally { animation?.stop(); cleanup(); }
  });
}

test("reversing an unfinished close starts opening from the current progress", () => {
  const clock = animationClock(DOCK_VISIBILITY_TRANSITION);
  const progress = motionValue(1);
  const closing = animatePaneVisibility(progress, false, clock.transition, false)!;
  clock.seek(closing, 0.05);
  const partial = progress.get();
  expect(partial).toBeGreaterThan(0);
  expect(partial).toBeLessThan(1);
  const opening = animatePaneVisibility(progress, true, clock.transition, false)!;
  try {
    expect(progress.get()).toBe(partial);
    clock.seek(opening, 1);
    expect(progress.get()).toBe(1);
  } finally { opening.stop(); }
});

test("reduced motion stops the spring and directly applies visibility", () => {
  const clock = animationClock(SIDEBAR_VISIBILITY_TRANSITION);
  const progress = motionValue(0);
  const opening = animatePaneVisibility(progress, true, clock.transition, false)!;
  clock.seek(opening, 0.05);
  expect(animatePaneVisibility(progress, false, clock.transition, true)).toBeUndefined();
  expect(progress.get()).toBe(0);
  expect(progress.isAnimating()).toBe(false);
  animatePaneVisibility(progress, true, clock.transition, true);
  expect(progress.get()).toBe(1);
});

test("spring overshoot cannot make the pane wider than its frame or negative", () => {
  expect(paneWidthAtProgress(320, -0.1)).toBe(0);
  expect(paneWidthAtProgress(320, 1.1)).toBe(320);
  expect(paneWidthAtProgress(320, 0.5)).toBe(160);
});
