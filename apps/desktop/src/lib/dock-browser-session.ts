type BrowserInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface BrowserBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Webview creation and destruction must stay serialized because Tauri mutates
// the parent window's child list. Each session still owns its own native child.
let nativeQueue: Promise<unknown> = Promise.resolve();

function enqueue(operation: () => Promise<unknown>) {
  const result = nativeQueue.then(operation);
  nativeQueue = result.catch(() => undefined);
  return result;
}

export function createDockBrowserSession(
  invoke: BrowserInvoke,
  browserId: string,
  url: string,
  onError: (error: unknown) => void,
  initialHtml?: string,
) {
  let disposed = false;
  let opened = false;
  let closed = false;
  let failed = false;
  let scheduled = false;
  let desired: { bounds: BrowserBounds; visible: boolean } | undefined;
  let appliedBounds = "";
  let visible = false;

  const report = (error: unknown) => {
    if (!disposed && typeof onError === "function") {
      try {
        onError(error);
      } catch {
        // Prevent client-supplied error listeners from creating unhandled exceptions
      }
    }
  };

  const closeChild = async () => {
    if (closed) return;
    closed = true;
    await invoke("browser_close", { browserId }).catch(() => undefined);
  };

  const sync = async () => {
    scheduled = false;
    if (disposed || failed) return;
    try {
      while (!disposed && !failed && desired) {
        // 1. Inactive or unopened tab: do not create native children until visible
        if (!opened) {
          if (!desired.visible) {
            break;
          }
          await invoke("browser_open", { browserId, url, ...desired.bounds });
          opened = true;
          if (initialHtml !== undefined) {
            await invoke("browser_preview", { browserId, html: initialHtml });
          }
          if (disposed) {
            await closeChild();
            return;
          }
          continue;
        }

        // 2. Opened but desired is hidden
        if (!desired.visible) {
          if (visible) {
            await invoke("browser_visible", { browserId, visible: false });
            visible = false;
            appliedBounds = ""; // Hiding parks the native child offscreen.
          }
          if (disposed) {
            await closeChild();
            return;
          }
          if (!desired.visible) {
            break;
          }
          continue;
        }

        // 3. Opened and desired is visible
        const targetBounds = desired.bounds;
        const key = JSON.stringify(targetBounds);
        if (key !== appliedBounds) {
          await invoke("browser_bounds", { browserId, ...targetBounds });
          appliedBounds = key;
          if (disposed) {
            await closeChild();
            return;
          }
          // If visibility flipped while awaiting bounds, flush immediately
          if (!desired.visible) {
            continue;
          }
        }

        if (!visible) {
          await invoke("browser_visible", { browserId, visible: true });
          visible = true;
          if (disposed) {
            await closeChild();
            return;
          }
          // If visibility flipped while awaiting visible, flush immediately
          if (!desired.visible) {
            continue;
          }
        }

        // Converged with latest desired state
        if (
          desired.visible === visible &&
          (!desired.visible || JSON.stringify(desired.bounds) === appliedBounds)
        ) {
          break;
        }
      }
    } catch (error) {
      failed = true;
      report(error);
      // Even a partially initialized child must stop intercepting input.
      await closeChild();
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
      // Inactive unopened tab: don't create native child yet
      if (!opened && !next.visible) return;
      if (!scheduled) {
        scheduled = true;
        void enqueue(sync).catch(report);
      }
    },
    command(command: "browser_navigate" | "browser_eval" | "browser_preview", args: Record<string, unknown>) {
      return enqueue(async () => {
        if (!disposed && opened && !failed) await invoke(command, { browserId, ...args });
      }).catch(report);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void enqueue(closeChild).catch(() => undefined);
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
