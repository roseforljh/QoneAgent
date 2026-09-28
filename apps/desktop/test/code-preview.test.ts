import { expect, mock, test } from "bun:test";
import { canPreviewCode, createCodePreviewHtml } from "../src/lib/code-preview";
import { sandboxPreviewHtml } from "../src/lib/browser-dock";

mock.module("virtual:qone-react-preview-runtime", () => ({ default: "window.__qonePreview = { mount() {} };" }));

test("HTML and SVG preserve source and Unicode", async () => {
  const html = "<!doctype html><h1>你好</h1>";
  expect(await createCodePreviewHtml("HTML", html)).toBe(html);

  const svg = "<svg viewBox='0 0 1 1'></svg>";
  expect(await createCodePreviewHtml("svg", svg)).toContain(svg);
});

test("Markdown and Mermaid render to browser documents", async () => {
  const markdown = (await createCodePreviewHtml("md", "# Title\n\n**bold**"))!;
  expect(markdown).toContain("<h1>Title</h1>");
  expect(markdown).toContain("<strong>bold</strong>");
  const mermaid = (await createCodePreviewHtml("mermaid", "flowchart LR\nA --> B"))!;
  expect(mermaid).toContain("<svg");
});

test("JavaScript and TypeScript run in a separate browser document", async () => {
  const js = (await createCodePreviewHtml("js", 'document.body.innerHTML = "</script><h1>done</h1>"'))!;
  expect(js).toContain("new AsyncFunction");
  expect(js).not.toContain('</script><h1>done</h1>');
  const ts = (await createCodePreviewHtml("ts", 'const message: string = "ok"; console.log(message)'))!;
  expect(ts).toContain('const message = \\"ok\\"');
  expect(ts).not.toContain("message: string");
});

test("React TSX compiles standard React imports and a default component", async () => {
  const html = (await createCodePreviewHtml("tsx", 'import React from "react"; export default function App() { return <h1>Hello</h1> }'))!;
  expect(html).toContain("window.__qonePreview.mount");
  expect(html).toContain('require(\\"react\\")');
  expect(html).toContain("exports.default = App");
  expect(html).not.toContain("<h1>Hello</h1>");
});

test("unsupported or empty code has no preview", async () => {
  expect(canPreviewCode("tsx", "export default () => <div />")).toBe(true);
  expect(canPreviewCode("css", "body { color: red }")).toBe(false);
  expect(canPreviewCode("xml", "<root/>")).toBe(false);
  expect(canPreviewCode("svg", "<div>not SVG</div>")).toBe(false);
  expect(await createCodePreviewHtml("python", "print(1)")).toBeUndefined();
  expect(await createCodePreviewHtml("html", "  ")).toBeUndefined();
});

test("preview runs inside an opaque sandbox without breaking srcdoc attributes", () => {
  const html = '<script>document.body.textContent = "</iframe> & ok"</script>';
  const wrapped = sandboxPreviewHtml(html);
  expect(wrapped).toContain('sandbox="allow-scripts allow-forms allow-modals"');
  expect(wrapped).toContain('srcdoc="&lt;script&gt;document.body.textContent = &quot;&lt;/iframe&gt; &amp; ok&quot;&lt;/script&gt;"');
  expect(wrapped).not.toContain("allow-same-origin");
});
