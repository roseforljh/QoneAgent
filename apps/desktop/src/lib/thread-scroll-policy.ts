import type { ThreadMessage } from "@assistant-ui/react";
import { textPhaseFromParentId } from "./assistant-message-parts";

// Codex 26.928.2636 Pe/vk: the real tail excludes the response spacer.
export const THREAD_BOTTOM_TOLERANCE_PX = 24;
export const THREAD_BOTTOM_SCROLL_DURATION_MS = 260;
export type ThreadPhase = "idle" | "prework" | "final_answer";
export type ThreadFollowMode = "static" | "prework_watch" | "prework_follow" | "user_follow";
export interface ThreadFollowSnapshot { turnId?: string; mode: ThreadFollowMode }

export type ThreadFollowEvent =
  | { type: "phase"; previous: ThreadPhase; phase: ThreadPhase }
  | { type: "content"; phase: ThreadPhase; overflow: number }
  | { type: "distance"; phase: ThreadPhase; distance: number }
  | { type: "bottom"; phase: ThreadPhase }
  | { type: "hold" | "placed" };

/** The renderer's vk transition table, with domain names instead of minified names. */
export function nextThreadFollowMode(mode: ThreadFollowMode, event: ThreadFollowEvent): ThreadFollowMode {
  switch (event.type) {
    case "hold": case "placed": return "static";
    case "bottom": return event.phase === "prework" ? "prework_follow" : "user_follow";
    case "content": return event.phase === "prework" && mode === "prework_watch" && event.overflow > 0 ? "prework_follow" : mode;
    case "distance": return event.distance <= THREAD_BOTTOM_TOLERANCE_PX ? mode
      : mode === "prework_follow" ? "prework_watch"
      : mode === "user_follow" ? (event.phase === "prework" ? "prework_watch" : "static") : mode;
    case "phase": {
      if (event.previous !== "prework" && event.phase === "prework") {
        if (mode === "static") mode = "prework_watch";
        if (mode === "user_follow") mode = "prework_follow";
      }
      if (event.previous === "prework" && event.phase === "final_answer") mode = mode === "prework_follow" ? "user_follow" : "static";
      if (event.previous !== "idle" && event.phase === "idle") {
        mode = mode === "prework_follow" || mode === "user_follow" ? "user_follow" : "static";
      }
      return mode;
    }
  }
}

export function threadPhase(running: boolean, messages: readonly ThreadMessage[]): ThreadPhase {
  if (!running) return "idle";
  let workStarted = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim()) {
        const phase = textPhaseFromParentId(part.parentId);
        if (phase !== "commentary" && phase !== "pending") return "final_answer";
        workStarted = true;
      } else if (part.type === "reasoning" || part.type === "tool-call") workStarted = true;
      else if (part.type === "image") return "final_answer";
    }
  }
  return workStarted ? "prework" : "idle";
}

export function userMessageRevealScrollTop(scrollTop: number, messageTop: number, messageBottom: number, visibleTop: number, visibleBottom: number) {
  if (messageTop < visibleTop || messageBottom - messageTop > visibleBottom - visibleTop) return scrollTop + messageTop - visibleTop;
  if (messageBottom > visibleBottom) return scrollTop + messageBottom - visibleBottom;
  return null;
}
