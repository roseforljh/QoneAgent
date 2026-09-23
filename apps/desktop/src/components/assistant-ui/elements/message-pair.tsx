"use client";

import type { ComponentProps, ReactNode } from "react";
import { CopyIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "../../../lib/utils";
import { ghostButton } from "./surfaces";
import { take } from "../utils/range";

export interface MessagePairProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  userMessage: string;
  words: readonly string[];
  visibleWords: number;
  streaming: boolean;
  variant?: "bubble" | "flat";
  userContent?: ReactNode;
  userAttachmentContent?: ReactNode;
  userActions?: ReactNode;
  userContentIsSurface?: boolean;
  assistantContent?: ReactNode;
  actions?: ReactNode;
  showUser?: boolean;
}

export function MessagePair({
  userMessage,
  words,
  visibleWords,
  streaming,
  variant = "bubble",
  userContent,
  userAttachmentContent,
  userActions,
  userContentIsSurface = false,
  assistantContent,
  actions,
  showUser = true,
  className,
  ...props
}: MessagePairProps) {
  const shown = take(words, visibleWords);
  const userSurfaceClass = cn(
    "min-w-0 max-w-[85%] self-end break-words text-sm",
    variant === "bubble"
      ? "rounded-2xl border border-black/10 bg-[#0d0d0d] px-3.5 py-2 text-start text-white dark:border-white/10 dark:bg-[#2a2a2a] dark:text-[#f5f5f5]"
      : "text-foreground/90 text-end",
  );

  return (
    <div
      data-slot="message-pair"
      className={cn("flex w-full max-w-sm flex-col gap-5", className)}

      {...props}
    >
      {showUser && (
        <div className="group/user flex flex-col items-end">
          {userAttachmentContent}
          {userContent ? (
            userContentIsSurface ? userContent : <div className={userSurfaceClass}>{userContent}</div>
          ) : (
            <p className={userSurfaceClass}>{userMessage}</p>
          )}
          {userActions && (
            <div className="pointer-events-none flex items-center gap-1 pt-1 opacity-0 transition-opacity group-focus-within/user:pointer-events-auto group-focus-within/user:opacity-100 group-hover/user:pointer-events-auto group-hover/user:opacity-100 motion-reduce:transition-none">
              {userActions}
            </div>
          )}
        </div>
      )}
      <div className="group/message flex flex-col items-start">
        {assistantContent ?? (
          <p className="min-h-[4.25rem] text-sm leading-relaxed">
            {shown.map((word, index) => {
              const fresh = streaming && shown.length - 1 - index < 2;

              return (
                <span
                  key={`${word}-${index}`}
                  className="fade-in animate-in fill-mode-both duration-500 motion-reduce:animate-none"
                >
                  <span
                    className={cn(
                      "transition-colors duration-700 motion-reduce:transition-none",
                      fresh && "text-blue-500 dark:text-blue-400",
                    )}
                  >
                    {word}
                  </span>{" "}
                </span>
              );
            })}
            {streaming && shown.length > 0 && (
              <span
                aria-hidden
                className="-mb-0.5 ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-blue-500 motion-reduce:animate-none dark:bg-blue-400"
              />
            )}
          </p>
        )}
        <div className="pointer-events-none flex items-center gap-1 pt-1 opacity-0 transition-opacity group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 motion-reduce:transition-none">
          {actions ?? (
            <>
              <button
                type="button"
                aria-label="Copy response"
                className={cn(ghostButton, "size-7")}
              >
                <CopyIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Regenerate response"
                className={cn(ghostButton, "size-7")}
              >
                <RefreshCwIcon className="size-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
