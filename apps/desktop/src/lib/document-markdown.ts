import { defaultUrlTransform, type UrlTransform } from "react-markdown";
import { parseMarkdownFileReference } from "./markdown-file-reference";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
}

function nodeText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(nodeText).join("") ?? "";
}

/** Add stable heading anchors for in-document links. */
export function remarkDocumentHeadings() {
  return (tree: MarkdownNode) => {
    const used = new Set<string>();
    const visit = (node: MarkdownNode) => {
      if (node.type === "heading") {
        const base = nodeText(node).toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-");
        let id = base;
        for (let index = 1; used.has(id); index++) id = `${base}-${index}`;
        used.add(id);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export const documentMarkdownUrlTransform: UrlTransform = (url, key) =>
  (key === "href" || key === "src") && parseMarkdownFileReference(url) ? url : defaultUrlTransform(url);
