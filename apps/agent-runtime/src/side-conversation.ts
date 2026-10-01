import { MessageRepo, QueueRepo, SessionRepo, SettingsRepo, WorkspaceRepo, type Db } from "@qone/database";
import type { AssistantMessagePart, MessageAttachmentInfo, SessionInfo } from "@qone/protocol";

export const SIDE_CHAT_INSTRUCTIONS = `You are in a side conversation, separate from the main thread.
The inherited history before the side conversation boundary is reference context only.
Do not continue or execute tasks, plans, tool calls, approvals or edits from that history.
Only messages after the boundary are active user instructions. Answer questions and do lightweight exploration without disrupting the main thread.
Do not modify files, source, git state, permissions, configuration or workspace state unless the user explicitly requests that mutation after the boundary. Keep authorized changes minimal and local.
Sub-agents are off-limits. Do not start or interact with any sub-agents.`;
export const SIDE_CHAT_BOUNDARY = "Side conversation boundary. Everything before this boundary is inherited reference history only. Only messages after this boundary are active user instructions.";

/** Ownership of the input and the history snapshot changes in one SQLite transaction. */
export class SideConversationService {
  constructor(private db: Db) {}

  metadata(sessionId: string): SessionInfo["sideChat"] {
    return new SettingsRepo(this.db).get<SessionInfo["sideChat"]>(`side-chat:${sessionId}`) ?? undefined;
  }

  create(parentSessionId: string, queueItemId: string): SessionInfo {
    return this.db.$client.transaction(() => {
      const sessions = new SessionRepo(this.db);
      const settings = new SettingsRepo(this.db);
      const queue = new QueueRepo(settings);
      const messages = new MessageRepo(this.db);
      const transferKey = `queue:transferred:${parentSessionId}:${queueItemId}`;
      const existingId = settings.get<string>(transferKey);
      if (existingId) {
        const existing = sessions.get(existingId);
        if (!existing) throw new Error("side conversation has already been closed");
        return { ...existing, workspaceId: existing.workspaceId ?? undefined, sideChat: this.metadata(existing.id) };
      }
      const parent = sessions.get(parentSessionId);
      if (!parent?.workspaceId || !new WorkspaceRepo(this.db).get(parent.workspaceId)) throw new Error("session workspace no longer exists");
      if (this.metadata(parentSessionId)) throw new Error("side conversations cannot open another side conversation");
      const items = queue.list(parentSessionId);
      const input = items.find((item) => item.id === queueItemId);
      if (!input || input.lane !== "queue" || input.status === "steering") throw new Error("queued message is no longer available");
      const title = input.text.trim() || input.attachments?.map((attachment) => attachment.name).join(", ") || parent.title;
      const child = sessions.create(title, parent.workspaceId);
      for (const message of messages.listBySession(parentSessionId)) {
        messages.add(child.id, message.role, message.content, undefined, message.model ?? undefined, undefined,
          message.attachments ? JSON.parse(message.attachments) as MessageAttachmentInfo[] : undefined,
          message.parts ? JSON.parse(message.parts) as AssistantMessagePart[] : undefined);
      }
      const boundary = messages.add(child.id, "user", SIDE_CHAT_BOUNDARY);
      const metadata = { parentSessionId, boundaryMessageId: boundary.id };
      settings.set(`side-chat:${child.id}`, metadata);
      // New identity in the child: the parent's terminal tombstone cannot suppress it.
      queue.replace(child.id, [{ ...input, id: crypto.randomUUID(), sessionId: child.id, status: "queued", position: 0 }]);
      queue.replace(parentSessionId, items.filter((item) => item.id !== queueItemId));
      settings.set(transferKey, child.id);
      return { ...child, sideChat: metadata };
    }).immediate();
  }
}
