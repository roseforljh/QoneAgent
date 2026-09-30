import { expect, test } from "bun:test";
import { markdownUrlTransform, parseMarkdownFileReference, fileReferenceLabel } from "../src/lib/markdown-file-reference";
import { workspaceRelativeFilePath } from "../src/lib/workspace-file-navigation";
import { markdownFileIcon } from "../src/lib/markdown-file-icon";

test("Windows, relative, POSIX and file URI destinations preserve encoded spaces and Unicode", () => {
  expect(parseMarkdownFileReference("C:/Repo/src/主题%20样式.css:12:3")).toEqual({ path: "C:/Repo/src/主题 样式.css", line: 12, column: 3 });
  expect(parseMarkdownFileReference("C:\\Repo\\src\\App.tsx#L12-L16")).toEqual({ path: "C:/Repo/src/App.tsx", line: 12, endLine: 16 });
  expect(parseMarkdownFileReference("./src/App.tsx#L12C3")).toEqual({ path: "./src/App.tsx", line: 12, column: 3 });
  expect(parseMarkdownFileReference("App.tsx:12:3")).toEqual({ path: "App.tsx", line: 12, column: 3 });
  expect(parseMarkdownFileReference("/repo/src/A.ts:2")).toEqual({ path: "/repo/src/A.ts", line: 2 });
  expect(parseMarkdownFileReference("file:///C:/Repo/My%20File.ts#L2")).toEqual({ path: "C:/Repo/My File.ts", line: 2 });
  expect(parseMarkdownFileReference("file://server/share/A.ts")).toEqual({ path: "//server/share/A.ts" });
  expect(parseMarkdownFileReference("\\\\server\\share\\A.ts")).toEqual({ path: "//server/share/A.ts" });
  expect(parseMarkdownFileReference(".gitignore")).toEqual({ path: ".gitignore" });
});

test("web/mail/anchor destinations and invalid positions never become file references", () => {
  for (const href of ["https://example.com/src/App.tsx#L2", "http://localhost:3000", "//example.com/A.ts", "mailto:a@example.com", "#section", "javascript:alert(1)", "javascript:123", "C:/Repo/file.ts:other", "data:text/html,hello", "vscode://file/C:/A.ts", "bad%ZZ.ts", "A.ts?raw=1", "A.ts:0", "A.ts#L3-L1", "A.ts:9007199254740992", "C:/x\n.ts", "javascript%3Aalert(1)"]) {
    expect(parseMarkdownFileReference(href)).toBeUndefined();
  }
});

test("Markdown URL transform preserves file anchors but keeps protocol and image filtering", () => {
  const node = { type: "element", tagName: "a", properties: {}, children: [] } as const;
  // URL transform does not need node data; these calls follow react-markdown's signature.
  expect(markdownUrlTransform("C:/Repo/A.ts:3", "href", { ...node, children: [] })).toBe("C:/Repo/A.ts:3");
  expect(markdownUrlTransform("file:///C:/A.ts", "href", { ...node, children: [] })).toBe("file:///C:/A.ts");
  expect(markdownUrlTransform("file:///C:/A.png", "src", { ...node, children: [] })).toBe("");
  expect(markdownUrlTransform("javascript:alert(1)", "href", { ...node, children: [] })).toBe("");
  expect(markdownUrlTransform("https://example.com", "href", { ...node, children: [] })).toBe("https://example.com");
});

test("decoded destinations must still respect workspace boundaries", () => {
  const reference = parseMarkdownFileReference("C:/Repo/%2e%2e/Outside/A.ts:2")!;
  expect(workspaceRelativeFilePath(reference.path, "C:/Repo")).toBeUndefined();
  expect(workspaceRelativeFilePath(parseMarkdownFileReference("src/A.ts#L2")!.path, "C:/Repo")).toBe("src/A.ts");
});

test("file icons use the destination extension, including Codex aliases and skill filename", () => {
  expect(markdownFileIcon("theme.css")).toBe(markdownFileIcon("theme.scss"));
  expect(markdownFileIcon("App.tsx")).toBe(markdownFileIcon("App.jsx"));
  expect(markdownFileIcon("App.tsx")).not.toBe(markdownFileIcon("App.ts"));
  expect(markdownFileIcon("SKILL.md")).not.toBe(markdownFileIcon("readme.md"));
  expect(fileReferenceLabel({ path: "C:/Repo/A.ts", line: 12, column: 3, endLine: 16 })).toBe("C:/Repo/A.ts:12:3–16");
});
