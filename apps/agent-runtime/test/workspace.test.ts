import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listWorkspaceFiles, readWorkspaceFile, workspaceDiff, workspaceGit } from "../src/workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function fixture() {
  const root = mkdtempSync(path.join(process.cwd(), ".test-data", "workspace-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Workspace Test"]);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "main.ts"), "export const value = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
}

describe("workspace explorer", () => {
  test("lists directories, reads text and rejects workspace escapes", async () => {
    const root = fixture();
    expect((await listWorkspaceFiles(root)).map((entry) => entry.path)).toEqual(["src"]);
    expect((await listWorkspaceFiles(root, "src")).map((entry) => entry.path)).toEqual(["src/main.ts"]);
    expect(await readWorkspaceFile(root, "src/main.ts")).toMatchObject({ content: "export const value = 1;\n", binary: false, truncated: false });
    await expect(readWorkspaceFile(root, "../outside.txt")).rejects.toThrow("outside");
  });

  test("returns structured Git status and diffs tracked plus untracked files", async () => {
    const root = fixture();
    writeFileSync(path.join(root, "src", "main.ts"), "export const value = 2;\n");
    writeFileSync(path.join(root, "new.txt"), "new file\n");
    const status = await workspaceGit(root);
    expect(status.entries.map((entry) => entry.path).sort()).toEqual(["new.txt", "src/main.ts"]);
    expect(status.entries.find((entry) => entry.path === "new.txt")?.code).toBe("??");
    expect((await workspaceDiff(root, "src/main.ts")).diff).toContain("-export const value = 1;");
    expect((await workspaceDiff(root, "new.txt")).diff).toContain("+new file");
  });
});
