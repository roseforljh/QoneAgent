import remarkGfm from "remark-gfm";

type MarkdownNode = { type?: string; value?: string; url?: string; children?: MarkdownNode[]; position?: { start?: { offset?: number } } };

// 全角标点（CJK 符号与全角形式）不会裸露出现在真实 URL 中，是 URL 的天然边界。
const FULLWIDTH_PUNCTUATION = /[\u3000-\u303f\uff00-\uffef]/u;
/** 裸 URL 匹配：遇到空白、尖括号或全角标点即结束。 */
export const BARE_URL_PATTERN = /https?:\/\/[^\s<>\u3000-\u303f\uff00-\uffef]+/gi;

/** GFM 字面量自动链接只在空白和 ASCII 标点处截断，
 * 会把 `https://a.com），说明。` 整段吞进链接。这里在首个全角标点处切开。
 * 显式的 `<url>` 与 `[text](url)` 由作者明确界定，不处理。 */
function splitLiteralAutolinks(tree: MarkdownNode, file: { value?: unknown }) {
  const source = String(file.value ?? "");
  const visit = (node: MarkdownNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): MarkdownNode[] => {
      visit(child);
      const label = child.type === "link" && child.children?.length === 1 && child.children[0]!.type === "text" ? child.children[0]!.value : undefined;
      const offset = child.position?.start?.offset;
      if (!label || offset === undefined || source[offset] === "<" || source[offset] === "[" || !child.url?.endsWith(label)) return [child];
      const cut = label.search(FULLWIDTH_PUNCTUATION);
      if (cut <= 0) return [child];
      const tail = label.slice(cut);
      return [
        { ...child, url: child.url.slice(0, -tail.length), children: [{ type: "text", value: label.slice(0, cut) }] },
        { type: "text", value: tail },
      ];
    });
  };
  visit(tree);
}

/** Numeric ranges use a single tilde; explicit ~~deletions~~ remain supported. */
export function remarkQoneGfm(this: ThisParameterType<typeof remarkGfm>) {
  remarkGfm.call(this, { singleTilde: false });
  return splitLiteralAutolinks;
}

/** 将软换行转为 Markdown 硬换行，保留用户在输入框中按 Shift+Enter 输入的每一行。 */
export function remarkLineBreaks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || node.type === "code" || node.type === "inlineCode") return;
      const children: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && child.value && /[\r\n]/.test(child.value)) {
          const lines = child.value.split(/\r?\n/);
          lines.forEach((line, index) => {
            if (index > 0) children.push({ type: "break" });
            if (line.length > 0) children.push({ type: "text", value: line });
          });
        } else {
          visit(child);
          children.push(child);
        }
      }
      node.children = children;
    };
    visit(tree);
  };
}
