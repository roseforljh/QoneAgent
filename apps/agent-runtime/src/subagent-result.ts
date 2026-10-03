import type { ImageContent } from "@earendil-works/pi-ai";
import type { AssistantMessagePart, SubagentRunInfo } from "@qone/protocol";

type SummaryMessage = { role?: string; content?: string };
type SummarySource = {
  content?: string;
  parts?: readonly AssistantMessagePart[];
  messages?: readonly SummaryMessage[];
  streaming?: string;
  status?: string;
};

function latestPartSequence(parts: readonly AssistantMessagePart[]): number | undefined {
  const sequences = parts
    .filter((part) => part.type === "text" || part.type === "image")
    .map((part) => part.messageSequence)
    .filter((sequence) => Number.isFinite(sequence));
  return sequences.length ? Math.max(...sequences) : undefined;
}

function finalAnswerParts(parts: readonly AssistantMessagePart[]): AssistantMessagePart[] {
  const finalText = parts.filter((part) => part.type === "text" && part.phase === "final_answer");
  const sequence = finalText.length
    ? Math.max(...finalText.map((part) => part.messageSequence))
    : latestPartSequence(parts);
  return sequence === undefined
    ? []
    : parts.filter((part) => part.messageSequence === sequence && (part.type === "text" || part.type === "image"));
}

/** Return only the last assistant answer, never the accumulated child transcript. */
export function finalSubagentSummary(source: SummarySource): string {
  const parts = source.parts ?? [];
  const active = source.status === "created" || source.status === "running" || source.status === "waiting_approval" || source.status === "paused";
  const streaming = source.streaming?.trim();
  if (active && streaming) return streaming;

  // Legacy rows may have no structured parts. In that case content is the only
  // persisted result that can be trusted; do not replace it with an old turn
  // from the optional transcript.
  if (!parts.length && source.content?.trim()) return source.content.trim();

  const explicitFinalSequences = parts
    .filter((part) => part.type === "text" && part.phase === "final_answer")
    .map((part) => part.messageSequence);
  const explicitFinalSequence = explicitFinalSequences.length ? Math.max(...explicitFinalSequences) : undefined;
  const explicitFinalParts = explicitFinalSequence === undefined
    ? []
    : parts.filter((part) => part.type === "text" && part.phase === "final_answer" && part.messageSequence === explicitFinalSequence);
  const explicitFinalText = explicitFinalParts
    .filter((part): part is Extract<AssistantMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
  if (explicitFinalText) return explicitFinalText;

  const messageText = [...(source.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant" && message.content?.trim())?.content?.trim();
  if (messageText) return messageText;

  const stored = source.content?.trim();
  if (stored) return stored;

  const selectedParts = finalAnswerParts(parts);
  const partText = selectedParts
    .filter((part): part is Extract<AssistantMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
  if (partText) return partText;
  return streaming ?? "";
}

/** Present child output to the parent without putting base64 image bytes in JSON text. */
export function subagentResultForModel(info: SubagentRunInfo) {
  const images: ImageContent[] = [];
  const summaryParts = finalAnswerParts(info.parts);
  const imageRefs = summaryParts.flatMap((part): Array<{ filename?: string; attached?: true; url?: string; unsupported?: true }> => {
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
    title: info.title,
    status: info.status,
    result: finalSubagentSummary(info),
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
