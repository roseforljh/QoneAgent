import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { MarkdownText } from "../src/components/assistant-ui/markdown-text";
import { MarkdownLink, citationSource } from "../src/components/assistant-ui/markdown-link";
import { SyntaxHighlighter } from "../src/components/assistant-ui/elements/shiki-highlighter";
import { markdownUrlTransform } from "../src/lib/markdown-file-reference";
import { useStore } from "../src/store";
import { FileReferenceContext } from "../src/lib/file-reference-context";
import { OPEN_WORKSPACE_FILE_EVENT, type WorkspaceFileTarget } from "../src/lib/workspace-file-navigation";

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
    expect(markup.match(/data-workspace-path-context-menu-trigger/g)).toHaveLength(2);
    expect(markup).toContain("主题样式</a>");
    expect(markup).toContain("file-css-26-928.svg");
    expect(markup).toContain("file-react-26-928.svg");
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).not.toContain('aria-disabled="true"');
    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('href="#section"');
    expect(markup).not.toContain('node="');
  } finally { Object.assign(state, original, { currentSessionId: original.currentSessionId }); }
});

test("unresolved file references retain disabled navigation with their path menu", () => {
  const markup = renderToStaticMarkup(<MarkdownLink href="src/Unknown.ts">Unknown</MarkdownLink>);
  expect(markup).toContain('aria-disabled="true"');
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain("data-workspace-path-context-menu-trigger");
});

test("inline paths use the shared Markdown file link with a filename label and Codex icon", () => {
  const state = useStore.getInitialState();
  const original = { ...state };
  try {
    Object.assign(state, {
      currentSessionId: "s", sessions: [{ id: "s", workspaceId: "w" }], workspaces: [{ id: "w", path: "C:/Repo" }],
    });
    const paths = [
      ["C:\\Users\\测试\\My Files\\matrix_visualization.html", "C:/Users/测试/My Files/matrix_visualization.html", "matrix_visualization.html", "file-html-26-928.svg"],
      ["/repo/src/App.tsx#L12-L16", "/repo/src/App.tsx", "App.tsx:12–16", "file-react-26-928.svg"],
      ["./src/theme.css:2:3", "./src/theme.css", "theme.css:2:3", "file-css-26-928.svg"],
      ["\\\\server\\share\\A.ts", "//server/share/A.ts", "A.ts", "file-typescript-26-928.svg"],
      ["file:///C:/Repo/My%20File.py", "C:/Repo/My File.py", "My File.py", "file-python-26-928.svg"],
    ];
    for (const [path, target, label, icon] of paths) {
      const markup = renderToStaticMarkup(<TextMessagePartProvider text={`打开：\`${path}\``}><MarkdownText /></TextMessagePartProvider>);
      expect(markup).toContain(`data-file-reference="${target}"`);
      expect(markup).toContain(`${label}</a>`);
      expect(markup).toContain(icon!);
      expect(markup).toContain('tabindex="0"');
      expect(markup).not.toContain("aui-md-inline-code");
    }
  } finally { Object.assign(state, original); }
});

test("ordinary inline code, code blocks and explicit link labels retain their semantics", () => {
  const text = '`input.includes("image")` / `58.5~59fps` / `https://example.com/a.ts` / `//example.com/a.ts` / `javascript:alert(1)` / `C:/Repo/A.ts:0`\n\n```txt\nC:/Repo/A.ts\n```\n\n[`C:/Repo/Label.ts`](C:/Repo/Target.ts)';
  const markup = renderToStaticMarkup(<TextMessagePartProvider text={text}><MarkdownText /></TextMessagePartProvider>);
  expect(markup.match(/data-file-reference=/g)).toHaveLength(1);
  expect(markup).toContain('data-file-reference="C:/Repo/Target.ts"');
  expect(markup.match(/aui-md-inline-code/g)).toHaveLength(7);
  expect(markup).toContain('C:/Repo/Label.ts</code>');
  expect(markup).toContain('C:/Repo/A.ts');
});

test("inline file references open on one click or Enter/Space and preserve path and location", async () => {
  const { JSDOM } = await import("jsdom");
  const { act } = await import("react");
  const dom = new JSDOM("<!doctype html><body></body>");
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const targets: WorkspaceFileTarget[] = [];
  dom.window.addEventListener(OPEN_WORKSPACE_FILE_EVENT, (event) => targets.push((event as CustomEvent<WorkspaceFileTarget>).detail));
  try {
    await act(async () => { root.render(<FileReferenceContext.Provider value={{ directory: "C:/Repo", sessionId: "s", workspaceId: "w" }}>
      <TextMessagePartProvider text={'`D:\\My Files\\matrix_visualization.html:12:3`'}><MarkdownText /></TextMessagePartProvider>
    </FileReferenceContext.Provider>); });
    const link = host.querySelector<HTMLElement>("[data-file-reference]")!;
    expect(link.textContent).toBe("matrix_visualization.html:12:3");
    await act(async () => { link.click(); });
    expect(targets).toEqual([{ path: "D:/My Files/matrix_visualization.html", line: 12, column: 3, sessionId: "s", workspaceId: "w" }]);
    for (const key of ["Enter", " "]) await act(async () => { link.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
    expect(targets).toHaveLength(3);
    expect(targets.every((target) => JSON.stringify(target) === JSON.stringify(targets[0]))).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});

test("workspace-external references open in the file preview tab", () => {
  const state = useStore.getInitialState();
  const sessionId = state.currentSessionId;
  state.currentSessionId = "session";
  try {
    const markup = renderToStaticMarkup(<MarkdownLink href="D:/Outside/App.tsx">组件</MarkdownLink>);
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).not.toContain("href=");
    expect(markup).toContain("组件</a>");
  } finally { state.currentSessionId = sessionId; }
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
