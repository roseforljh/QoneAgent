import { expect, test } from "bun:test";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, PASTE_COMMAND, createEditor, COMMAND_PRIORITY_HIGH, UNDO_COMMAND, REDO_COMMAND } from "lexical";
import type { PasteCommandType } from "lexical";
import { $createDirectiveNodeWithFormatter, $isDirectiveNode, DirectiveNode } from "@assistant-ui/react-lexical";
import { composerLinkDirectiveType, composerLinkFormatter } from "../src/components/assistant-ui/composer-link-formatter";
import { applyComposerLinkAppearance, composerLinkAppearance } from "../src/components/assistant-ui/composer-link-appearance";
import { $composerLinkInfo, $editComposerLink } from "../src/components/assistant-ui/composer-link-editor";
import { ComposerUnlinkedNode } from "../src/components/assistant-ui/composer-unlinked-node";
import {
  $createComposerLinkNode,
  ComposerLinkNode,
  isComposerHttpUrl,
} from "../src/components/assistant-ui/composer-link-node";
import { pastedHttpUrl, registerComposerLinkPaste } from "../src/components/assistant-ui/composer-link-paste";

function pasteEvent(text: string): PasteCommandType {
  return {
    clipboardData: { getData: (type: string) => type === "text/plain" ? text : "" },
    preventDefault() {},
  } as unknown as PasteCommandType;
}

test("directly pasted HTTP URLs are recognized, other text is left alone", () => {
  expect(isComposerHttpUrl("https://example.com/a?q=1")).toBe(true);
  expect(isComposerHttpUrl("http://localhost:3000")).toBe(true);
  expect(isComposerHttpUrl("javascript:alert(1)")).toBe(false);
  expect(isComposerHttpUrl("https://example.com/path with spaces")).toBe(false);
  expect(isComposerHttpUrl("https://example.com/\nnext")).toBe(false);
  expect(pastedHttpUrl(pasteEvent("  https://example.com/a?q=1  "))).toBe("https://example.com/a?q=1");
  expect(pastedHttpUrl(pasteEvent("看 https://example.com/a"))).toBeNull();
});

test("paste command inserts a URL node at the current caret and prevents browser insertion", () => {
  const editor = createEditor({ namespace: "composer-link-paste-test", nodes: [ComposerLinkNode], onError: (error) => { throw error; } });
  editor.update(() => {
    const paragraph = $createParagraphNode();
    $getRoot().append(paragraph);
    paragraph.selectEnd();
  }, { discrete: true });
  const unregister = registerComposerLinkPaste(editor);
  let prevented = false;
  const event = pasteEvent("https://example.com/from-clipboard");
  event.preventDefault = () => { prevented = true; };
  expect(editor.dispatchCommand(PASTE_COMMAND, event)).toBe(true);
  editor.update(() => {}, { discrete: true });
  unregister();
  editor.getEditorState().read(() => {
    const node = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow();
    expect(node.getType()).toBe("qone-composer-link");
    expect(node.getTextContent()).toBe("https://example.com/from-clipboard");
    expect($isRangeSelection($getSelection())).toBe(true);
  });
  expect(prevented).toBe(true);
});

test("literal and titled links preserve their URLs in the runtime stream and JSON", () => {
  const editor = createEditor({
    namespace: "composer-link-test",
    nodes: [ComposerLinkNode, DirectiveNode],
    onError: (error) => { throw error; },
  });
  editor.update(() => {
    const paragraph = $createParagraphNode();
    paragraph.append($createComposerLinkNode("https://example.com/a?q=1"));
    paragraph.append($createDirectiveNodeWithFormatter({ type: composerLinkDirectiveType, label: "Docs", id: "https://example.com/docs" }, composerLinkFormatter));
    $getRoot().append(paragraph);
  }, { discrete: true });

  editor.getEditorState().read(() => {
    const node = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow();
    expect(node.getTextContent()).toBe("https://example.com/a?q=1");
    expect(node.getType()).toBe("qone-composer-link");
    expect(node.getNextSibling()?.getTextContent()).toBe("[Docs](<https://example.com/docs>)");
  });

  const restored = editor.parseEditorState(editor.getEditorState().toJSON());
  editor.setEditorState(restored);
  editor.getEditorState().read(() => {
    const node = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow();
    expect(node.getType()).toBe("qone-composer-link");
    expect(node.getTextContent()).toBe("https://example.com/a?q=1");
    expect(node.getNextSibling()?.getTextContent()).toBe("[Docs](<https://example.com/docs>)");
  });
});

function setup(text = "") {
  const editor = createEditor({ namespace: "link-behavior-test", nodes: [ComposerLinkNode, ComposerUnlinkedNode, DirectiveNode], onError: (error) => { throw error; } });
  registerComposerLinkPaste(editor);
  editor.update(() => {
    const paragraph = $createParagraphNode();
    if (text) paragraph.append($createTextNode(text));
    $getRoot().append(paragraph);
    paragraph.selectEnd();
  }, { discrete: true });
  return editor;
}

test("pending selected text becomes a named link without losing the destination", () => {
  const editor = setup("before Docs after");
  editor.update(() => {
    $getRoot().getFirstChildOrThrow().getFirstChildOrThrow().select(7, 11);
    expect(editor.dispatchCommand(PASTE_COMMAND, pasteEvent("https://github.com/"))).toBe(true);
  }, { discrete: true });
  editor.getEditorState().read(() => {
    expect($getRoot().getTextContent()).toBe("before [Docs](<https://github.com/>) after");
    const node = $getRoot().getFirstChildOrThrow().getChildren()[1];
    expect($isDirectiveNode(node) && node.getDirectiveItem().label).toBe("Docs");
  });
});

test("clipboard files and higher-priority long-paste handlers keep ownership", () => {
  const editor = setup();
  const event = pasteEvent("https://github.com/");
  Object.assign(event.clipboardData!, { items: [{ kind: "file" }] });
  expect(pastedHttpUrl(event)).toBeNull();
  expect(editor.dispatchCommand(PASTE_COMMAND, event)).toBe(false);
  let handled = false;
  editor.registerCommand(PASTE_COMMAND, () => { handled = true; return true; }, COMMAND_PRIORITY_HIGH);
  editor.dispatchCommand(PASTE_COMMAND, pasteEvent("https://github.com/"));
  editor.update(() => {}, { discrete: true });
  expect(handled).toBe(true);
  editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe(""));
});

test("plain-text drafts and typed URLs recover styling while retaining editable text", () => {
  const editor = setup("see https://github.com/ then https://example.com/a?q=1");
  editor.getEditorState().read(() => {
    const children = $getRoot().getFirstChildOrThrow().getChildren();
    expect(children.map((node) => node.getType())).toEqual(["text", "qone-composer-link", "text", "qone-composer-link"]);
    expect($getRoot().getTextContent()).toBe("see https://github.com/ then https://example.com/a?q=1");
  });
});

test("URL edits refresh destination, split trailing prose and unwrap invalid URLs", () => {
  const editor = setup("https://github.com/");
  editor.update(() => {
    $getRoot().getFirstChildOrThrow().getFirstChildOrThrow().setTextContent("https://example.com/path");
  }, { discrete: true });
  editor.getEditorState().read(() => {
    const node = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow() as ComposerLinkNode;
    expect(node.getHref()).toBe("https://example.com/path");
    expect(composerLinkAppearance(node.getHref()).sourceAppId).toBe("");
  });
  editor.update(() => {
    $getRoot().getFirstChildOrThrow().getFirstChildOrThrow().setTextContent("https://example.com/path next");
  }, { discrete: true });
  editor.getEditorState().read(() => {
    const node = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow() as ComposerLinkNode;
    expect(node.getType()).toBe("qone-composer-link");
    expect(node.getTextContent()).toBe("https://example.com/path");
    expect(node.getNextSibling()?.getTextContent()).toBe(" next");
  });
  editor.update(() => {
    $getRoot().getFirstChildOrThrow().getFirstChildOrThrow().setTextContent("https://");
  }, { discrete: true });
  editor.getEditorState().read(() => expect($getRoot().getFirstChildOrThrow().getFirstChildOrThrow().getType()).toBe("text"));
});

test("Markdown formatter restores labels/URLs and existing tool directives together", () => {
  const label = "文档 [v2] *test* `code` \\ / 中文";
  const item = { type: composerLinkDirectiveType, label, id: "https://github.com/a/b?q=1&foo=(bar)#section" };
  const markdown = composerLinkFormatter.serialize(item);
  expect(composerLinkFormatter.parse(markdown)).toEqual([{ kind: "mention", ...item }]);
  const segments = composerLinkFormatter.parse(`:qone-command[skill:test]{name=skill:test} ${markdown} tail`);
  expect(segments.filter((segment) => segment.kind === "mention").map((segment) => segment.type)).toEqual(["qone-command", composerLinkDirectiveType]);
  expect(composerLinkFormatter.parse("`[code](https://github.com/)`")).toEqual([{ kind: "text", text: "`[code](https://github.com/)`" }]);
  expect(composerLinkFormatter.parse("![image](https://github.com/image.png)")).toEqual([{ kind: "text", text: "![image](https://github.com/image.png)" }]);
});

test("domain matching uses Codex's registry and cannot mistake lookalike hosts for GitHub", () => {
  expect(composerLinkAppearance("https://github.com/").src).toContain("composer-github-26-928.svg");
  expect(composerLinkAppearance("https://www.github.com/").sourceAppId).toBe("github");
  expect(composerLinkAppearance("https://github.com.evil.example/").sourceAppId).toBe("");
  expect(composerLinkAppearance("https://notgithub.com/").sourceAppId).toBe("");
  expect(composerLinkAppearance("https://figma.com/file/abc").multicolor).toBe(true);
  expect(composerLinkAppearance("https://docs.google.com/").sourceAppId).toBe("google-drive");
  expect(composerLinkAppearance("https://box.com/").sourceAppId).toBe("box");
  expect(composerLinkAppearance("https://box.com/").src).toContain("box-color-logo-light-20.svg");
  expect(composerLinkAppearance("https://tenant.sharepoint.com/").src).toContain("composer-globe-26-928.svg");
});

test("DOM appearance is recomputed on a host change, including multicolor reset", () => {
  const attributes = new Map<string, string>();
  const styles = new Map<string, string>();
  const dom = { setAttribute: (key: string, value: string) => attributes.set(key, value), style: { setProperty: (key: string, value: string) => styles.set(key, value) }, title: "" } as unknown as HTMLElement;
  applyComposerLinkAppearance(dom, "https://figma.com/");
  expect(attributes.get("data-link-multicolor")).toBe("true");
  applyComposerLinkAppearance(dom, "https://github.com/");
  expect(attributes.get("data-link-multicolor")).toBe("false");
  expect(attributes.get("rich-link-source-app-id")).toBe("github");
  expect(styles.get("--q-composer-link-icon")).toContain("composer-github-26-928.svg");
  expect(dom.title).toBe("https://github.com/");
});

test("link options edit text/destination and reject invalid URLs without losing data", () => {
  const editor = setup("https://github.com/");
  editor.update(() => {
    const key = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow().getKey();
    expect($editComposerLink(key, "项目文档", "https://github.com/")).toBe(true);
  }, { discrete: true });
  editor.getEditorState().read(() => {
    const node = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow();
    expect($composerLinkInfo(node)?.text).toBe("项目文档");
    expect(node.getTextContent()).toBe("[项目文档](<https://github.com/>)");
  });
  editor.update(() => {
    const key = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow().getKey();
    expect($editComposerLink(key, "项目文档", "javascript:alert(1)")).toBe(false);
    expect($editComposerLink(key, "项目文档", "https://figma.com/project")).toBe(true);
  }, { discrete: true });
  editor.update(() => {
    const node = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow();
    expect($composerLinkInfo(node)?.href).toBe("https://figma.com/project");
    expect($editComposerLink(node.getKey(), "项目文档", null)).toBe(true);
  }, { discrete: true });
  editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe("项目文档"));
});

test("removing a literal URL leaves editable plain text without instantly re-linking it", () => {
  const editor = setup("https://github.com/");
  editor.update(() => {
    const node = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow();
    expect($editComposerLink(node.getKey(), node.getTextContent(), null)).toBe(true);
  }, { discrete: true });
  editor.getEditorState().read(() => {
    const node = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow();
    expect(node.getType()).toBe("qone-composer-unlinked");
    expect(node.getTextContent()).toBe("https://github.com/");
  });
  editor.update(() => $getSelection()!.insertText("draft"), { discrete: true });
  editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe("https://github.com/draft"));
  editor.setEditorState(editor.parseEditorState(editor.getEditorState().toJSON()));
  editor.getEditorState().read(() => expect($getRoot().getFirstChildOrThrow().getFirstChildOrThrow().getType()).toBe("qone-composer-unlinked"));
});

test("mailto edits serialize and restore through the same link formatter", () => {
  const editor = setup("https://github.com/");
  editor.update(() => {
    const node = $getRoot().getFirstChildOrThrow().getFirstChildOrThrow();
    expect($editComposerLink(node.getKey(), "联系作者", "mailto:author@example.com")).toBe(true);
  }, { discrete: true });
  editor.getEditorState().read(() => {
    expect(composerLinkFormatter.parse($getRoot().getTextContent())).toEqual([{ kind: "mention", type: composerLinkDirectiveType, label: "联系作者", id: "mailto:author@example.com" }]);
  });
});

test("pasting into adjacent prose preserves the pasted URL boundaries", () => {
  const editor = setup("beforeafter");
  editor.update(() => {
    $getRoot().getFirstChildOrThrow().getFirstChildOrThrow().select(6, 6);
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent("https://github.com/"));
  }, { discrete: true });
  editor.getEditorState().read(() => {
    const children = $getRoot().getFirstChildOrThrow().getChildren();
    expect(children.map((node) => node.getTextContent())).toEqual(["before", "https://github.com/", "after"]);
    expect(children[1]?.getType()).toBe("qone-composer-link");
    expect($composerLinkInfo(children[1]!)?.href).toBe("https://github.com/");
  });
});

test("paste remains one undo step and redo restores the URL", async () => {
  // Resolve the public history API already supplied by the installed React plugin.
  const historyModule = Bun.resolveSync("@lexical/history", Bun.resolveSync("@lexical/react/LexicalHistoryPlugin", import.meta.dir));
  const { registerHistory, createEmptyHistoryState } = await import(historyModule);
  const editor = createEditor({ namespace: "link-history", nodes: [ComposerLinkNode, DirectiveNode], onError: (error) => { throw error; } });
  const removeHistory = registerHistory(editor, createEmptyHistoryState(), 300);
  registerComposerLinkPaste(editor);
  editor.update(() => {
    const paragraph = $createParagraphNode();
    $getRoot().append(paragraph);
    paragraph.selectEnd();
  }, { discrete: true });
  editor.update(() => editor.dispatchCommand(PASTE_COMMAND, pasteEvent("https://github.com/")), { discrete: true });
  editor.dispatchCommand(UNDO_COMMAND, undefined);
  editor.update(() => {}, { discrete: true });
  editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe(""));
  editor.dispatchCommand(REDO_COMMAND, undefined);
  editor.update(() => {}, { discrete: true });
  editor.getEditorState().read(() => {
    expect($getRoot().getTextContent()).toBe("https://github.com/");
    expect($getRoot().getFirstChildOrThrow().getFirstChildOrThrow().getType()).toBe("qone-composer-link");
  });
  removeHistory();
});
