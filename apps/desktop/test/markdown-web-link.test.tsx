import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { MarkdownLink } from "../src/components/assistant-ui/markdown-link";
import { markdownUrlTransform } from "../src/lib/markdown-file-reference";
import { linkFaviconUrl } from "../src/lib/link-favicon";

test("known Codex service links reuse their glyph and make no favicon request", () => {
  const markup = renderToStaticMarkup(<MarkdownLink href="https://github.com/org/repo" title="仓库">GitHub · 项目</MarkdownLink>);
  expect(markup).toContain("composer-github-26-928.svg");
  expect(markup).toContain('class="q-markdown-web-link-label"');
  expect(markup).toContain("GitHub · 项目</span>");
  expect(markup).toContain('title="仓库"');
  expect(markup).not.toContain("faviconV2");
  expect(markup).not.toContain("text-primary");
});

test("unknown websites request a favicon with a visible generic fallback", () => {
  const markup = renderToStaticMarkup(<MarkdownLink href="https://www.assistant-ui.com/docs">组件库</MarkdownLink>);
  expect(markup).toContain("composer-globe-26-928.svg");
  expect(markup).toContain("faviconV2");
  expect(markup).toContain('referrerPolicy="no-referrer"');
  expect(markup).toContain('loading="lazy"');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).not.toContain('data-favicon-loaded=""');
  expect(markup).toContain("组件库</span>");
});

test("Qone's extra known sites remain as fallbacks while official favicons load", () => {
  const markup = renderToStaticMarkup(<MarkdownLink href="https://www.google.com/search?q=private">搜索</MarkdownLink>);
  expect(markup).toContain("google-color.svg");
  expect(markup).toContain("faviconV2");
  expect(markup).toContain("url=https%3A%2F%2Fwww.google.com");
  expect(markup).not.toContain("url=https%3A%2F%2Fwww.google.com%2Fsearch");
});

test("real Markdown raw URLs can wrap, while titled inline labels retain their text", () => {
  const markup = renderToStaticMarkup(<ReactMarkdown urlTransform={markdownUrlTransform} components={{ a: MarkdownLink }}>
    {"打开 [React 文档](https://react.dev/)，以及 <https://example.com/a?q=1&x=2>。"}
  </ReactMarkdown>);
  expect(markup.match(/q-markdown-web-link-icon/g)).toHaveLength(2);
  expect(markup.match(/data-breakable-url/g)).toHaveLength(1);
  expect(markup).toContain("React 文档</span>");
  expect(markup).toContain('href="https://example.com/a?q=1&amp;x=2"');
});

test("mail, page anchors and unsafe protocols do not request favicons", () => {
  for (const href of ["mailto:hello@example.com", "#section"]) {
    const markup = renderToStaticMarkup(<MarkdownLink href={href}>跳转</MarkdownLink>);
    expect(markup).toContain(`href="${href}"`);
    expect(markup).not.toContain("q-markdown-web-link-icon");
    expect(markup).not.toContain("faviconV2");
  }
  for (const href of ["javascript:alert(1)", "data:image/png;base64,AA", "file:///C:/A.png", "invalid URL", "mailto:hello@example.com"]) {
    expect(linkFaviconUrl(href)).toBeUndefined();
  }
});

test("favicon URL excludes credentials, path, query and fragments, and supports protocol-relative URLs", () => {
  const first = linkFaviconUrl("https://user:password@example.com:8443/private?a=secret#token")!;
  const second = linkFaviconUrl("https://example.com:8443/other?another=value")!;
  expect(first).toBe(second);
  expect(new URL(first).searchParams.get("url")).toBe("https://example.com:8443");
  expect(first).not.toContain("password");
  expect(first).not.toContain("secret");
  expect(linkFaviconUrl("//react.dev/learn")).toBe(linkFaviconUrl("https://react.dev/"));
});
