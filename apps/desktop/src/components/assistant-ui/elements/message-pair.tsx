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
  betweenContent?: ReactNode;
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
  betweenContent,
  assistantContent,
  actions,
  showUser = true,
  className,
  ...props
}: MessagePairProps) {
  const shown = take(words, visibleWords);
  const userSurfaceClass = cn(
    "min-w-0 max-w-[75%] self-end break-words text-start",
    variant === "bubble"
      ? "rounded-2xl bg-foreground/[0.05] dark:bg-foreground/[0.07] px-4 py-2.5 text-foreground text-[14.5px] leading-relaxed shadow-xs"
      : "text-foreground/90 text-end",
  );

  return (
    <div
      data-slot="message-pair"
      className={cn("flex w-full flex-col gap-4", className)}
      {...props}
    >
      {showUser && (
        <div className="group/user flex w-full flex-col items-end gap-1">
          {userAttachmentContent}
          {userContent ? (
            userContentIsSurface ? userContent : <div className={userSurfaceClass}>{userContent}</div>
          ) : (
            <p className={userSurfaceClass}>{userMessage}</p>
          )}
          {userActions && (
            <div className="pointer-events-none flex items-center gap-1 pt-0.5 opacity-0 transition-opacity duration-150 group-focus-within/user:pointer-events-auto group-focus-within/user:opacity-100 group-hover/user:pointer-events-auto group-hover/user:opacity-100 motion-reduce:transition-none">
              {userActions}
            </div>
          )}
        </div>
      )}
      {betweenContent}
      <div className="group/message flex w-full flex-col items-start">
        {assistantContent ?? (
          <p className="min-h-[4.25rem] text-[15px] leading-[1.7]">
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
          </p>
        )}
        <div className="pointer-events-none flex items-center gap-1 pt-1.5 opacity-0 transition-opacity duration-200 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 motion-reduce:transition-none">
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
