import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { MarkdownLink, citationSource } from "../src/components/assistant-ui/markdown-link";
import { SyntaxHighlighter } from "../src/components/assistant-ui/elements/shiki-highlighter";
import { markdownUrlTransform } from "../src/lib/markdown-file-reference";
import { useStore } from "../src/store";

test("real Markdown link rendering retains Windows href, custom label and file icon", () => {
  const state = useStore.getInitialState();
  const original = { ...state };
  try {
    Object.assign(state, {
      currentSessionId: "s", sessions: [{ id: "s", workspaceId: "w" }], workspaces: [{ id: "w", path: "C:/Repo" }],
    });
    const markup = renderToStaticMarkup(<ReactMarkdown urlTransform={markdownUrlTransform} components={{ a: MarkdownLink }}>
      {"[主题样式](C:/Repo/src/theme.css:12) / [主区样式](src/App.tsx#L3) / [网页](https://example.com) / [章节](#section)"}
    </ReactMarkdown>);
    expect(markup.match(/data-file-reference=/g)).toHaveLength(2);
    expect(markup).toContain("主题样式</a>");
    expect(markup).toContain("file-css-26-928.svg");
    expect(markup).toContain("file-react-26-928.svg");
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).not.toContain('aria-disabled="true"');
    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('href="#section"');
    expect(markup).not.toContain('node="');
  } finally { Object.assign(state, original); }
});

test("workspace-external references are visible but cannot accidentally navigate to a browser", () => {
  const markup = renderToStaticMarkup(<MarkdownLink href="D:/Outside/App.tsx">组件</MarkdownLink>);
  expect(markup).toContain('aria-disabled="true"');
  expect(markup).not.toContain("href=");
  expect(markup).toContain("组件</a>");
});

test("numeric citations keep their original URL semantics", () => {
  expect(citationSource("https://example.com/source", "12")?.label).toBe("12");
  expect(citationSource("C:/Repo/A.ts", "12")).toBeNull();
});

test("file viewer fallback retains leading blank lines and indentation for accurate positioning", () => {
  const markup = renderToStaticMarkup(<SyntaxHighlighter code={"\n\n  const a = 1;\n"} language="typescript" preserveWhitespace lineMarkers streaming />);
  expect(markup.match(/data-file-line=/g)).toHaveLength(4);
  expect(markup).toContain('data-file-line="1"></span>');
  expect(markup).toContain('data-file-line="3">  const a = 1;');
  expect(markup).toContain('data-file-line="4"></span>');
});
