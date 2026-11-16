import { expect, test } from "bun:test";
import { splitMarkdownBlocks, type MarkdownBlockState } from "../src/lib/markdown-blocks";

const sample = [
  "# Title\n\n",
  "Intro paragraph with **bold**.\n\n",
  "- one\n- two\n\n  continued item\n\n",
  "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n",
  "$$\nx = 1\n\ny = 2\n$$\n\n",
  "| a | b |\n| - | - |\n| 1 | 2 |\n\n",
  "Last line",
].join("");

test("streamed blocks always reassemble the text and frozen blocks never change", () => {
  let state: MarkdownBlockState | undefined;
  let frozen: string[] = [];
  for (let length = 1; length <= sample.length; length += 1) {
    const result = splitMarkdownBlocks(sample.slice(0, length), state);
    state = result.state;
    expect(result.blocks.join("")).toBe(sample.slice(0, length));
    // A block, once frozen, keeps its exact text for the rest of the stream.
    expect(result.blocks.slice(0, frozen.length)).toEqual(frozen);
    frozen = result.blocks.slice(0, -1);
  }
  const blocks = splitMarkdownBlocks(sample).blocks;
  expect(blocks.some((block) => block.includes("const a = 1;\n\nconst b = 2;"))).toBe(true);
  expect(blocks.some((block) => block.includes("$$\nx = 1\n\ny = 2\n$$"))).toBe(true);
  expect(blocks.length).toBeGreaterThan(4);
});

test("replaced text restarts the split and reference definitions reach every block", () => {
  const first = splitMarkdownBlocks("a\n\nb\n\nc");
  expect(splitMarkdownBlocks("x\n\ny", first.state).blocks.join("")).toBe("x\n\ny");
  const linked = splitMarkdownBlocks("See [docs][1].\n\nMore.\n\n[1]: https://example.com\n\nEnd").blocks;
  expect(linked[0]).toContain("[1]: https://example.com");
});
