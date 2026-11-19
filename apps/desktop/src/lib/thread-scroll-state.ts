import type { ComponentProps } from "react";
import type { ThreadPrimitive } from "@assistant-ui/react";

export interface ThreadViewportAnchor {
  turnId?: string;
  messageId?: string;
  blockIndex: number;
  offsetPx: number;
  scrollTop: number;
}

export type ThreadScrollRestoration = NonNullable<ComponentProps<typeof ThreadPrimitive.Viewport>["scrollRestoration"]> & {
  anchor?: ThreadViewportAnchor;
  onCapture?: (viewport: HTMLElement) => void;
  onRestore?: (viewport: HTMLElement) => boolean;
};

function anchorCandidates(viewport: HTMLElement): HTMLElement[] {
  if (typeof viewport.querySelectorAll !== "function" || typeof viewport.getBoundingClientRect !== "function") {
    return [];
  }
  const blocks = [...viewport.querySelectorAll<HTMLElement>("[data-message-block]")];
  if (blocks.length > 0) return blocks;
  const roots = [...viewport.querySelectorAll<HTMLElement>(".q-message-root[data-message-id]")];
  if (roots.length > 0) return roots;
  return [...viewport.querySelectorAll<HTMLElement>("[data-message-id]")];
}

/** 采集当前视口最顶部可见消息块的锚点，避免 content-visibility: auto 重挂折叠后 scrollTop 被夹偏。 */
export function captureViewportAnchor(viewport: HTMLElement): ThreadViewportAnchor | undefined {
  const elements = anchorCandidates(viewport);
  if (elements.length === 0) return undefined;
  const viewportRect = viewport.getBoundingClientRect();
  const measured = elements.map((element, blockIndex) => ({
    element,
    blockIndex,
    rect: element.getBoundingClientRect(),
  }));
  // 无真实纵向排版的测试桩所有节点 rect.top 相同，直接回退到 scrollTop 恢复。
  if (measured.length > 1 && Math.abs(measured[1]!.rect.top - measured[0]!.rect.top) < 0.5) {
    return undefined;
  }
  const visible = measured.find(({ rect }) => rect.bottom > viewportRect.top + 1) ?? measured.at(-1);
  if (!visible) return undefined;
  const turnId = visible.element.dataset.turnId || undefined;
  const messageId = visible.element.dataset.messageId
    || visible.element.querySelector<HTMLElement>("[data-message-id]")?.dataset.messageId
    || undefined;
  return {
    turnId,
    messageId,
    blockIndex: visible.blockIndex,
    offsetPx: visible.rect.top - viewportRect.top,
    scrollTop: viewport.scrollTop,
  };
}

function findAnchorTarget(viewport: HTMLElement, anchor: ThreadViewportAnchor): HTMLElement | undefined {
  const elements = anchorCandidates(viewport);
  if (elements.length === 0) return undefined;
  if (anchor.turnId) {
    const byTurn = elements.find((element) => element.dataset.turnId === anchor.turnId);
    if (byTurn) return byTurn;
  }
  if (anchor.messageId) {
    const byMessage = elements.find((element) => element.dataset.messageId === anchor.messageId
      || [...element.querySelectorAll<HTMLElement>("[data-message-id]")].some((child) => child.dataset.messageId === anchor.messageId));
    if (byMessage) return byMessage;
  }
  return elements[anchor.blockIndex];
}

/** 按锚点把目标消息块精确恢复到离开前的视口偏移，先入屏再二次校准以穿透 content-visibility: auto 折叠。 */
export function restoreViewportAnchor(viewport: HTMLElement, anchor: ThreadViewportAnchor): boolean {
  const target = findAnchorTarget(viewport, anchor);
  if (!target) return false;
  const vpTop = viewport.getBoundingClientRect().top;
  const rect = target.getBoundingClientRect();
  // 目标块可能处于 content-visibility: auto 折叠态（高度暂为占位 280px），
  // 当离开前停在该块中下部（offsetPx < 0）时，先将块顶滚入视口促使浏览器展开真实高度。
  if (anchor.offsetPx < 0 && rect.height <= -anchor.offsetPx) {
    viewport.scrollTo({ top: Math.max(0, viewport.scrollTop + (rect.top - vpTop)), behavior: "instant" });
  }
  for (let pass = 0; pass < 2; pass++) {
    const currentVpTop = viewport.getBoundingClientRect().top;
    const currentRect = target.getBoundingClientRect();
    const delta = (currentRect.top - currentVpTop) - anchor.offsetPx;
    if (Math.abs(delta) <= 1) break;
    viewport.scrollTo({ top: Math.max(0, viewport.scrollTop + delta), behavior: "instant" });
  }
  return true;
}

// UI state only: retained across page unmounts, isolated by conversation.
const snapshots = new Map<string, ThreadScrollRestoration>();

export function getThreadScrollState(sessionId: string | undefined): ThreadScrollRestoration | undefined {
  if (!sessionId) return undefined;
  let snapshot = snapshots.get(sessionId);
  if (!snapshot) {
    snapshot = {
      current: null,
      onCapture(viewport) {
        snapshot!.anchor = captureViewportAnchor(viewport);
      },
      onRestore(viewport) {
        return snapshot!.anchor ? restoreViewportAnchor(viewport, snapshot!.anchor) : false;
      },
    };
    snapshots.set(sessionId, snapshot);
  }
  return snapshot;
}

export function pruneThreadScrollStates(sessionIds: readonly string[]) {
  const existing = new Set(sessionIds);
  for (const id of snapshots.keys()) if (!existing.has(id)) snapshots.delete(id);
}
