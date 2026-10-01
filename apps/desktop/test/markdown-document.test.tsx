import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownDocument } from "../src/components/assistant-ui/markdown-document";
import { FileReferenceContext } from "../src/lib/file-reference-context";
import { documentMarkdownUrlTransform } from "../src/lib/document-markdown";

test("the reader renders full Markdown with GFM, math and stable document anchors", () => {
  const markup = renderToStaticMarkup(<FileReferenceContext.Provider value={{ directory: "C:\\Repo\\docs", root: "C:\\Repo", sessionId: "session", workspaceId: "workspace" }}>
    <MarkdownDocument text={"# 文档标题\n\n[目录](#文档标题)\n\n## Repeat\n\n## Repeat\n\n| Name | Value |\n| --- | --- |\n| Demo | 12 |\n\n- [x] Finished\n\n~~Removed~~\n\n$E=mc^2$\n\n[下一篇](next.md)\n"} />
  </FileReferenceContext.Provider>);
  expect(markup).toContain('id="文档标题"');
  expect(markup).toContain('id="repeat"');
  expect(markup).toContain('id="repeat-1"');
  expect(markup).toContain('<table');
  expect(markup).toContain('type="checkbox"');
  expect(markup).toContain('<del');
  expect(markup).toContain('katex');
  expect(markup).toContain(`href="#${encodeURIComponent("文档标题")}"`);
  expect(markup).toContain('data-file-reference="next.md"');
  expect(markup).toContain('tabindex="0"');
});

test("document resources retain local paths without allowing executable protocols", () => {
  expect(documentMarkdownUrlTransform("images/plot.png", "src", { type: "element", tagName: "img", properties: {}, children: [] })).toBe("images/plot.png");
  expect(documentMarkdownUrlTransform("file:///C:/Docs/plot.png", "src", { type: "element", tagName: "img", properties: {}, children: [] })).toBe("file:///C:/Docs/plot.png");
  expect(documentMarkdownUrlTransform("javascript:alert(1)", "href", { type: "element", tagName: "a", properties: {}, children: [] })).toBe("");
});
