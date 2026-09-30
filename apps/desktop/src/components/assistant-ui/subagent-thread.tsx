import type { ComponentProps, FC, PropsWithChildren } from "react";
import { ReadonlyThreadProvider, ThreadPrimitive } from "@assistant-ui/react";

type SubagentThreadProps = PropsWithChildren<{
  messages: ComponentProps<typeof ReadonlyThreadProvider>["messages"];
}>;

/** Mount a fresh bottom-following viewport whenever a subagent detail is opened. */
export const SubagentThread: FC<SubagentThreadProps> = ({ messages, children }) => (
  <ReadonlyThreadProvider messages={messages}>
    <ThreadPrimitive.Viewport
      className="q-subagent-panel-scroll"
      turnAnchor="bottom"
      autoScroll
      scrollToBottomOnInitialize
      scrollToBottomOnRunStart
      scrollToBottomOnThreadSwitch
    >
      {children}
    </ThreadPrimitive.Viewport>
  </ReadonlyThreadProvider>
);
