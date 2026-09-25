type BrowserInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface BrowserBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The native child is shared across React mounts. Serialize its entire lifetime,
// including StrictMode cleanup, so an old close can never destroy a new child.
let nativeQueue: Promise<unknown> = Promise.resolve();

function enqueue(operation: () => Promise<unknown>) {
  const result = nativeQueue.then(operation);
  nativeQueue = result.catch(() => undefined);
  return result;
}

export function createDockBrowserSession(
  invoke: BrowserInvoke,
  url: string,
  onError: (error: unknown) => void,
) {
  let disposed = false;
  let opened = false;
  let failed = false;
  let scheduled = false;
  let desired: { bounds: BrowserBounds; visible: boolean } | undefined;
  let appliedBounds = "";
  let visible = false;

  const report = (error: unknown) => {
    if (!disposed) onError(error);
  };

  const sync = async () => {
    scheduled = false;
    if (disposed || failed || !desired) return;
    try {
      if (!opened) {
        // browser_open creates a hidden child. Only this owner may reveal it.
        await invoke("browser_open", { url, ...desired.bounds });
        opened = true;
      }
      if (disposed) return;
      const next = desired;
      if (!next.visible) {
        if (visible) await invoke("browser_visible", { visible: false });
        visible = false;
        appliedBounds = ""; // Hiding parks the native child offscreen.
        return;
      }
      const key = JSON.stringify(next.bounds);
      if (key !== appliedBounds) {
        await invoke("browser_bounds", { ...next.bounds });
        appliedBounds = key;
      }
      if (!visible && !disposed && desired.visible) {
        await invoke("browser_visible", { visible: true });
        visible = true;
      }
    } catch (error) {
      failed = true;
      report(error);
      // Even a partially initialized child must stop intercepting input.
      await invoke("browser_close").catch(report);
    }
  };

  return {
    update(bounds: BrowserBounds | undefined, nextVisible: boolean) {
      if (disposed || failed) return;
      const nextBounds = bounds ?? desired?.bounds;
      if (!nextBounds) return;
      const next = { bounds: nextBounds, visible: nextVisible && !!bounds };
      if (JSON.stringify(desired) === JSON.stringify(next)) return;
      desired = next;
      if (!scheduled) {
        scheduled = true;
        void enqueue(sync).catch(report);
      }
    },
    command(command: "browser_navigate" | "browser_eval", args: Record<string, unknown>) {
      return enqueue(async () => {
        if (!disposed && opened && !failed) await invoke(command, args);
      }).catch(report);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void enqueue(() => invoke("browser_close")).catch(report);
    },
  };
}

// During the panel's width animation its fixed-width child extends outside the
// viewport. Native webviews do not inherit CSS overflow clipping.
export function clipBrowserBounds(
  rect: { left: number; top: number; right: number; bottom: number },
  viewportWidth: number,
  viewportHeight: number,
): BrowserBounds | undefined {
  const x = Math.max(0, rect.left);
  const y = Math.max(0, rect.top);
  const w = Math.min(viewportWidth, rect.right) - x;
  const h = Math.min(viewportHeight, rect.bottom) - y;
  return w >= 4 && h >= 4 ? { x, y, w, h } : undefined;
}
