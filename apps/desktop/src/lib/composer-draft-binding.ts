import type { AssistantRuntime } from "@assistant-ui/react";
import { composerDrafts, type ComposerDraft, type ComposerDraftStore } from "./composer-drafts";
import { getDraftComposer } from "./composer-draft-runtime";

const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [], quote: undefined };

/**
 * Bind AFTER external-store applies the selected session's adapter. Resolve a
 * fixed core once, so neither cleanup nor late attachment updates can read or
 * write another session's composer through the public dynamic main binding.
 */
export function bindComposerDrafts(
  runtime: Pick<AssistantRuntime, "thread">,
  sessionId: string | undefined,
  isCurrent: () => boolean,
  drafts: ComposerDraftStore = composerDrafts,
): () => void {
  const composer = getDraftComposer(runtime);
  drafts.stopSource(composer);
  const saved = drafts.get(sessionId);
  if (saved && isCurrent()) composer.restoreDraft(saved);

  let active = true;
  let stopped = false;
  let mirroring = false;
  let previousAttachments = composer.attachments;
  let unsubscribeComposer = () => {};
  let unsubscribeDrafts = () => {};
  let releaseSource = () => {};
  const snapshot = (): ComposerDraft => ({
    text: composer.text,
    attachments: composer.attachments,
    quote: composer.quote,
  });
  const ownsUploads = () => drafts.hasUploads(composer, composer.attachments);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribeComposer();
    unsubscribeDrafts();
    releaseSource();
  };

  const capture = () => {
    if (stopped || mirroring) return;
    const previous = previousAttachments;
    previousAttachments = composer.attachments;
    drafts.observeUploads(composer, composer.attachments);
    if (active && isCurrent()) drafts.set(sessionId, snapshot());
    else drafts.patchAttachments(sessionId, previous, composer.attachments);
    // Only unfinished uploads need a detached observer. Ordinary local image,
    // text and media drafts require no background subscriptions or rereads.
    if (!active && !ownsUploads()) stop();
  };

  unsubscribeDrafts = drafts.subscribe(sessionId, () => {
    if (stopped || mirroring) return;
    const draft = drafts.get(sessionId);
    if (!active) {
      if (!draft) stop(); // Deleted/cleared drafts cannot be revived by uploads.
      return;
    }
    if (!isCurrent()) return;
    const current = snapshot();
    const next = draft ?? EMPTY_DRAFT;
    if (current.text === next.text && current.attachments === next.attachments && current.quote === next.quote) return;
    // Mirror an outgoing upload's progress/completion into its restored draft.
    // These core APIs neither reupload nor cancel newly added attachments.
    mirroring = true;
    try {
      composer.retractDraft(current);
      composer.restoreDraft(next);
      previousAttachments = composer.attachments;
    } finally {
      mirroring = false;
    }
  });
  unsubscribeComposer = composer.subscribe(capture);
  releaseSource = drafts.trackSource(composer, stop);
  capture();

  return () => {
    active = false;
    // Never snapshot in cleanup. At a switch the public main composer already
    // belongs to the next session; use only this binding's fixed upload source.
    // A restored running chip is still produced by its original core; keeping
    // observers for those mirror-only cores would leak one per round trip.
    if (!ownsUploads()) stop();
  };
}
