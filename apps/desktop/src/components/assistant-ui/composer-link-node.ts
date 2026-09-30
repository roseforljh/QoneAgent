import type { EditorConfig, LexicalEditor, NodeKey, SerializedTextNode, Spread } from "lexical";
import { $applyNodeReplacement, TextNode } from "lexical";
import { applyComposerLinkAppearance } from "./composer-link-appearance";

export type SerializedComposerLinkNode = Spread<{ href: string; isAutoLink: boolean }, SerializedTextNode>;

export function isComposerHttpUrl(value: string): boolean {
  if (!value || /\s/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Codex kI additionally accepts mailto destinations in the link editor. */
export function isComposerLinkHref(value: string): boolean {
  if (isComposerHttpUrl(value)) return true;
  try { return new URL(value).protocol === "mailto:"; } catch { return false; }
}

/** Editable URL text that keeps the pasted address in the Lexical plain-text stream. */
export class ComposerLinkNode extends TextNode {
  __href: string;
  __isAutoLink: boolean;

  static override getType(): string {
    return "qone-composer-link";
  }

  static override clone(node: ComposerLinkNode): ComposerLinkNode {
    return new ComposerLinkNode(node.__text, node.__href, node.__key, node.__isAutoLink);
  }

  constructor(text: string, href: string, key?: NodeKey, isAutoLink = text === href) {
    super(text, key);
    this.__href = href;
    this.__isAutoLink = isAutoLink;
  }

  getHref(): string {
    return this.getLatest().__href;
  }

  isAutoLink(): boolean {
    return this.getLatest().__isAutoLink;
  }

  setHref(href: string): this {
    this.getWritable().__href = href;
    return this;
  }

  static override importJSON(serialized: SerializedComposerLinkNode): ComposerLinkNode {
    return $createComposerLinkNode(serialized.text, serialized.href, serialized.isAutoLink)
      .setFormat(serialized.format)
      .setDetail(serialized.detail)
      .setMode(serialized.mode)
      .setStyle(serialized.style);
  }

  override exportJSON(): SerializedComposerLinkNode {
    return { ...super.exportJSON(), type: "qone-composer-link", href: this.__href, isAutoLink: this.__isAutoLink };
  }

  override createDOM(config: EditorConfig, editor?: LexicalEditor): HTMLElement {
    const dom = super.createDOM(config, editor);
    dom.classList.add("q-composer-link");
    dom.setAttribute("data-breakable-url", "");
    applyComposerLinkAppearance(dom, this.__href);
    return dom;
  }

  override updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const replace = super.updateDOM(prevNode, dom, config);
    if (prevNode.__href !== this.__href) {
      applyComposerLinkAppearance(dom, this.__href);
    }
    return replace;
  }

  override isTextEntity(): boolean {
    return true;
  }
}

export function $createComposerLinkNode(text: string, href = text, isAutoLink = text === href): ComposerLinkNode {
  return $applyNodeReplacement(new ComposerLinkNode(text, href, undefined, isAutoLink));
}

export function $isComposerLinkNode(node: unknown): node is ComposerLinkNode {
  return node instanceof ComposerLinkNode;
}
