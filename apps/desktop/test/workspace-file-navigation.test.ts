import { expect, test } from "bun:test";
import { workspaceRelativeFilePath } from "../src/lib/workspace-file-navigation";

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
