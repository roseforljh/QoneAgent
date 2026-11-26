import type { RuntimeEvent } from "@qone/protocol";
import { dispatchScheduleError, dispatchScheduleList } from "../lib/schedule-state";
import { useElicitationStore } from "../lib/elicitation-state";

/** Runtime events owned by feature stores outside the main agent store. Returns true when consumed. */
export function handleFeatureEvent(message: RuntimeEvent): boolean {
  switch (message.type) {
    case "schedule.list": dispatchScheduleList(message); return true;
    case "mcp.elicitations": useElicitationStore.setState({ requests: message.requests }); return true;
    case "error": return dispatchScheduleError(message.requestId, message.message);
    default: return false;
  }
}
