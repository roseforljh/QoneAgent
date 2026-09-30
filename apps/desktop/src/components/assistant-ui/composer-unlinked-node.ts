import { $applyNodeReplacement, TextNode, type NodeKey, type SerializedTextNode } from "lexical";

/** Explicitly removed links stay editable without immediately re-autolinking. */
export class ComposerUnlinkedNode extends TextNode {
  static override getType() { return "qone-composer-unlinked"; }
  static override clone(node: ComposerUnlinkedNode) { return new ComposerUnlinkedNode(node.__text, node.__key); }
  constructor(text: string, key?: NodeKey) { super(text, key); }
  static override importJSON(node: SerializedTextNode) {
    return $applyNodeReplacement(new ComposerUnlinkedNode(node.text)).updateFromJSON(node);
  }
  override exportJSON(): SerializedTextNode { return { ...super.exportJSON(), type: ComposerUnlinkedNode.getType() }; }
}

export function $createComposerUnlinkedNode(text: string) {
  return $applyNodeReplacement(new ComposerUnlinkedNode(text));
}
