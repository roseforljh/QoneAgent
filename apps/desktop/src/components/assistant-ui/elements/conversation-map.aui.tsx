"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuiState, useThreadViewport } from "@assistant-ui/react";
import type { ThreadMessage } from "@assistant-ui/react";
import { cn } from "../../../lib/utils";
import { useStore } from "../../../store";
import { ConversationMap, type ConversationMapEntry } from "./conversation-map";

const TOP_TOLERANCE = 1;

/** Use the viewport's own top inset for both navigation and the active tick. */
const visibleTop = (viewport: HTMLElement) => {
  const view = viewport.getBoundingClientRect();
  const inset = Number.parseFloat(getComputedStyle(viewport).scrollPaddingTop) || 0;
  return Math.min(view.bottom, view.top + inset);
};

const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

/**
 * The line a message has to cross to count as the one being read. It sits at
 * the top of the viewport for most of a thread, then slides to the bottom
 * across the final screenful: a message that starts within one viewport height
 * of the end can never reach the top, so a fixed line leaves the last screen's
 * worth of ticks permanently unreachable.
 */
const readingLine = (viewport: HTMLElement) => {
  const rect = viewport.getBoundingClientRect();
  const top = visibleTop(viewport);
  const height = rect.bottom - top;
  if (height <= 0) return top + TOP_TOLERANCE;

  const remaining = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  const descent = Math.min(1, Math.max(0, (height - remaining) / height));
  return top + height * descent + TOP_TOLERANCE;
};

const partsOf = (message: ThreadMessage) => [...message.content];

const textOf = (message: ThreadMessage) =>
  partsOf(message)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();

const labelOf = (message: ThreadMessage) => {
  const parts = partsOf(message);
  const tools = parts.flatMap((part) =>
    part.type === "tool-call" ? [part.toolName] : [],
  );
  if (tools.length === 1) return tools[0]!;
  if (tools.length > 1) return `${tools.length} tool calls`;
  if (parts.some((part) => part.type === "reasoning")) return "Reasoning";

  // A composer submission carries its files in `attachments` and leaves
  // `content` empty, so both places decide an attachment-only turn's label.
  const carriers = [...parts, ...(message.attachments ?? [])];
  if (carriers.some((carrier) => carrier.type === "image")) return "Image";
  if (carriers.some((carrier) => carrier.type === "file")) return "File";
  if (carriers.length > 0) return "Attachment";
  return message.role === "user" ? "Message" : "Response";
};

const linesOf = (message: ThreadMessage) =>
  textOf(message)
    .split("\n")
    .map((line) => line.replace(/^[\s#>*`-]+/, "").trim())
    .filter(Boolean);

/** A user message and the assistant messages answering it. */
type Turn = {
  head: ThreadMessage;
  members: ThreadMessage[];
};

const groupIntoTurns = (messages: readonly ThreadMessage[]) => {
  const turns: Turn[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;

    const current = turns.at(-1);
    if (message.role === "user") {
      turns.push({ head: message, members: [message] });
      continue;
    }
    if (!current) continue;
    current.members.push(message);
  }

  return turns;
};

const describe = ({ head, members }: Turn): ConversationMapEntry => {
  const lines = linesOf(head);
  const first = lines[0] ?? "";
  const title = first;

  // What the turn asked names it; what it answered is the useful preview, and
  // a turn still being answered falls back to the rest of its own text.
  const answer = members.find((member) => member !== head && textOf(member));
  const preview = (
    answer
      ? linesOf(answer).join(" ")
      : lines.slice(1).join(" ")
  )
    .trim();

  return {
    id: head.id,
    title: title || labelOf(head),
    ...(preview ? { preview } : {}),
  };
};

export function ConversationMapAui({
  side = "left",
  className,
}: {
  side?: "left" | "right";
  className?: string;
}) {
  const messages = useAuiState((s) => s.thread.messages);
  const sessionId = useStore((state) => state.currentSessionId);
  const viewport = useThreadViewport((s) => s.element.viewport);
  const viewportHeight = useThreadViewport((s) => s.height.viewport);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [visibleIds, setVisibleIds] = useState<readonly string[]>([]);
  // Hidden until the first measurement so a narrow layout never flashes the rail.
  const [tooNarrow, setTooNarrow] = useState(true);
  const scheduleRef = useRef<(() => void) | undefined>(undefined);
  const railRef = useRef<HTMLDivElement>(null);
  const cancelNavigationRef = useRef<(() => void) | undefined>(undefined);

  const turns = useMemo(() => groupIntoTurns(messages), [messages]);
  const entries = useMemo(() => turns.map(describe), [turns]);

  const turnKey = turns.map((turn) => turn.head.id).join(" ");

  useEffect(() => {
    if (!viewport) return undefined;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const view = viewport.getBoundingClientRect();
      const line = readingLine(viewport);

      // One pass yields both facts the rail draws: which turn is being read,
      // and which turns the viewport currently holds.
      let current: string | undefined;
      let firstId: string | undefined;
      let gutter: number | undefined;
      const onScreen: string[] = [];
      for (const block of viewport.querySelectorAll<HTMLElement>("[data-turn-id]")) {
        const box = block.getBoundingClientRect();
        if (box.top >= view.bottom) break;

        // Old blocks use content-visibility; only measure a message root once
        // its block is on screen, otherwise the rail would force its layout.
        if (gutter === undefined && box.bottom > view.top) {
          gutter = block.querySelector<HTMLElement>("[data-message-id]")?.getBoundingClientRect().left ?? block.getBoundingClientRect().left;
          gutter -= view.left;
        }

        const head = block.dataset["turnId"];
        if (head === undefined) continue;
        firstId ??= head;

        if (box.top <= line) current = head;
        if (box.bottom > view.top && !onScreen.includes(head)) {
          onScreen.push(head);
        }
      }

      setActiveId(current ?? firstId);
      setVisibleIds((previous) =>
        sameIds(previous, onScreen) ? previous : onScreen,
      );
      const railWidth = railRef.current?.offsetWidth ?? 0;
      setTooNarrow(gutter === undefined || gutter < railWidth);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    scheduleRef.current = schedule;
    schedule();
    viewport.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);

    return () => {
      scheduleRef.current = undefined;
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [viewport]);

  useEffect(() => {
    scheduleRef.current?.();
  }, [turnKey]);

  useEffect(() => () => cancelNavigationRef.current?.(), []);

  const select = useCallback(
    (id: string, behavior: ScrollBehavior = "smooth") => {
      if (!viewport) return;
      cancelNavigationRef.current?.();
      const target = [...viewport.querySelectorAll<HTMLElement>("[data-turn-id]")]
        .find((block) => block.dataset["turnId"] === id);
      if (!target) return;

      // Align the actual turn below the visible header edge. Recalculate from
      // live rectangles because earlier turns may still use intrinsic sizes.
      const destination = () => Math.max(0, Math.min(
        viewport.scrollHeight - viewport.clientHeight,
        viewport.scrollTop + target.getBoundingClientRect().top - visibleTop(viewport),
      ));
      const top = destination();
      if (behavior === "instant" || Math.abs(top - viewport.scrollTop) <= TOP_TOLERANCE) {
        viewport.scrollTo({ top, behavior: "instant" });
        return;
      }

      let frame = 0;
      let stableFrames = 0;
      const cancel = () => {
        if (frame) cancelAnimationFrame(frame);
        viewport.removeEventListener("scrollend", correct);
        viewport.removeEventListener("wheel", cancel);
        viewport.removeEventListener("touchstart", cancel);
        viewport.removeEventListener("pointerdown", cancel);
        viewport.removeEventListener("keydown", cancel);
        if (cancelNavigationRef.current === cancel) cancelNavigationRef.current = undefined;
      };
      const settle = () => {
        const next = destination();
        if (Math.abs(next - viewport.scrollTop) > TOP_TOLERANCE) {
          viewport.scrollTo({ top: next, behavior: "instant" });
          stableFrames = 0;
        } else {
          stableFrames++;
        }
        if (stableFrames < 2) frame = requestAnimationFrame(settle);
        else cancel();
      };
      const correct = () => {
        viewport.removeEventListener("scrollend", correct);
        frame = requestAnimationFrame(settle);
      };
      cancelNavigationRef.current = cancel;
      viewport.addEventListener("scrollend", correct, { once: true });
      viewport.addEventListener("wheel", cancel, { passive: true, once: true });
      viewport.addEventListener("touchstart", cancel, { passive: true, once: true });
      viewport.addEventListener("pointerdown", cancel, { once: true });
      viewport.addEventListener("keydown", cancel, { once: true });
      viewport.scrollTo({ top, behavior: "smooth" });
    },
    [viewport],
  );

  return (
    <div
      data-slot="conversation-map-rail"
      className={cn(
        "pointer-events-none sticky top-0 z-10 h-0 w-full",
        // `invisible` keeps the rail laid out so its width stays measurable.
        tooNarrow && "invisible",
        className,
      )}
    >
      <div
        ref={railRef}
        className={cn(
          "pointer-events-auto absolute top-0 px-3 py-10",
          side === "right" ? "right-0" : "left-0",
        )}
        style={{ height: viewportHeight }}
      >
        <ConversationMap
          entries={entries}
          activeId={activeId}
          visibleIds={visibleIds}
          onSelect={select}
          sessionId={sessionId}
          side={side === "right" ? "left" : "right"}
        />
      </div>
    </div>
  );
}
