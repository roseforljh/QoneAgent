import { create } from "zustand";
import type { McpElicitationAction, McpElicitationContent, McpElicitationInfo, RuntimeCommand } from "@qone/protocol";

/** Questions MCP servers are waiting on; the runtime always sends the full list. */
export const useElicitationStore = create<{ requests: McpElicitationInfo[] }>(() => ({ requests: [] }));

export function respondToElicitation(send: (command: RuntimeCommand) => Promise<boolean>, elicitationId: string, action: McpElicitationAction, content?: McpElicitationContent) {
  // Hide at once; the runtime's next list confirms it.
  useElicitationStore.setState((state) => ({ requests: state.requests.filter((request) => request.id !== elicitationId) }));
  return send({ type: "mcp.elicitation.respond", requestId: crypto.randomUUID(), elicitationId, action, ...(content ? { content } : {}) });
}
