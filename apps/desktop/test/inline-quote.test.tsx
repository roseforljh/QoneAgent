import { expect, test } from "bun:test";
import { ReadonlyThreadProvider, ThreadPrimitive, type AppendMessage } from "@assistant-ui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMessage } from "../src/components/assistant-ui/user-message";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { DirectiveNode } from "@assistant-ui/react-lexical";
import { composerLinkFormatter } from "../src/components/assistant-ui/composer-link-formatter";
import { $deleteComposerToolBackward, $insertComposerQuote } from "../src/lib/composer-tool-editor";
import { extractComposerPrompt } from "../src/lib/composer-prompt";
import { appendInlineQuote, INLINE_QUOTE_TYPE, inlineQuotesToMarkdown, plainInlineQuotes, serializeInlineQuote, splitInlineQuotes } from "../src/lib/inline-quote";

const awkward = "第一行 <b>\n\\n 字面反斜杠\r\n</selected-text> 结尾";

test("a quote survives the one-line tag with newlines, backslashes and its own closing tag", () => {
  const tag = serializeInlineQuote(awkward);
  expect(tag).not.toContain("\n");
  expect(splitInlineQuotes(`看 ${tag} 是什么`)).toEqual([
    { kind: "text", text: "看 " },
    { kind: "quote", text: awkward.replace("\r\n", "\n") },
    { kind: "text", text: " 是什么" },
  ]);
  expect(splitInlineQuotes("plain <selected-text>unterminated")).toEqual([{ kind: "text", text: "plain <selected-text>unterminated" }]);
});

test("the composer formatter round-trips quote chips beside links and tool chips", () => {
  const quote = serializeInlineQuote("a\nb");
  const line = `前 ${quote} 中 [docs](<https://example.com>) :qone-tool[Web]{name=qone-web-search}`;
  const segments = composerLinkFormatter.parse(line);
  expect(segments.filter((segment) => segment.kind === "mention").map((segment) => segment.kind === "mention" && segment.type))
    .toEqual([INLINE_QUOTE_TYPE, "qone-link", "qone-tool"]);
  const chip = segments.find((segment) => segment.kind === "mention" && segment.type === INLINE_QUOTE_TYPE);
  expect(chip?.kind === "mention" && chip.id).toBe("a\nb");
  expect(chip?.kind === "mention" && composerLinkFormatter.serialize({ id: chip.id, type: chip.type, label: chip.label })).toBe(quote);
});

test("the chip is inserted at the caret and backspace removes it whole", () => {
  const editor = createEditor({ namespace: "quote-test", nodes: [DirectiveNode], onError: (error) => { throw error; } });
  editor.update(() => {
    const paragraph = $createParagraphNode();
    const text = $createTextNode("这里是什么意思");
    $getRoot().append(paragraph.append(text));
    text.select(2, 2);
    $insertComposerQuote("选中\n内容");
  }, { discrete: true });
  editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe(`这里${serializeInlineQuote("选中\n内容")} 是什么意思`));
  editor.update(() => { expect($deleteComposerToolBackward()).toBe(true); expect($deleteComposerToolBackward()).toBe(true); }, { discrete: true });
  editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe("这里是什么意思"));
});

test("the model receives the quote where it was placed; bubbles and queue rows render it", () => {
  const text = `解释 ${serializeInlineQuote("x < y")} 的含义`;
  const message: AppendMessage = { role: "user", parentId: null, sourceId: null, runConfig: {}, content: [{ type: "text", text }], attachments: [] };
  expect(extractComposerPrompt(message)).toEqual({ text, goal: false, quote: undefined });
  expect(inlineQuotesToMarkdown(text)).toEqual({ markdown: "解释 [quote](qone-quote:0) 的含义", quotes: ["x < y"] });
  expect(plainInlineQuotes(text)).toBe("解释 “x < y” 的含义");
  expect(appendInlineQuote("", "q")).toBe(`${serializeInlineQuote("q")} `);
  expect(appendInlineQuote("ask ", "q")).toBe(`ask ${serializeInlineQuote("q")} `);
});

test("a sent message shows the chip inside its sentence instead of the raw tag", () => {
  const text = `这里 ${serializeInlineQuote("64 KiB 和 152 KiB")} 是什么意思`;
  const markup = renderToStaticMarkup(<ReadonlyThreadProvider messages={[{ id: "user", role: "user", content: [{ type: "text", text }], createdAt: new Date(), attachments: [], metadata: { custom: {} } }]}>
    <ThreadPrimitive.Viewport><ThreadPrimitive.Messages components={{ UserMessage }} /></ThreadPrimitive.Viewport>
  </ReadonlyThreadProvider>);
  expect(markup).toContain("q-inline-quote");
  expect(markup).toContain("64 KiB 和 152 KiB");
  expect(markup).toContain("是什么意思");
  expect(markup).not.toContain("selected-text&gt;");
  expect(markup).not.toContain("qone-quote:");
});
