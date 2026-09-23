import {
  $createTextNode, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode,
} from "lexical";
import { $createDirectiveNode, $isDirectiveNode } from "@assistant-ui/react-lexical";

export type ComposerToolId = "attachment" | "skills" | "mcp" | "web-search";

export function $insertComposerTool(tool: { id: ComposerToolId; label: string }) {
  const selection = $getSelection() ?? $getRoot().selectEnd();
  const directive = $createDirectiveNode({ id: "qone-" + tool.id, type: "qone-tool", label: tool.label });
  selection.insertNodes([directive]);
  const next = directive.getNextSibling();
  if ($isTextNode(next)) {
    if (!next.getTextContent().startsWith(" ")) next.spliceText(0, 0, " ");
    next.select(1, 1);
  } else {
    const spacer = $createTextNode(" ");
    directive.insertAfter(spacer);
    spacer.select(1, 1);
  }
}

// Handle only the chip boundary. Leave ordinary text, ranges, and IME to Lexical.
export function $deleteComposerToolBackward(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  const { anchor } = selection;
  const node = anchor.getNode();
  const previous = $isTextNode(node)
    ? node.getPreviousSibling()
    : $isElementNode(node) ? node.getChildAtIndex(anchor.offset - 1) : null;
  if (!$isDirectiveNode(previous) || previous.getDirectiveItem().type !== "qone-tool") return false;
  if ($isTextNode(node) && anchor.offset === 1 && node.getTextContent().startsWith(" ")) {
    node.spliceText(0, 1, "");
    node.select(0, 0);
    return true;
  }
  if ($isElementNode(node) || ($isTextNode(node) && anchor.offset === 0)) {
    previous.remove();
    return true;
  }
  return false;
}
