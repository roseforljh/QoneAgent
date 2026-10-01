import { expect, test } from "bun:test";
import { filePreviewTab, type DockTab } from "../src/lib/dock-state";

const newId = () => crypto.randomUUID();

test("a file reference opens a reader independently of an existing directory browser", () => {
  const browser: DockTab = { id: "tree", view: "files", workspaceId: "workspace" };
  const reader = filePreviewTab([browser], { path: "C:/Repo/docs/readme.md", workspaceId: "workspace" }, newId);
  expect(reader.view).toBe("file");
  expect(reader.id).not.toBe(browser.id);
  expect(reader.fileTarget?.path).toBe("C:/Repo/docs/readme.md");
  expect(browser.fileTarget).toBeUndefined();
});

test("reselecting a document keeps its tab and changes its navigation request", () => {
  const first = filePreviewTab([], { path: "C:/Repo/guide.md", workspaceId: "workspace" }, newId);
  const selected = filePreviewTab([first], { path: "C:/Repo/guide.md", workspaceId: "workspace", line: 8, column: 3, endLine: 10 }, newId);
  expect(selected.id).toBe(first.id);
  expect(selected.fileTarget).toMatchObject({ line: 8, column: 3, endLine: 10 });
  expect(selected.fileTarget?.requestId).not.toBe(first.fileTarget?.requestId);
  expect(first.fileTarget?.line).toBeUndefined();
});

test("another file or workspace opens an independent reader", () => {
  const first = filePreviewTab([], { path: "C:/Repo/guide.md", workspaceId: "workspace" }, newId);
  expect(filePreviewTab([first], { path: "C:/Repo/second.md", workspaceId: "workspace" }, newId).id).not.toBe(first.id);
  expect(filePreviewTab([first], { path: "C:/Repo/guide.md", workspaceId: "other-workspace" }, newId).id).not.toBe(first.id);
});

test("projectless sessions can open an absolute file path", () => {
  const reader = filePreviewTab([], { sessionId: "session", path: "D:/Shared/guide.md" }, newId);
  expect(reader).toMatchObject({ view: "file", fileTarget: { path: "D:/Shared/guide.md" } });
  expect(reader.workspaceId).toBeUndefined();
});
