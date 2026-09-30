import type { ImageContent } from "@earendil-works/pi-ai";
import type { SubagentRunInfo } from "@qone/protocol";

/** Present child output to the parent without putting base64 image bytes in JSON text. */
export function subagentResultForModel(info: SubagentRunInfo) {
  const images: ImageContent[] = [];
  const imageRefs = info.parts.flatMap((part): Array<{ filename?: string; attached?: true; url?: string; unsupported?: true }> => {
    if (part.type !== "image") return [];
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(part.image);
    if (match) {
      images.push({ type: "image", mimeType: match[1]!.toLowerCase(), data: match[2]! });
      return [{ filename: part.filename, attached: true }];
    }
    if (/^data:/i.test(part.image)) return [{ filename: part.filename, unsupported: true }];
    return [{ filename: part.filename, url: part.image }];
  });
  const summary = {
    runId: info.id,
    status: info.status,
    result: info.content,
    error: info.error,
    streaming: info.streaming,
    children: info.children,
    images: imageRefs,
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(summary) }, ...images], details: summary };
}

export function subagentWorkflowResultForModel(results: SubagentRunInfo[]) {
  const summaries = results.map(result => subagentResultForModel(result));
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(summaries.map((result) => result.details)) },
      ...summaries.flatMap((result) => result.content.filter((part): part is ImageContent => part.type === "image")),
    ],
    details: summaries.map((result) => result.details),
  };
}
