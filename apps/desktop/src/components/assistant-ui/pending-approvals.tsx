import { useConversationStore } from "../../lib/conversation-context";
import { ApprovalCard } from "../tool-ui/ToolCard";

export function PendingApprovals() {
  const approvals = useConversationStore((state) => state.approvals);
  const approve = useConversationStore((state) => state.approve);
  const reject = useConversationStore((state) => state.reject);
  return <>{approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onApprove={() => approve(approval.id)} onReject={() => reject(approval.id)} />)}</>;
}
