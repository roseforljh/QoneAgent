import { expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeRunner } from "../src/components/assistant-ui/elements/code-runner";
import { ComposerContext } from "../src/components/assistant-ui/elements/composer";
import { InlineCitation } from "../src/components/assistant-ui/elements/inline-citation";
import { MathBlock } from "../src/components/assistant-ui/elements/math-block";
import { MemoryChips } from "../src/components/assistant-ui/elements/memory-chips";
import { ToolError } from "../src/components/assistant-ui/elements/tool-error";
import { File } from "../src/components/assistant-ui/elements/file";
import { Image } from "../src/components/assistant-ui/elements/image";
import { Sources } from "../src/components/assistant-ui/elements/sources";
import { GenerativeUIBlock, GenerativeUISurface } from "../src/components/assistant-ui/generative-ui-block";

test("official assistant elements render their real data slots", () => {
  const render = (element: ReactElement) => renderToStaticMarkup(element);
  expect(render(createElement(ToolError, { name: "read", target: "a.ts", message: "failed", retrying: false }))).toContain('data-slot="tool-error"');
  expect(render(createElement(CodeRunner, { language: "PowerShell", code: "Get-ChildItem", state: "ok", output: ["a.ts"] }))).toContain('data-slot="code-runner"');
  expect(render(createElement(InlineCitation, { sources: [{ domain: "example.com", url: "https://example.com", label: "1" }], openIndex: null, onOpenIndexChange: () => {} }))).toContain('data-slot="inline-citation"');
  expect(render(createElement(MathBlock, { steps: [{ expression: "x = 1" }], visibleSteps: 1 }))).toContain('data-slot="math-block"');
  expect(render(createElement(MemoryChips, { chips: [{ id: "memory-1", text: "昵称: Qone", change: "existing" }] }))).toContain('data-slot="memory-chips"');
  expect(render(createElement(ComposerContext, { usage: { tools: 1, messages: 2, total: 128 } }))).toContain('data-slot="composer-context"');
  expect(render(createElement(File, { type: "file", data: "data:text/plain;base64,aGk=", mimeType: "text/plain", filename: "notes.txt" } as never))).toContain('data-slot="file-download"');
  expect(render(createElement(Image, { type: "image", image: "data:image/png;base64,aGk=", filename: "plot.png" } as never))).toContain('data-slot="image-preview"');
  expect(render(createElement(Sources, { sources: [{ domain: "example.com", title: "Docs", url: "https://example.com" }], open: true, onOpenChange: () => {} }))).toContain('data-slot="sources"');
  expect(render(createElement(GenerativeUIBlock, { code: '{"$type":"Text","children":"result"}', language: "generative-ui" } as never))).toContain('data-slot="generative-ui-block"');
  expect(render(createElement(GenerativeUISurface, { spec: { $type: "Card", title: "Summary", children: [{ $type: "Text", children: "Ready" }] } }))).toContain("Ready");
});
