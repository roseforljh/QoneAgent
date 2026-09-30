import type { AssistantRuntime } from "@assistant-ui/react";

/** Unsent text is UI state, kept across chat-page remounts but not app restarts. */
export class ComposerDraftStore {
  private readonly drafts = new Map<string, string>();

  get(threadId: string): string | undefined {
    return this.drafts.get(threadId);
  }

  set(threadId: string, text: string) {
    // Preserve whitespace verbatim; only an actually empty draft is discarded.
    if (text === "") this.drafts.delete(threadId);
    else this.drafts.set(threadId, text);
  }

  delete(threadId: string) {
    this.drafts.delete(threadId);
  }
}

const composerDrafts = new ComposerDraftStore();

type DraftRuntime = Pick<AssistantRuntime, "threads" | "thread">;

/**
 * Observe runtime identity, not React's selected-session prop: external-store
 * replaces its main composer in an effect, after selection has already changed.
 * Saving in a component cleanup can therefore read the NEW empty composer and
 * overwrite the OLD draft. Capture every text change under its runtime owner.
 */
export function bindComposerDrafts(runtime: DraftRuntime, drafts = composerDrafts): () => void {
  let activeThreadId = runtime.threads.getState().mainThreadId;
  let knownThreadIds = new Set(runtime.threads.getState().threadIds);
  let restoring = false;

  const restore = () => {
    const text = drafts.get(activeThreadId);
    if (text !== undefined) runtime.thread.composer.setText(text);
  };
  restore();

  const sync = () => {
    if (restoring) return;
    const state = runtime.threads.getState();
    const nextThreadIds = new Set(state.threadIds);
    for (const id of knownThreadIds) {
      if (!nextThreadIds.has(id)) drafts.delete(id);
    }
    knownThreadIds = nextThreadIds;

    if (activeThreadId !== state.mainThreadId) {
      activeThreadId = state.mainThreadId;
      // Both subscriptions can fire during a switch. Do not cache the new
      // composer's initial blank value before its own draft has been restored.
      restoring = true;
      try { restore(); }
      finally { restoring = false; }
    }
    drafts.set(activeThreadId, runtime.thread.composer.getState().text);
  };

  // Composer subscription also follows replacement of the main runtime. This
  // covers either notification order, including a switch to an empty thread.
  const unsubscribeComposer = runtime.thread.composer.subscribe(sync);
  const unsubscribeThreads = runtime.threads.subscribe(sync);
  sync();
  return () => {
    sync();
    unsubscribeComposer();
    unsubscribeThreads();
  };
}
