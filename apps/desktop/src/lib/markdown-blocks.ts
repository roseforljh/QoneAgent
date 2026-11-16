import { fromMarkdown } from "mdast-util-from-markdown";

/** Blocks already split off a growing markdown text; they never change again. */
export type MarkdownBlockState = { prefix: string; frozen: string[]; definitions: string };

const EMPTY: MarkdownBlockState = { prefix: "", frozen: [], definitions: "" };
const displayMathFences = (text: string) => text.match(/(?<!\\)\$\$/g)?.length ?? 0;

/**
 * Splits markdown into top-level blocks so a streaming message re-parses only
 * its last block. Only the unfrozen tail is parsed, so appending text costs
 * O(tail) instead of O(message). A block is frozen once a following block has
 * started and it does not leave a `$$` display-math fence open.
 * ponytail: GFM footnotes are not shared across blocks; a footnote referenced
 * from two blocks renders its section twice. Fix in the block renderer if it shows up.
 */
export function splitMarkdownBlocks(text: string, previous: MarkdownBlockState = EMPTY): { state: MarkdownBlockState; blocks: string[] } {
  const base = text.startsWith(previous.prefix) ? previous : EMPTY;
  const tail = text.slice(base.prefix.length);
  const children = fromMarkdown(tail).children;
  let cursor = 0;
  let frozen = base.frozen;
  let definitions = base.definitions;
  for (let index = 0; index < children.length - 1; index += 1) {
    const next = children[index + 1]!.position?.start.offset;
    if (next === undefined) break;
    const chunk = tail.slice(cursor, next);
    if (displayMathFences(chunk) % 2 === 1) break;
    if (frozen === base.frozen) frozen = [...frozen];
    frozen.push(chunk);
    // Reference definitions resolve links in every block, wherever they appear.
    if (children[index]!.type === "definition") definitions += `\n\n${chunk.trim()}`;
    cursor = next;
  }
  const state = cursor === 0 ? base : { prefix: base.prefix + tail.slice(0, cursor), frozen, definitions };
  const blocks = [...frozen, tail.slice(cursor)];
  return { state, blocks: definitions ? blocks.map((block) => block + definitions) : blocks };
}
