import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createDirectiveNodeWithFormatter } from "@assistant-ui/react-lexical";
import {
  $addUpdateTag,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_NORMAL,
  HISTORY_PUSH_TAG,
  PASTE_COMMAND,
  TextNode,
  type LexicalEditor,
  type PasteCommandType,
} from "lexical";
import { ComposerLinkNode, $createComposerLinkNode, isComposerHttpUrl } from "./composer-link-node";
import { composerLinkDirectiveType, composerLinkFormatter } from "./composer-link-formatter";

function clipboardHasFiles(event: PasteCommandType): boolean {
  if (!("clipboardData" in event) || !event.clipboardData) return false;
  return !!event.clipboardData.files?.length || Array.from(event.clipboardData.items ?? []).some((item) => item.kind === "file");
}

export function pastedHttpUrl(event: PasteCommandType): string | null {
  if (!("clipboardData" in event) || !event.clipboardData || clipboardHasFiles(event)) return null;
  const value = event.clipboardData.getData("text/plain").trim();
  if (!value) return null;
  return isComposerHttpUrl(value) ? value : null;
}

/** Codex jmr: a single named anchor with no other text or embedded media. */
export function pastedHtmlLink(event: PasteCommandType): { text: string; href: string } | null {
  if (!("clipboardData" in event) || !event.clipboardData || clipboardHasFiles(event)) return null;
  const html = event.clipboardData.getData("text/html");
  if (!html || typeof DOMParser === "undefined") return null;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const anchors = body.querySelectorAll("a[href]");
  if (anchors.length !== 1 || body.querySelector("img, svg, video, audio, canvas, iframe, object, embed, input, textarea, select, button")) return null;
  const anchor = anchors[0]!;
  const href = anchor.getAttribute("href");
  const text = anchor.textContent?.trim();
  anchor.remove();
  return href && text && !text.includes("\n") && !body.textContent?.trim() && isComposerHttpUrl(href) ? { text, href } : null;
}

/** Match complete whitespace-delimited URLs; URL validation rejects embedded whitespace. */
export function composerUrlMatch(text: string): { start: number; end: number } | null {
  for (const match of text.matchAll(/(?:^|\s)(https?:\/\/[^\s<>]+)/giu)) {
    const href = match[1]!;
    if (isComposerHttpUrl(href)) {
      const start = match.index! + match[0].length - href.length;
      return { start, end: start + href.length };
    }
  }
  return null;
}

/** Keep literal URLs editable; named links use assistant-ui's lossless directive stream. */
export function ComposerLinkPastePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => registerComposerLinkPaste(editor), [editor]);

  return null;
}

export function registerComposerLinkPaste(editor: LexicalEditor): () => void {
  const unregisterTransform = editor.registerNodeTransform(ComposerLinkNode, (node) => {
    // Upgrade the previous implementation's titled nodes before syncing them to plain text.
    if (!node.isAutoLink()) {
      node.replace($createDirectiveNodeWithFormatter({ type: composerLinkDirectiveType, id: node.getHref(), label: node.getTextContent() }, composerLinkFormatter));
      return;
    }
    const text = node.getTextContent();
    if (isComposerHttpUrl(text)) {
      if (node.getHref() !== text) node.setHref(text);
      return;
    }
    const match = composerUrlMatch(text);
    if (match?.start === 0) node.splitText(match.end);
    else node.replace($createTextNode(text).setFormat(node.getFormat()).setDetail(node.getDetail()).setStyle(node.getStyle()));
  });
  // Unlike generic text entities, a pasted link has an explicit boundary. Never
  // combine it with adjacent prose to infer a different URL.
  const unregisterText = editor.registerNodeTransform(TextNode, (node) => {
    if (!node.isSimpleText()) return;
    const match = composerUrlMatch(node.getTextContent());
    if (!match) return;
    const parts = node.splitText(match.start, match.end);
    const matched = parts[match.start === 0 ? 0 : 1];
    if (!matched) return;
    matched.replace($createComposerLinkNode(matched.getTextContent())
      .setFormat(matched.getFormat()).setDetail(matched.getDetail()).setStyle(matched.getStyle()));
  });
  const unregisterPaste = editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      const href = pastedHttpUrl(event);
      const htmlLink = href ? null : pastedHtmlLink(event);
      if (!href && !htmlLink) return false;

      // Commands already run inside Lexical's current update. Reading the committed
      // editorState here would use a stale selection when commands are batched.
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      if (!selection.isCollapsed() && selection.getTextContent().includes("\n")) return false;

      event.preventDefault();
      $addUpdateTag(HISTORY_PUSH_TAG);
      const target = href ?? htmlLink!.href;
      const text = !selection.isCollapsed() && href ? selection.getTextContent() : htmlLink?.text ?? target;
      selection.insertNodes([text === target ? $createComposerLinkNode(target) :
        $createDirectiveNodeWithFormatter({ type: composerLinkDirectiveType, id: target, label: text }, composerLinkFormatter)]);
      return true;
    },
    COMMAND_PRIORITY_NORMAL,
  );
  return () => {
    unregisterTransform();
    unregisterPaste();
    unregisterText();
  };
}
