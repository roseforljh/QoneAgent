import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { computeVirtualRange, WorkspaceFileContent } from "../src/components/assistant-ui/workspace-file-content";
import { tokenizeLinesInChunks, type HighlightLine } from "../src/lib/shiki-tokenize";

test("large files render only a virtual window instead of mounting every line to DOM", () => {
  const largeCode = Array.from({ length: 5000 }, (_, i) => `export const value${i + 1} = ${i + 1};`).join("\n");
  const markup = renderToStaticMarkup(
    <WorkspaceFileContent code={largeCode} language="typescript" path="C:/Repo/big.ts" active />,
  );
  const lineMatches = markup.match(/data-file-line="/g) ?? [];
  expect(lineMatches.length).toBeGreaterThan(20);
  expect(lineMatches.length).toBeLessThan(200);
  expect(markup).toContain('data-file-line="1"');
  expect(markup).not.toContain('data-file-line="4999"');
});

test("jumping to a deep target line renders and marks that line inside the virtual window", () => {
  const largeCode = Array.from({ length: 4000 }, (_, i) => `const line_${i + 1} = ${i + 1};`).join("\n");
  const markup = renderToStaticMarkup(
    <WorkspaceFileContent
      code={largeCode}
      language="typescript"
      path="C:/Repo/big.ts"
      target={{ path: "C:/Repo/big.ts", line: 3500, endLine: 3502, requestId: "req-1" }}
      active
    />,
  );
  expect(markup).toContain('data-file-line="3500" data-file-selected="true"');
  expect(markup).toContain('data-file-line="3502" data-file-selected="true"');
  expect(markup).not.toContain('data-file-line="1"');
});

test("virtual window hysteresis avoids unnecessary rerenders on small scroll movements", () => {
  const initial = computeVirtualRange(3000, 1000, 600, 20);
  const smallScroll = computeVirtualRange(3000, 1040, 600, 20, initial);
  expect(smallScroll).toBe(initial);
  const bigScroll = computeVirtualRange(3000, 2400, 600, 20, initial);
  expect(bigScroll).not.toBe(initial);
  expect(bigScroll.start).toBeGreaterThan(initial.start);
});

test("chunked shiki tokenizer preserves cross-chunk grammar state, skips huge single lines, and supports cancel", async () => {
  const lines = [
    "/* block comment start",
    "still inside comment",
    "still inside comment line 3",
    "end of comment */",
    "const ok = 42;",
    `const huge = "${"a".repeat(9000)}";`,
  ];
  const chunks: { start: number; lines: HighlightLine[]; done: boolean }[] = [];
  await tokenizeLinesInChunks({
    lines,
    language: "typescript",
    chunkSize: 2,
    isCancelled: () => false,
    onChunk: (start, chunkLines, done) => chunks.push({ start, lines: chunkLines, done }),
  });

  expect(chunks.length).toBe(3);
  expect(chunks.at(-1)?.done).toBe(true);

  // 第 3 行（索引 2）在第二个 chunk 内，必须继承第一个 chunk 的多行注释着色
  const line0Token = chunks[0]!.lines[0]![0];
  const line2Token = chunks[1]!.lines[0]![0];
  expect(Array.isArray(line0Token) && Array.isArray(line2Token) && line0Token[1] === line2Token[1]).toBe(true);

  // 超长单行跳过正则分词，直接原样保留为纯字符串
  const hugeLine = chunks[2]!.lines[1]!;
  expect(hugeLine).toHaveLength(1);
  expect(typeof hugeLine[0]).toBe("string");

  // 验证取消后不再输出后续分块
  let cancelledCalls = 0;
  let cancelled = false;
  await tokenizeLinesInChunks({
    lines: Array.from({ length: 10 }, (_, i) => `const x${i} = ${i};`),
    language: "typescript",
    chunkSize: 2,
    isCancelled: () => cancelled,
    onChunk: () => {
      cancelledCalls++;
      cancelled = true;
    },
  });
  expect(cancelledCalls).toBe(1);
});

test("WorkspaceFileContent highlights asynchronously via chunked client without MutationObserver", async () => {
  const dom = new JSDOM("<!doctype html><body><div data-file-viewport style='height:400px;overflow:auto'><div id='root'></div></div></body>");
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <WorkspaceFileContent
          code={"const answer: number = 42;\nexport default answer;"}
          language="typescript"
          path="C:/Repo/sample.ts"
          active
        />,
      );
    });
    const deadline = Date.now() + 5000;
    while (host.querySelectorAll(".line span[style]").length === 0 && Date.now() < deadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
    }
    expect(host.querySelectorAll(".line[data-file-line]")).toHaveLength(2);
    expect(host.querySelectorAll(".line span[style]").length).toBeGreaterThan(2);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});
