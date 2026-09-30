import type { Attachment } from "@assistant-ui/react";
import type { BaseComposerRuntimeCore } from "@assistant-ui/core/internal";

/** Public-method lifecycle instrumentation; no private runtime state access. */
class ComposerDraftOperations {
  private readonly adds = new Set<Promise<void>>();
  private sending = false;
  private generation = 0;
  private sentIds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly add;
  private readonly send;
  private readonly reset;
  private readonly clear;

  constructor(private readonly composer: BaseComposerRuntimeCore) {
    this.add = composer.addAttachment;
    this.send = composer.send;
    this.reset = composer.reset;
    this.clear = composer.clearAttachments;
    composer.addAttachment = (input) => {
      // Install before invoking add: an adapter can notify synchronously.
      let resolve!: () => void;
      const task = new Promise<void>((done) => { resolve = done; });
      this.adds.add(task);
      return this.add.call(composer, input).finally(() => {
        this.adds.delete(task);
        resolve();
        this.notify();
      });
    };
    composer.send = async (options) => {
      if (this.sending) return;
      this.sending = true;
      const generation = this.generation;
      try {
        // Never send a half-prepared chip: a later generator yield could
        // otherwise insert that already-sent attachment back into the draft.
        while (this.adds.size > 0) await Promise.all([...this.adds]);
        if (generation !== this.generation || !composer.canSend) return;
        this.sentIds = new Set(composer.attachments.map((attachment) => attachment.id));
        await this.send.call(composer, options);
      } finally {
        this.sentIds.clear();
        this.sending = false;
        this.notify();
      }
    };
    composer.reset = () => {
      this.generation++;
      return this.reset.call(composer);
    };
    composer.clearAttachments = () => {
      this.generation++;
      return this.clear.call(composer);
    };
  }

  get pending(): boolean {
    return this.adds.size > 0 || this.sending;
  }

  draftAttachments(attachments: readonly Attachment[]): readonly Attachment[] {
    return this.sentIds.size > 0 ? attachments.filter((attachment) => !this.sentIds.has(attachment.id)) : attachments;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.release();
    };
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
    this.release();
  }

  private release() {
    if (this.pending || this.listeners.size > 0) return;
    this.composer.addAttachment = this.add;
    this.composer.send = this.send;
    this.composer.reset = this.reset;
    this.composer.clearAttachments = this.clear;
    operations.delete(this.composer);
  }
}

const operations = new WeakMap<BaseComposerRuntimeCore, ComposerDraftOperations>();
export function observeDraftOperations(composer: BaseComposerRuntimeCore) {
  let observer = operations.get(composer);
  if (!observer) operations.set(composer, observer = new ComposerDraftOperations(composer));
  return observer;
}
