import type { BrowserBounds } from "./dock-browser-session";

type BrowserInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

// 原生浏览器视图平时画在主界面之上，DOM 盖不住它。弹窗打开时不隐藏它，而是请主进程把它沉到
// 主界面之下并让主界面透明，再用 #root 的遮罩挖出网页所在区域：挂在 body 下的弹窗和遮罩层
// 就盖在实时网页上。弹窗由显式引用计数锁登记，标准 aria-modal="true" 节点作为兜底观察。
const FALLBACK_MODAL_SELECTOR = '[aria-modal="true"]';
const MASK_PROPERTIES = ["mask-image", "mask-position", "mask-size", "mask-repeat", "mask-composite"];
let explicitOverlayLocks = 0;
let domModalOpen = false;
let modalObserver: MutationObserver | undefined;
let attached = 0;
let invoke: BrowserInvoke | undefined;
let underlay = false;
let underlaySeq = 0;
const holes = new Map<object, BrowserBounds>();

export function isOverlayBlocking(): boolean {
  return explicitOverlayLocks > 0 || domModalOpen;
}

function paintHoles() {
  if (typeof document === "undefined") return;
  const rects = underlay ? [...holes.values()] : [];
  document.documentElement?.toggleAttribute("data-native-underlay", rects.length > 0);
  const root = document.getElementById?.("root");
  if (!root) return;
  if (!rects.length) {
    for (const property of MASK_PROPERTIES) root.style.removeProperty(property);
    return;
  }
  const solid = "linear-gradient(#000 0 0)";
  root.style.setProperty("mask-image", [solid, ...rects.map(() => solid)].join(","));
  root.style.setProperty("mask-position", ["0 0", ...rects.map((r) => `${Math.round(r.x)}px ${Math.round(r.y)}px`)].join(","));
  root.style.setProperty("mask-size", ["100% 100%", ...rects.map((r) => `${Math.round(r.w)}px ${Math.round(r.h)}px`)].join(","));
  root.style.setProperty("mask-repeat", "no-repeat");
  // 各个洞互不重叠，逐层异或即「整页减去所有洞」。
  root.style.setProperty("mask-composite", "exclude");
}

function syncUnderlay() {
  const on = isOverlayBlocking();
  if (on === underlay) return;
  underlay = on;
  const seq = ++underlaySeq;
  // 进入时先挖洞再下沉网页；退出时等网页回到顶层再补洞，两个方向都不露出空白帧。
  if (on) paintHoles();
  const settle = () => {
    if (!on && seq === underlaySeq) paintHoles();
  };
  if (!invoke) return settle();
  invoke("browser_underlay", { on }).then(settle, settle);
}

function checkModal() {
  const open = document.querySelector(FALLBACK_MODAL_SELECTOR) !== null;
  if (open === domModalOpen) return;
  domModalOpen = open;
  syncUnderlay();
}

/** 对话框/弹窗打开时持有遮挡锁，关闭或卸载时调用返回函数释放。 */
export function acquireNativeOverlayLock(): () => void {
  explicitOverlayLocks += 1;
  syncUnderlay();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    explicitOverlayLocks = Math.max(0, explicitOverlayLocks - 1);
    syncUnderlay();
  };
}

/** 每个浏览器会话挂载时调用，返回卸载函数。 */
export function attachNativeUnderlay(nextInvoke: BrowserInvoke): () => void {
  invoke = nextInvoke;
  // 弹窗先于任何浏览器会话打开时，主进程还没收到过状态。
  if (underlay) void nextInvoke("browser_underlay", { on: true }).catch(() => undefined);
  attached += 1;
  if (typeof document !== "undefined" && typeof MutationObserver !== "undefined" && !modalObserver) {
    modalObserver = new MutationObserver(checkModal);
    modalObserver.observe(document.body, { childList: true, subtree: true });
    domModalOpen = document.querySelector(FALLBACK_MODAL_SELECTOR) !== null;
    syncUnderlay();
  }
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    attached -= 1;
    if (attached > 0) return;
    modalObserver?.disconnect();
    modalObserver = undefined;
    domModalOpen = false;
    syncUnderlay();
  };
}

/** 登记（或以 undefined 撤销）一个正在显示的原生浏览器区域，弹窗打开期间在这里挖洞。 */
export function setNativeUnderlayHole(owner: object, bounds: BrowserBounds | undefined): void {
  if (bounds) holes.set(owner, bounds);
  else if (!holes.delete(owner)) return;
  if (underlay) paintHoles();
}
