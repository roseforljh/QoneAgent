import { fromMarkdown } from "mdast-util-from-markdown";
import { unstable_defaultDirectiveFormatter, type Unstable_DirectiveFormatter, type Unstable_DirectiveSegment } from "@assistant-ui/core";
import type { Nodes } from "mdast";
import { isComposerLinkHref } from "./composer-link-node";

export const composerLinkDirectiveType = "qone-link";

function labelText(node: Nodes): string | null {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "emphasis" || node.type === "strong") {
    const parts = node.children.map(labelText);
    return parts.some((part) => part === null) ? null : parts.join("");
  }
  return null;
}

/** Standard Markdown preserves both label and URL in assistant-ui's runtime/drafts. */
export const composerLinkFormatter: Unstable_DirectiveFormatter = {
  serialize(item) {
    if (item.type !== composerLinkDirectiveType) return unstable_defaultDirectiveFormatter.serialize(item);
    const label = item.label.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&");
    const href = item.id.replace(/[<>\\\s]/gu, (character) => encodeURIComponent(character));
    return `[${label}](<${href}>)`;
  },
  parse(text) {
    // Most keystrokes/plain URLs do not need a Markdown parse.
    if (!text.includes("](")) return unstable_defaultDirectiveFormatter.parse(text);
    const segments: Unstable_DirectiveSegment[] = [];
    let offset = 0;
    for (const block of fromMarkdown(text).children) {
      if (block.type !== "paragraph") continue;
      for (const node of block.children) {
        if (node.type !== "link" || !isComposerLinkHref(node.url)) continue;
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const parts = node.children.map(labelText);
        if (start === undefined || end === undefined || parts.some((part) => part === null) || text.slice(start, end).includes("\n")) continue;
        const label = parts.join("");
        if (!label) continue;
        segments.push(...unstable_defaultDirectiveFormatter.parse(text.slice(offset, start)));
        segments.push({ kind: "mention", type: composerLinkDirectiveType, id: node.url, label });
        offset = end;
      }
    }
    segments.push(...unstable_defaultDirectiveFormatter.parse(text.slice(offset)));
    return segments;
  },
};
