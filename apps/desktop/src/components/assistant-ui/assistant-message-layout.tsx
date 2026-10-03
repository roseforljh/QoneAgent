import { MessagePrimitive } from "@assistant-ui/react";
import type { ReactNode } from "react";

/**
 * Keep assistant actions inside the message target. The top-anchor reserve is
 * inserted immediately after that target while a turn is being laid out.
 */
export function AssistantMessageLayout({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <MessagePrimitive.Root className="q-message-root q-message-assistant relative flex w-full flex-col">
      {children}
      {actions && <div className="q-assistant-message-action-slot">{actions}</div>}
    </MessagePrimitive.Root>
  );
}
