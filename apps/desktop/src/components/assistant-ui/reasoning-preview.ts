import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

function plainText(node: Nodes): string {
  if (node.type === "html") return "";
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

/** Only parse the latest nonempty line; the full transcript is rendered on demand. */
export function latestReasoningText(text: string): string {
  const trimmed = text.trimEnd();
  const latest = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  return plainText(fromMarkdown(latest)).trim() || latest;
}
