import { expect, test } from "bun:test";
import { fileReferenceDirectory, resolveFileReferencePath, workspaceRelativeFilePath } from "../src/lib/workspace-file-navigation";

test("maps absolute and relative file evidence within the workspace", () => {
  expect(workspaceRelativeFilePath("C:\\Repo\\src\\A.ts", "c:/repo")).toBe("src/A.ts");
  expect(workspaceRelativeFilePath("src/./A.ts", "C:/Repo")).toBe("src/A.ts");
});

test("rejects external paths and parent traversal", () => {
  expect(workspaceRelativeFilePath("C:/repo-other/A.ts", "C:/repo")).toBeUndefined();
  expect(workspaceRelativeFilePath("D:/repo/A.ts", "C:/repo")).toBeUndefined();
  expect(workspaceRelativeFilePath("../A.ts", "C:/repo")).toBeUndefined();
  expect(workspaceRelativeFilePath("C:/repo/../outside/A.ts", "C:/repo")).toBeUndefined();
});

test("resolves root relative document links inside a Windows workspace", () => {
  expect(resolveFileReferencePath("/docs/readme.md", "C:/Repo/docs", "C:/Repo")).toBe("C:/Repo/docs/readme.md");
  expect(resolveFileReferencePath("next.md", "C:/Repo/docs")).toBe("C:/Repo/docs/next.md");
  expect(resolveFileReferencePath("D:/Shared/readme.md", "C:/Repo/docs")).toBe("D:/Shared/readme.md");
});

test("normalizes native Windows directories before resolving links and parent segments", () => {
  expect(resolveFileReferencePath("/docs/readme.md", "C:\\Repo\\docs", "C:\\Repo")).toBe("C:/Repo/docs/readme.md");
  expect(resolveFileReferencePath("next.md", "C:\\Repo\\docs")).toBe("C:/Repo/docs/next.md");
  expect(resolveFileReferencePath("../images/plot.png", "C:\\Repo\\docs")).toBe("C:/Repo/images/plot.png");
  expect(resolveFileReferencePath("../../../readme.md", "C:\\Repo\\docs")).toBe("C:/readme.md");
});

test("preserves POSIX and UNC absolute destinations", () => {
  expect(resolveFileReferencePath("/tmp/readme.md", "/repo/docs", "/repo")).toBe("/tmp/readme.md");
  expect(resolveFileReferencePath("../readme.md", "\\\\server\\share\\docs")).toBe("//server/share/readme.md");
  expect(resolveFileReferencePath("../../../readme.md", "\\\\server\\share\\docs")).toBe("//server/share/readme.md");
  expect(resolveFileReferencePath("\\\\other\\share\\a.md", "C:\\Repo")).toBe("//other/share/a.md");
});

test("requires a base for relative paths and rejects control characters", () => {
  expect(resolveFileReferencePath("readme.md")).toBeUndefined();
  expect(resolveFileReferencePath("C:/Repo/file\u0000.md")).toBeUndefined();
});

test("resource scopes preserve drive, POSIX and UNC roots", () => {
  expect(fileReferenceDirectory("C:\\guide.md")).toBe("C:/");
  expect(fileReferenceDirectory("/guide.md")).toBe("/");
  expect(fileReferenceDirectory("\\\\server\\share\\guide.md")).toBe("//server/share");
  expect(fileReferenceDirectory("C:\\Repo\\docs\\guide.md")).toBe("C:/Repo/docs");
  expect(fileReferenceDirectory("guide.md")).toBeUndefined();
});
