import { $getNodeByKey, $createTextNode, $isTextNode, type LexicalNode, type NodeKey } from "lexical";
import { $isDirectiveNode, $createDirectiveNodeWithFormatter } from "@assistant-ui/react-lexical";
import { $createComposerLinkNode, $isComposerLinkNode, isComposerHttpUrl, isComposerLinkHref } from "./composer-link-node";
import { composerLinkDirectiveType, composerLinkFormatter } from "./composer-link-formatter";
import { $createComposerUnlinkedNode } from "./composer-unlinked-node";

export function $composerLinkInfo(node: LexicalNode | null) {
  if ($isComposerLinkNode(node)) return { key: node.getKey(), text: node.getTextContent(), href: node.getHref() };
  if ($isDirectiveNode(node)) {
    const item = node.getDirectiveItem();
    if (item.type === composerLinkDirectiveType) return { key: node.getKey(), text: item.label, href: item.id };
  }
  return null;
}

export function $editComposerLink(key: NodeKey, text: string, href: string | null): boolean {
  const node = $getNodeByKey(key);
  if (!node || !$composerLinkInfo(node) || !text || (href !== null && !isComposerLinkHref(href))) return false;
  const replacement = href === null
    ? isComposerHttpUrl(text) ? $createComposerUnlinkedNode(text) : $createTextNode(text)
    : text === href && isComposerHttpUrl(href) ? $createComposerLinkNode(href)
      : $createDirectiveNodeWithFormatter({ type: composerLinkDirectiveType, id: href, label: text }, composerLinkFormatter);
  if ($isTextNode(node) && $isTextNode(replacement)) replacement.setFormat(node.getFormat()).setStyle(node.getStyle());
  node.replace(replacement);
  if ($isTextNode(replacement)) replacement.selectEnd();
  return true;
}
