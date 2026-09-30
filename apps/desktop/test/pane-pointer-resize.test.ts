import { describe, expect, test } from "bun:test";
import { trackPanePointerResize } from "../src/lib/pane-pointer-resize";
import { sidebarResizeState } from "../src/lib/sidebar-layout";
import { dockResizeState } from "../src/lib/dock-layout";

function pointer(type: string, clientX: number, pointerId = 7, target?: EventTarget) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX }, pointerId: { value: pointerId },
    ...(target ? { target: { value: target } } : {}),
  });
  return event;
}

function drag(direction: 1 | -1 = 1, scale = 1) {
  const events = new EventTarget();
  const capture = { held: false, released: 0 };
  const target = Object.assign(new EventTarget(), {
    setPointerCapture: () => { capture.held = true; },
    hasPointerCapture: () => capture.held,
    releasePointerCapture: () => { capture.held = false; capture.released++; },
  });
  const sizes: number[] = [];
  const saved: number[] = [];
  let finished = 0;
  const cleanup = trackPanePointerResize({
    events, target, pointerId: 7, startX: 340, startSize: 340, direction, scale,
    onSize: (size) => sizes.push(size), onEnd: (size) => saved.push(size),
    onFinish: () => { finished++; },
  });
  return { events, target, sizes, saved, capture, cleanup, finished: () => finished };
}

describe("pane drag lifecycle", () => {
  test("left pane closes and reopens without ending the drag or persisting each move", () => {
    const d = drag();
    d.events.dispatchEvent(pointer("pointermove", 119));
    expect(sidebarResizeState(d.sizes.at(-1)!, 1200).open).toBe(false);
    expect(d.saved).toEqual([]);
    d.events.dispatchEvent(pointer("pointermove", 300));
    expect(sidebarResizeState(d.sizes.at(-1)!, 1200)).toEqual({ open: true, width: 300 });
    d.events.dispatchEvent(pointer("pointerup", 400));
    expect(d.saved).toEqual([400]);
    expect(d.capture.released).toBe(1);
    expect(d.finished()).toBe(1);
    d.events.dispatchEvent(pointer("pointermove", 500));
    expect(d.sizes.at(-1)).toBe(400);
  });
  test("right pane closes to the right, becomes full to the left, and reverses into split", () => {
    const d = drag(-1);
    d.events.dispatchEvent(pointer("pointermove", 521));
    expect(dockResizeState(d.sizes.at(-1)!, 1000, false).open).toBe(false);
    d.events.dispatchEvent(pointer("pointermove", -200));
    expect(dockResizeState(d.sizes.at(-1)!, 1000, false).fullWidth).toBe(true);
    d.events.dispatchEvent(pointer("pointermove", 180));
    expect(dockResizeState(d.sizes.at(-1)!, 1000, false)).toEqual({ open: true, fullWidth: false, width: 500 });
    d.events.dispatchEvent(pointer("pointerup", 180));
    expect(d.saved).toEqual([500]);
  });
  test("ignores other pointers and normalizes window zoom", () => {
    const d = drag(1, 1.5);
    d.events.dispatchEvent(pointer("pointermove", 40, 8));
    d.events.dispatchEvent(pointer("pointerup", 40, 8));
    expect(d.sizes).toEqual([]);
    expect(d.finished()).toBe(0);
    d.events.dispatchEvent(pointer("pointermove", 430));
    d.events.dispatchEvent(pointer("pointerup", 430));
    expect(d.saved).toEqual([400]);
  });
  test("cancel uses the last movement, lost capture ends only this handle", () => {
    const d = drag();
    d.events.dispatchEvent(pointer("pointermove", 410));
    d.events.dispatchEvent(pointer("lostpointercapture", 0, 7, new EventTarget()));
    expect(d.finished()).toBe(0);
    d.events.dispatchEvent(pointer("pointercancel", 0));
    expect(d.saved).toEqual([410]);
    const lost = drag();
    lost.events.dispatchEvent(pointer("pointermove", 430));
    lost.events.dispatchEvent(pointer("lostpointercapture", 0, 7, lost.target));
    expect(lost.saved).toEqual([430]);
    expect(lost.finished()).toBe(1);
  });
  test("unmount cleans up without writing a partial preference; click writes nothing", () => {
    const d = drag();
    d.events.dispatchEvent(pointer("pointermove", 450));
    d.cleanup(); d.cleanup();
    d.events.dispatchEvent(pointer("pointerup", 450));
    expect(d.saved).toEqual([]);
    expect(d.finished()).toBe(1);
    expect(d.capture.released).toBe(1);
    const click = drag();
    click.events.dispatchEvent(pointer("pointerup", 340));
    expect(click.saved).toEqual([]);
    expect(click.finished()).toBe(1);
  });
});

test("right thresholds are evaluated before width clamping", () => {
  expect(dockResizeState(160, 1000, false)).toEqual({ open: true, fullWidth: false, width: 320 });
  expect(dockResizeState(159.9, 1000, false).open).toBe(false);
  expect(dockResizeState(840, 1000, false).fullWidth).toBe(false);
  expect(dockResizeState(840.1, 1000, false).fullWidth).toBe(true);
});
