import type { AssistantRuntime } from "@assistant-ui/react";
import { BaseComposerRuntimeCore, ThreadRuntimeImpl } from "@assistant-ui/core/internal";

/**
 * Isolate the typed core integration to assistant-ui's pinned version. The
 * public addAttachment API rebuilds attachments and drops File metadata for
 * CreateAttachment inputs; the core's restoreDraft preserves the actual draft
 * atomically, including pending files, IDs, content and native media paths.
 * Never reach into private fields or read the dynamically selected composer
 * from an outgoing subscription.
 */
export function getDraftComposer(runtime: Pick<AssistantRuntime, "thread">): BaseComposerRuntimeCore {
  const thread = runtime.thread;
  if (!(thread instanceof ThreadRuntimeImpl)) {
    throw new Error("Composer drafts require the assistant-ui thread runtime");
  }
  const composer = thread.__internal_threadBinding.getState().composer;
  if (!(composer instanceof BaseComposerRuntimeCore)) {
    throw new Error("Composer drafts require a restorable assistant-ui composer");
  }
  return composer;
}
