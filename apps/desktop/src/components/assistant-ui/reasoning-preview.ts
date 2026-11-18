import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { useEffectEvent, useLayoutEffect, useMemo, useState } from "react";

const PREVIEW_INTERVAL_MS = 1_000;
const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const endsSentence = /\p{Sentence_Terminal}[\p{Close_Punctuation}\p{Final_Punctuation}"']*$/u;

export type ReasoningPreview = { text: string; start: number };
const emptyPreview: ReasoningPreview = { text: "", start: 0 };

function plainText(node: Nodes): string {
  if (node.type === "html") return "";
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

function hasContext(text: string): boolean {
  let hasWord = false;
  let hasMultiGraphemeWord = false;
  for (const { isWordLike, segment } of words.segment(text)) {
    if (!isWordLike) continue;
    // A fragment such as “我用” may already be split into two words.
    hasMultiGraphemeWord ||= Boolean(graphemes.segment(segment).containing(segment.length - 1)?.index);
    if (hasWord && hasMultiGraphemeWord) return true;
    hasWord = true;
  }
  return false;
}

/** Look back only when the latest line has no sentence with usable context. */
function selectPreview(text: string, running: boolean, previous?: ReasoningPreview): ReasoningPreview {
  let fallback: ReasoningPreview | undefined;
  for (let end = text.trimEnd().length; end > 0;) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const rawLine = text.slice(start, end).trim();
    end = start - 1;
    if (!rawLine) continue;
    const line = plainText(fromMarkdown(rawLine)).trim() || rawLine;
    let lastFragment: ReasoningPreview | undefined;
    let latest: ReasoningPreview | undefined;
    let complete: ReasoningPreview | undefined;
    for (const { index, segment } of sentences.segment(line)) {
      const sentence = segment.trim();
      if (!sentence) continue;
      lastFragment = { text: sentence, start: start + index };
      if (!hasContext(sentence)) continue;
      latest = lastFragment;
      if (endsSentence.test(sentence)) complete = latest;
    }
    fallback ??= lastFragment;
    // Prefer a newly finished sentence, then let the following one grow once
    // it contains more than a lone word or token.
    if (running && complete && (!previous || complete.start > previous.start
      || (complete.start === previous.start && complete.text !== previous.text))) return complete;
    if (latest) return latest;
  }
  return running ? emptyPreview : fallback ?? emptyPreview;
}

export function useReasoningPreview(text: string, running: boolean, partIndex?: number): ReasoningPreview {
  const [sample, setSample] = useState(() => running ? { text, partIndex, preview: selectPreview(text, true) } : undefined);
  const sampleLatest = useEffectEvent(() => {
    setSample((previous) => {
      if (!running) return undefined;
      const samePart = previous?.partIndex === partIndex ? previous : undefined;
      if (samePart?.text === text) return samePart;
      const shown = samePart?.preview;
      const next = selectPreview(text, true, shown);
      return { text, partIndex, preview: shown?.start === next.start && shown.text === next.text ? shown : next };
    });
  });
  useLayoutEffect(() => {
    sampleLatest();
    if (!running) return;
    const timer = setInterval(() => sampleLatest(), PREVIEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, partIndex]);

  const active = running && sample?.partIndex === partIndex ? sample?.preview : undefined;
  const immediateText = active ? "" : text;
  return useMemo(() => active ?? selectPreview(immediateText, running), [active, immediateText, running]);
}
