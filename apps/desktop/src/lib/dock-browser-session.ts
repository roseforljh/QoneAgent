import { attachNativeUnderlay, setNativeUnderlayHole } from "./native-underlay";

export { acquireNativeOverlayLock } from "./native-underlay";

type BrowserInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface BrowserBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 子视图创建与销毁需串行执行，避免并发修改父窗口子视图列表；每个会话各自拥有独立的原生子视图。
let nativeQueue: Promise<unknown> = Promise.resolve();

function enqueue(operation: () => Promise<unknown>) {
  const result = nativeQueue.then(operation);
  nativeQueue = result.catch(() => undefined);
  return result;
}

export interface DockBrowserSessionOptions {
  /** 原生视图已由外部桥接打开，挂载时直接接管而不再重复调用 browser_open。 */
  alreadyOpen?: boolean;
  /** 隐藏时移至离屏坐标而非 setVisible(false)，确保模型后台操作与截图正常。 */
  parkBounds?: BrowserBounds;
  /** 卸载时是否销毁原生视图；返回 false 时仅移回离屏，避免中断进行中的模型操作。 */
  shouldCloseOnDispose?: () => boolean;
  /** 视图被隐藏时收到隐藏前的页面截图，重新显示时收到 undefined。 */
  onSnapshot?: (dataUrl: string | undefined) => void;
}

export function createDockBrowserSession(
  invoke: BrowserInvoke,
  browserId: string,
  url: string,
  onError: (error: unknown) => void,
  initialHtml?: string,
  onOpen?: () => void,
  options?: DockBrowserSessionOptions,
) {
  let disposed = false;
  let opened = Boolean(options?.alreadyOpen);
  let closed = false;
  let failed = false;
  let scheduled = false;
  let desired: { bounds: BrowserBounds; visible: boolean } | undefined;
  let appliedBounds = "";
  let visible = false;
  let readyNotified = false;
  /** 本会话在弹窗挖洞登记表里的键。 */
  const hole = {};

  const report = (error: unknown) => {
    if (!disposed && typeof onError === "function") {
      try {
        onError(error);
      } catch {
        // Prevent client-supplied error listeners from creating unhandled exceptions
      }
    }
  };

  const hideChild = async () => {
    setNativeUnderlayHole(hole, undefined);
    const snapshot = options?.parkBounds
      ? await invoke("browser_bounds", { browserId, ...options.parkBounds })
      : await invoke("browser_visible", { browserId, visible: false });
    visible = false;
    appliedBounds = "";
    if (!disposed && typeof snapshot === "string") options?.onSnapshot?.(snapshot);
  };

  const closeChild = async () => {
    if (closed) return;
    setNativeUnderlayHole(hole, undefined);
    if (options?.shouldCloseOnDispose && !options.shouldCloseOnDispose()) {
      // 模型仍在操作该视图，仅将其移回离屏区域，等待释放或显式关闭时再销毁。
      if (opened) await hideChild();
      closed = true;
      return;
    }
    await invoke("browser_close", { browserId });
    closed = true;
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
            await hideChild();
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
          options?.onSnapshot?.(undefined);
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
          if (visible && !readyNotified) {
            readyNotified = true;
            onOpen?.();
          }
          if (visible) setNativeUnderlayHole(hole, desired.bounds);
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

  // 调用方最近一次请求的位置与可见性。弹窗不再影响可见性，由 native-underlay 把视图沉到主界面之下。
  let requested: { bounds?: BrowserBounds; visible: boolean } = { visible: false };
  const apply = () => {
    if (disposed || failed) return;
    const nextBounds = requested.bounds ?? desired?.bounds;
    if (!nextBounds) return;
    const next = { bounds: nextBounds, visible: requested.visible && !!requested.bounds };
    if (JSON.stringify(desired) === JSON.stringify(next)) return;
    desired = next;
    // Inactive unopened tab: don't create native child yet
    if (!opened && !next.visible) return;
    if (!scheduled) {
      scheduled = true;
      void enqueue(sync).catch(report);
    }
  };
  const detachUnderlay = attachNativeUnderlay(invoke);

  return {
    update(bounds: BrowserBounds | undefined, nextVisible: boolean) {
      requested = { bounds, visible: nextVisible };
      apply();
    },
    command(command: "browser_navigate" | "browser_eval" | "browser_preview", args: Record<string, unknown>) {
      return enqueue(async () => {
        if (!disposed && opened && !failed) await invoke(command, { browserId, ...args });
      }).catch(report);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detachUnderlay();
      setNativeUnderlayHole(hole, undefined);
      void enqueue(closeChild).catch((error) => console.error("Failed to close native browser", browserId, error));
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
