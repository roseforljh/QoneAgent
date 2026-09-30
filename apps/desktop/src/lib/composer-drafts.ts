import type { Attachment, ComposerState } from "@assistant-ui/react";

export type ComposerDraft = Pick<ComposerState, "text" | "attachments" | "quote">;
type SessionId = string | undefined;

/** Unsent UI state, retained across chat-page remounts, not app restarts. */
export class ComposerDraftStore {
  private readonly drafts = new Map<SessionId, ComposerDraft>();
  private readonly listeners = new Map<SessionId, Set<() => void>>();
  private readonly sources = new WeakMap<object, () => void>();
  private readonly uploadOwners = new WeakMap<Attachment, object>();

  get(sessionId: SessionId): ComposerDraft | undefined {
    return this.drafts.get(sessionId);
  }

  set(sessionId: SessionId, draft: ComposerDraft) {
    const previous = this.drafts.get(sessionId);
    // Keep attachment-only and whitespace-only drafts; retain File references
    // rather than serializing/copying media or losing qoneLocalPath metadata.
    if (draft.text === "" && draft.attachments.length === 0 && draft.quote === undefined) {
      if (!this.drafts.delete(sessionId)) return;
    } else {
      if (previous?.text === draft.text && previous.attachments === draft.attachments && previous.quote === draft.quote) return;
      this.drafts.set(sessionId, draft);
    }
    this.notify(sessionId);
  }

  subscribe(sessionId: SessionId, callback: () => void): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) this.listeners.set(sessionId, listeners = new Set());
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  /** A detached upload may update only attachments it still owns. */
  patchAttachments(sessionId: SessionId, previous: readonly Attachment[], next: readonly Attachment[]) {
    const draft = this.drafts.get(sessionId);
    if (!draft || previous === next) return;
    const before = new Map(previous.map((attachment) => [attachment.id, attachment]));
    const after = new Map(next.map((attachment) => [attachment.id, attachment]));
    const currentIds = new Set(draft.attachments.map((attachment) => attachment.id));
    const attachments = draft.attachments.flatMap((attachment) => {
      // A removed or independently replaced chip must not be resurrected by
      // an old upload, and an old composer must never overwrite newer edits.
      if (attachment !== before.get(attachment.id)) return [attachment];
      const updated = after.get(attachment.id);
      return updated ? [updated] : [];
    });
    for (const attachment of next) {
      if (!before.has(attachment.id) && !currentIds.has(attachment.id)) attachments.push(attachment);
    }
    if (attachments.length === draft.attachments.length && attachments.every((attachment, index) => attachment === draft.attachments[index])) return;
    this.set(sessionId, { ...draft, attachments });
  }

  observeUploads(source: object, attachments: readonly Attachment[]) {
    for (const attachment of attachments) {
      if (attachment.status.type === "running" && !this.uploadOwners.has(attachment)) {
        this.uploadOwners.set(attachment, source);
      }
    }
  }

  hasUploads(source: object, attachments: readonly Attachment[]): boolean {
    return attachments.some((attachment) => attachment.status.type === "running" && this.uploadOwners.get(attachment) === source);
  }

  /** Effect rebinding must not leave a second observer on the same core. */
  stopSource(source: object) {
    this.sources.get(source)?.();
  }

  trackSource(source: object, stop: () => void): () => void {
    this.sources.set(source, stop);
    return () => {
      if (this.sources.get(source) === stop) this.sources.delete(source);
    };
  }

  prune(sessionIds: readonly string[]) {
    const existing = new Set(sessionIds);
    for (const id of this.drafts.keys()) {
      if (id !== undefined && !existing.has(id)) {
        this.drafts.delete(id);
        this.notify(id);
      }
    }
  }

  private notify(sessionId: SessionId) {
    for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener();
  }
}

export const composerDrafts = new ComposerDraftStore();
export { bindComposerDrafts } from "./composer-draft-binding";
