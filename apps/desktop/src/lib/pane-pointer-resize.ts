type CaptureTarget = EventTarget & {
  setPointerCapture?(id: number): void;
  hasPointerCapture?(id: number): boolean;
  releasePointerCapture?(id: number): void;
};

export interface PanePointerResizeOptions {
  events: EventTarget;
  target: CaptureTarget;
  pointerId: number;
  startX: number;
  startSize: number;
  direction: 1 | -1;
  scale: number;
  onSize: (rawSize: number) => void;
  onEnd: (rawSize: number) => void;
  onFinish: () => void;
}

// Window tracking survives the pane closing or its handle unmounting.
export function trackPanePointerResize(options: PanePointerResizeOptions) {
  const { events, target, pointerId, startX, startSize, direction } = options;
  const scale = options.scale > 0 ? options.scale : 1;
  let lastSize = startSize;
  let moved = false;
  let finished = false;
  const apply = (event: PointerEvent) => {
    event.preventDefault();
    moved ||= event.clientX !== startX;
    lastSize = startSize + direction * (event.clientX - startX) / scale;
    options.onSize(lastSize);
  };
  const finish = (commit: boolean) => {
    if (finished) return;
    finished = true;
    events.removeEventListener("pointermove", move);
    events.removeEventListener("pointerup", up);
    events.removeEventListener("pointercancel", cancel);
    events.removeEventListener("lostpointercapture", lost);
    try { if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture?.(pointerId); }
    finally {
      try { if (commit && moved) options.onEnd(lastSize); }
      finally { options.onFinish(); }
    }
  };
  const move = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerId === pointerId) apply(pointer);
  };
  const up = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerId !== pointerId) return;
    if (moved) apply(pointer);
    finish(true);
  };
  // Cancellation commits the last movement, not synthetic cancel coordinates.
  const cancel = (event: Event) => { if ((event as PointerEvent).pointerId === pointerId) finish(true); };
  const lost = (event: Event) => { if (event.target === target) cancel(event); };
  events.addEventListener("pointermove", move);
  events.addEventListener("pointerup", up);
  events.addEventListener("pointercancel", cancel);
  events.addEventListener("lostpointercapture", lost);
  try { target.setPointerCapture?.(pointerId); }
  catch { /* Window listeners still work when the native surface cannot capture. */ }
  return () => finish(false);
}
