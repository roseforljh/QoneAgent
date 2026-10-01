import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface CopyCandidate { file: string; line: number; text: string; kind: "text" | "attribute" | "default" }
const displayAttributes = new Set(["aria-label", "ariaLabel", "placeholder", "tooltip", "title", "alt", "label", "description", "emptyText", "triggerLabel", "reason", "message"]);

/** Candidates need review: names, URLs, code and keyboard shortcuts are not translations. */
export function findCopyCandidates(directory: string): CopyCandidate[] {
  const candidates: CopyCandidate[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { candidates.push(...findCopyCandidates(file)); continue; }
    if (!/\.tsx?$/.test(entry.name) || /[\\/]i18n[\\/]/.test(file)) continue;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const record = (node: ts.Node, text: string, kind: CopyCandidate["kind"]) => {
      const value = text.trim();
      if (/[\p{L}]/u.test(value)) candidates.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: value, kind });
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) record(node, node.text, "text");
      if (ts.isJsxAttribute(node) && displayAttributes.has(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) {
        record(node, node.initializer.text, "attribute");
      }
      if (ts.isBindingElement(node) && displayAttributes.has(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) {
        record(node, node.initializer.text, "default");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return candidates;
}

if (import.meta.main) {
  const candidates = findCopyCandidates(path.resolve(import.meta.dir, "../src"));
  for (const item of candidates) console.log(`${path.relative(process.cwd(), item.file)}:${item.line} [${item.kind}] ${item.text}`);
  console.log(`${candidates.length} static display candidates (includes technical names).`);
}
