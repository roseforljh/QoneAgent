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

// 原生浏览器视图永远绘制在网页 DOM 之上，CSS z-index 对它无效。
// 任一模态框出现时统一隐藏所有原生视图：自绘 aria-modal 对话框，以及 Radix Dialog/AlertDialog
// （其内容不带 aria-modal，但带 data-state；Popover 同为 role=dialog，位于 popper 包裹层内，需排除）。
const MODAL_SELECTOR = [
  '[aria-modal="true"]',
  '[role="dialog"][data-state="open"]:not([data-radix-popper-content-wrapper] *)',
  '[role="alertdialog"][data-state="open"]',
].join(", ");
const modalListeners = new Set<() => void>();
let modalOpen = false;
let modalObserver: MutationObserver | undefined;

function checkModal() {
  const open = document.querySelector(MODAL_SELECTOR) !== null;
  if (open === modalOpen) return;
  modalOpen = open;
  modalListeners.forEach((listener) => listener());
}

function watchModals(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  modalListeners.add(listener);
  if (!modalObserver) {
    modalObserver = new MutationObserver(checkModal);
    modalObserver.observe(document.body, { childList: true, subtree: true });
    modalOpen = document.querySelector(MODAL_SELECTOR) !== null;
  }
  return () => {
    modalListeners.delete(listener);
    if (modalListeners.size > 0) return;
    modalObserver?.disconnect();
    modalObserver = undefined;
  };
}

export interface DockBrowserSessionOptions {
  /** 原生视图已由外部桥接打开，挂载时直接接管而不再重复调用 browser_open。 */
  alreadyOpen?: boolean;
  /** 隐藏时移至离屏坐标而非 setVisible(false)，确保模型后台操作与截图正常。 */
  parkBounds?: BrowserBounds;
  /** 卸载时是否销毁原生视图；返回 false 时仅移回离屏，避免中断进行中的模型操作。 */
  shouldCloseOnDispose?: () => boolean;
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
    if (options?.parkBounds) {
      await invoke("browser_bounds", { browserId, ...options.parkBounds });
    } else {
      await invoke("browser_visible", { browserId, visible: false });
    }
    visible = false;
    appliedBounds = "";
  };

  const closeChild = async () => {
    if (closed) return;
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

  // 调用方最近一次请求的位置与可见性；模态框关闭后据此恢复。
  let requested: { bounds?: BrowserBounds; visible: boolean } = { visible: false };
  const apply = () => {
    if (disposed || failed) return;
    const nextBounds = requested.bounds ?? desired?.bounds;
    if (!nextBounds) return;
    const next = { bounds: nextBounds, visible: requested.visible && !!requested.bounds && !modalOpen };
    if (JSON.stringify(desired) === JSON.stringify(next)) return;
    desired = next;
    // Inactive unopened tab: don't create native child yet
    if (!opened && !next.visible) return;
    if (!scheduled) {
      scheduled = true;
      void enqueue(sync).catch(report);
    }
  };
  const unwatchModals = watchModals(apply);

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
      unwatchModals();
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
