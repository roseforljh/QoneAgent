import {
  $createTextNode, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode,
} from "lexical";
import { $createDirectiveNode, $isDirectiveNode } from "@assistant-ui/react-lexical";

export type ComposerToolId = "attachment" | "skills" | "mcp" | "web-search" | "goal";
export type ComposerCommand = { kind: "skill"; name: string } | { kind: "mcp"; serverId: string };

function $selectAfterDirective(directive: ReturnType<typeof $createDirectiveNode>) {
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

export function $insertComposerCommand(command: ComposerCommand) {
  // Only one leading runtime command can be applied to a message. Replacing a
  // previous selection also removes the space that belonged to its chip.
  const firstParagraph = $getRoot().getFirstChild();
  if ($isElementNode(firstParagraph)) {
    for (const child of firstParagraph.getChildren()) {
      if (!$isDirectiveNode(child) || child.getDirectiveItem().type !== "qone-command") continue;
      const next = child.getNextSibling();
      if ($isTextNode(next) && next.getTextContent().startsWith(" ")) next.spliceText(0, 1, "");
      child.remove();
    }
  }
  const id = command.kind === "skill" ? `skill:${command.name}` : `mcp:${encodeURIComponent(command.serverId)}`;
  const directive = $createDirectiveNode({ id, type: "qone-command", label: id });
  $getRoot().selectStart().insertNodes([directive]);
  $selectAfterDirective(directive);
}

export function $insertComposerTool(tool: { id: ComposerToolId; label: string }) {
  const selection = $getSelection() ?? $getRoot().selectEnd();
  const directive = $createDirectiveNode({ id: "qone-" + tool.id, type: "qone-tool", label: tool.label });
  selection.insertNodes([directive]);
  $selectAfterDirective(directive);
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
  if (!$isDirectiveNode(previous) || !["qone-tool", "qone-command"].includes(previous.getDirectiveItem().type)) return false;
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
