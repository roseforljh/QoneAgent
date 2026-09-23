import { expect, test } from "bun:test";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, createEditor } from "lexical";
import { DirectiveNode } from "@assistant-ui/react-lexical";
import { $deleteComposerToolBackward, $insertComposerTool, type ComposerToolId } from "../src/lib/composer-tool-editor";

function setup(text = "", offset = text.length) {
  const editor = createEditor({ namespace: "tools-test", nodes: [DirectiveNode], onError: (error) => { throw error; } });
  editor.update(() => {
    const paragraph = $createParagraphNode();
    $getRoot().append(paragraph);
    if (text) { const node = $createTextNode(text); paragraph.append(node); node.select(offset, offset); }
    else paragraph.selectEnd();
  }, { discrete: true });
  return editor;
}

test("each tool inserts an atomic chip followed by one real space", () => {
  for (const id of ["attachment", "skills", "mcp", "web-search"] as ComposerToolId[]) {
    const editor = setup();
    editor.update(() => $insertComposerTool({ id, label: "Label" }), { discrete: true });
    editor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      expect(paragraph.getTextContent()).toBe(":qone-tool[Label]{name=qone-" + id + "} ");
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.offset).toBe(1);
      expect($isRangeSelection(selection) && selection.anchor.getNode().getTextContent()).toBe(" ");
    });
  }
});

test("two backspaces remove space then chip, leaving other content alone", () => {
  const editor = setup("before ");
  editor.update(() => $insertComposerTool({ id: "skills", label: "技能" }), { discrete: true });
  editor.update(() => expect($deleteComposerToolBackward()).toBe(true), { discrete: true });
  editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe("before :qone-tool[技能]{name=qone-skills}"));
  editor.update(() => expect($deleteComposerToolBackward()).toBe(true), { discrete: true });
  editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe("before "));
});

test("typing follows the space and normal text deletion stays with Lexical", () => {
  const editor = setup();
  editor.update(() => {
    $insertComposerTool({ id: "web-search", label: "联网搜索" });
    $getSelection()!.insertText("你好 hello");
    expect($deleteComposerToolBackward()).toBe(false);
  }, { discrete: true });
  editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe(":qone-tool[联网搜索]{name=qone-web-search} 你好 hello"));
});

test("insertion at a text cursor preserves surrounding text and reuses an existing space", () => {
  for (const text of ["before after", "beforeafter"]) {
    const editor = setup(text, 6);
    editor.update(() => $insertComposerTool({ id: "mcp", label: "MCP" }), { discrete: true });
    editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe("before:qone-tool[MCP]{name=qone-mcp} after"));
  }
});

test("multiple chips and JSON roundtrip retain independent nodes and spacing", () => {
  const editor = setup();
  editor.update(() => {
    $insertComposerTool({ id: "attachment", label: "附件" });
    $insertComposerTool({ id: "skills", label: "技能" });
  }, { discrete: true });
  const serialized = editor.getEditorState().toJSON();
  const restored = setup();
  restored.setEditorState(restored.parseEditorState(serialized));
  restored.getEditorState().read(() => expect($getRoot().getTextContent()).toBe(":qone-tool[附件]{name=qone-attachment} :qone-tool[技能]{name=qone-skills} "));
});

test("replacing a selected range preserves the remaining suffix", () => {
  const editor = setup("abc xyz");
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) throw new Error("missing selection");
    selection.anchor.offset = 0;
    selection.focus.offset = 3;
    expect($deleteComposerToolBackward()).toBe(false);
    $insertComposerTool({ id: "skills", label: "Skills" });
  }, { discrete: true });
  editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe(":qone-tool[Skills]{name=qone-skills} xyz"));
});
