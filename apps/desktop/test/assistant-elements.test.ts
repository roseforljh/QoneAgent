import { expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeRunner } from "../src/components/assistant-ui/elements/code-runner";
import { PermissionGrant } from "../src/components/assistant-ui/elements/permission-grant";
import { ComposerContext } from "../src/components/assistant-ui/elements/composer";
import { InlineCitation } from "../src/components/assistant-ui/elements/inline-citation";
import { MathBlock } from "../src/components/assistant-ui/elements/math-block";
import { MemoryChips } from "../src/components/assistant-ui/elements/memory-chips";
import { ToolError } from "../src/components/assistant-ui/elements/tool-error";
import { File } from "../src/components/assistant-ui/elements/file";
import { Image } from "../src/components/assistant-ui/elements/image";
import { Sources } from "../src/components/assistant-ui/elements/sources";
import { StreamingText } from "../src/components/assistant-ui/elements/streaming-text";
import { GenerativeUIBlock, GenerativeUISurface } from "../src/components/assistant-ui/generative-ui-block";
import { DIRECTORY_MIME_TYPE } from "@qone/protocol";

test("official assistant elements render their real data slots", () => {
  const render = (element: ReactElement) => renderToStaticMarkup(element);
  expect(render(createElement(ToolError, { name: "read", target: "a.ts", message: "failed", retrying: false, open: false, onOpenChange: () => {} }))).toContain('data-slot="tool-error"');
  const codeRunner = render(createElement(CodeRunner, { language: "PowerShell", code: "Get-ChildItem", state: "ok", output: ["a.ts"] }));
  expect(codeRunner).toContain('data-slot="code-runner"');
  expect(codeRunner).toContain("max-h-[min(18rem,40dvh)]");
  expect(codeRunner).not.toContain("min-h-48");
  expect(render(createElement(PermissionGrant, { capability: "Full access", requester: "Qone", reach: ["workspace"], scope: "pending", onGrant: () => {} }))).toContain('data-slot="permission-grant"');
  expect(render(createElement(InlineCitation, { sources: [{ domain: "example.com", url: "https://example.com", label: "1" }], openIndex: null, onOpenIndexChange: () => {} }))).toContain('data-slot="inline-citation"');
  expect(render(createElement(MathBlock, { steps: [{ expression: "x = 1" }], visibleSteps: 1 }))).toContain('data-slot="math-block"');
  expect(render(createElement(MemoryChips, { chips: [{ id: "memory-1", text: "昵称: Qone", change: "existing" }] }))).toContain('data-slot="memory-chips"');
  expect(render(createElement(ComposerContext, { usage: { tools: 1, messages: 2, total: 128 } }))).toContain('data-slot="composer-context"');
  expect(render(createElement(File, { type: "file", data: "data:text/plain;base64,aGk=", mimeType: "text/plain", filename: "notes.txt" } as never))).toContain('data-slot="file-download"');
  expect(render(createElement(Image, { type: "image", image: "data:image/png;base64,aGk=", filename: "plot.png" } as never))).toContain('data-slot="image-preview"');
  const sourcesMarkup = render(createElement(Sources, { sources: [{ domain: "example.com", title: "Docs", url: "https://example.com" }], open: true, onOpenChange: () => {} }));
  expect(sourcesMarkup).toContain('data-slot="sources"');
  expect(sourcesMarkup).toContain("https://www.google.com/s2/favicons?domain=example.com&amp;sz=64");
  const streaming = render(createElement(StreamingText, { segments: [{ text: "正在生成" }], count: 1, streaming: true }));
  expect(streaming).not.toContain("w-0.5");
  expect(render(createElement(GenerativeUIBlock, { code: '{"$type":"Text","children":"result"}', language: "generative-ui" } as never))).toContain('data-slot="generative-ui-block"');
  expect(render(createElement(GenerativeUISurface, { spec: { $type: "Card", title: "Summary", children: [{ $type: "Text", children: "Ready" }] } }))).toContain("Ready");
});

test("failed tool cards expose the same disclosure state as other tool rows", () => {
  const props = { name: "powershell", target: "Get-Content a.ts", message: "command failed", onOpenChange: () => {} };
  const closed = renderToStaticMarkup(createElement(ToolError, { ...props, open: false }));
  const open = renderToStaticMarkup(createElement(ToolError, { ...props, open: true }));
  expect(closed).toContain('aria-expanded="false"');
  expect(closed).not.toContain("command failed");
  expect(open).toContain('aria-expanded="true"');
  expect(open).toContain('data-slot="collapsible-content"');
  expect(open).toContain("command failed");
});

test("folder attachment renders a folder icon without a download or fake size", () => {
  const markup = renderToStaticMarkup(createElement(File, { type: "file", data: "", mimeType: DIRECTORY_MIME_TYPE, filename: "source" } as never));
  expect(markup).toContain('data-slot="codex-icon"');
  expect(markup).toContain("source");
  expect(markup).not.toContain('data-slot="file-download"');
  expect(markup).not.toContain('data-slot="file-size"');
});

test("sent PDF and spreadsheet attachments use their own Codex icons", () => {
  const pdf = renderToStaticMarkup(createElement(File, { type: "file", data: "", mimeType: "application/pdf", filename: "report.pdf" } as never));
  const sheet = renderToStaticMarkup(createElement(File, { type: "file", data: "", mimeType: "application/octet-stream", filename: "sales.xlsx" } as never));
  expect(pdf).toContain("document-pdf-light-20.svg");
  expect(sheet).toContain("spreadsheet-light-16.svg");
});
