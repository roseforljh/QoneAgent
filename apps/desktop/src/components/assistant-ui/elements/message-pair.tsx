"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { take } from "../utils/range";
import "../message-actions.css";

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
    "min-w-0 max-w-[70%] self-end break-words text-start",
    variant === "bubble"
      ? "q-user-message-bubble"
      : "text-foreground/90 text-end",
  );

  return (
    <div
      data-slot="message-pair"
      className={cn("flex w-full flex-col gap-4", className)}
      {...props}
    >
      {showUser && (
        <div className="q-user-message-group flex w-full flex-col items-end gap-1">
          {userContent ? (
            userContentIsSurface ? userContent : <div className={userSurfaceClass}>{userContent}</div>
          ) : (
            <p className={userSurfaceClass}>{userMessage}</p>
          )}
          {userActions && (
            <div className="q-user-message-action-slot">
              {userActions}
            </div>
          )}
        </div>
      )}
      {betweenContent}
      <div className="q-assistant-message-group flex w-full flex-col items-start">
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
        {actions && <div className="q-assistant-message-action-slot">{actions}</div>}
      </div>
    </div>
  );
}
