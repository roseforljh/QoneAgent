import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMathDelimiters } from "@assistant-ui/react-markdown";
import { normalizeMultilineDisplayMath } from "../src/lib/normalize-display-math";

test("renders multiline matrix and aligned math even when the opening $$ shares a line", () => {
  const input = String.raw`矩阵：$$A = \begin{pmatrix}
a & b \\
c & d
\end{pmatrix}$$

$$\begin{aligned}
x &= 1 \\
y &= 2
\end{aligned}$$`;
  const output = normalizeMultilineDisplayMath(normalizeMathDelimiters(input));
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
    children: output,
  }));
  expect(html).toContain("katex-display");
  expect(html).not.toContain("katex-error");
  expect(html).toContain("<mtable");
});

test("keeps one-line math, code fences, and inline code unchanged", () => {
  const input = "$$x+y$$\n\n```latex\n$$a\nb$$\n```\n\n`$$c\nd$$`";
  expect(normalizeMultilineDisplayMath(input)).toBe(input);
});
