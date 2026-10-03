import type { ThreadMessageLike } from "@assistant-ui/react";
import type { AssistantMessagePart, SubagentRunInfo } from "@qone/protocol";
const imagesInParts = new WeakMap<readonly AssistantMessagePart[], Extract<AssistantMessagePart, { type: "image" }>[]>();

type ImagePart = { type: "image"; image: string; filename?: string; status: { type: "complete" }; startedAt: number };

/** Collect child images once per parent run, in child start and content order. */
export function subagentImagesByRun(subagents: readonly SubagentRunInfo[]): Map<string, ImagePart[]> {
  const imagesByRun = new Map<string, ImagePart[]>();
  const seenByRun = new Map<string, Set<string>>();
  for (const child of [...subagents].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))) {
    let imageParts = imagesInParts.get(child.parts);
    if (!imageParts) {
      imageParts = child.parts.filter((part): part is Extract<AssistantMessagePart, { type: "image" }> => part.type === "image" && Boolean(part.image));
      imagesInParts.set(child.parts, imageParts);
    }
    for (const part of imageParts) {
      if (part.type !== "image" || !part.image) continue;
      const seen = seenByRun.get(child.parentRunId) ?? new Set<string>();
      if (seen.has(part.image)) continue;
      seen.add(part.image);
      seenByRun.set(child.parentRunId, seen);
      const images = imagesByRun.get(child.parentRunId) ?? [];
      // A finished child image must not inherit the still-running parent
      // message status, which would make assistant-ui show a spinner.
      images.push({ type: "image", image: part.image, filename: part.filename, status: { type: "complete" }, startedAt: child.startedAt });
      imagesByRun.set(child.parentRunId, images);
    }
  }
  return imagesByRun;
}

function sameImages(a: Map<string, ImagePart[]>, b: Map<string, ImagePart[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [runId, images] of a) {
    const next = b.get(runId);
    if (!next || images.length !== next.length || images.some((image, index) => image.image !== next[index]?.image || image.filename !== next[index]?.filename || image.startedAt !== next[index]?.startedAt)) return false;
  }
  return true;
}

/** Keep the main thread idle while child text streams without new images. */
export function createSubagentImagesSelector() {
  let lastSubagents: readonly SubagentRunInfo[] | undefined;
  let lastImages = new Map<string, ImagePart[]>();
  return (state: { subagents: SubagentRunInfo[] }): Map<string, ImagePart[]> => {
    if (state.subagents === lastSubagents) return lastImages;
    const next = subagentImagesByRun(state.subagents);
    lastSubagents = state.subagents;
    if (!sameImages(lastImages, next)) lastImages = next;
    return lastImages;
  };
}
export const selectSubagentImages = createSubagentImagesSelector();

export function appendSubagentImages(content: ThreadMessageLike["content"], images?: readonly ImagePart[], after?: number, through?: number): ThreadMessageLike["content"] {
  if (!images?.length) return content;
  const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  const seen = new Set(parts.flatMap((part) => part.type === "image" ? [part.image] : []));
  const additions = images.flatMap(({ startedAt, ...part }) => {
    if ((after !== undefined && startedAt <= after) || (through !== undefined && startedAt > through) || seen.has(part.image)) return [];
    seen.add(part.image);
    return [part];
  });
  return additions.length ? [...parts, ...additions] : content;
}
