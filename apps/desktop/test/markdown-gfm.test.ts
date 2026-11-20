import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { remarkQoneGfm } from "../src/lib/markdown-gfm";
import { createCodePreviewHtml } from "../src/lib/code-preview";

const render = (children: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkQoneGfm], children }));
test("numeric ranges do not become deletions while explicit GFM still works", async () => {
  const text = "平均 58.5~59fps，功耗 5.5~5.9W，约 ~70ns";
  expect(render(text)).toContain(text);
  expect(render(text)).not.toContain("<del>");
  expect(render("~~已删除~~ `~原样~`\n\n```txt\n~~代码~~\n```")).toContain("<del>已删除</del>");
  expect(render("`~原样~`")).toContain("<code>~原样~</code>");
  expect(render("| a | b |\n| - | - |\n| 1~2 | 3~4 |")).toContain("<table>");
  expect((await createCodePreviewHtml("markdown", text))).not.toContain("<del>");
});

test("literal autolinks stop at fullwidth punctuation", () => {
  const html = render("已打开百度首页（https://www.baidu.com），页面标题为「百度一下，你就知道」。");
  expect(html).toContain('<a href="https://www.baidu.com">https://www.baidu.com</a>），页面标题为「百度一下，你就知道」。');
  expect(render("<https://a.com/x>")).toContain('<a href="https://a.com/x">');
  expect(render("见 https://zh.wikipedia.org/wiki/百度 。")).toContain('href="https://zh.wikipedia.org/wiki/%E7%99%BE%E5%BA%A6"');
});
