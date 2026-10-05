import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncPonytailProjectInstructions } from "../src/project-instructions.js";

test("syncs the ponytail prompt into AGENTS.md without duplicating or deleting project rules", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-project-instructions-"));
  const skill = path.join(root, "SKILL.md");
  const agents = path.join(root, "AGENTS.md");
  writeFileSync(skill, "---\nname: ponytail\n---\n\n# Ponytail\n\nUse the shortest correct solution.\n");
  try {
    await syncPonytailProjectInstructions(root, true, skill);
    const first = readFileSync(agents, "utf8");
    expect(first).toContain("# Ponytail\n\nUse the shortest correct solution.");
    expect(first).toContain("QoneAgent managed: ponytail:start");

    await syncPonytailProjectInstructions(root, true, skill);
    expect(readFileSync(agents, "utf8")).toBe(first);

    writeFileSync(agents, `${first}\n\n# Project rules\nKeep the existing API stable.\n`);
    await syncPonytailProjectInstructions(root, false, skill);
    expect(readFileSync(agents, "utf8")).toBe("# Project rules\nKeep the existing API stable.\n");
    expect(readFileSync(agents, "utf8")).not.toContain("QoneAgent managed: ponytail");

    await syncPonytailProjectInstructions(root, false, skill);
    expect(existsSync(agents)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removes a generated AGENTS.md when the managed prompt is the only content", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-project-instructions-empty-"));
  const skill = path.join(root, "SKILL.md");
  const agents = path.join(root, "AGENTS.md");
  writeFileSync(skill, "---\nname: ponytail\n---\nPrompt\n");
  try {
    await syncPonytailProjectInstructions(root, true, skill);
    await syncPonytailProjectInstructions(root, false, skill);
    expect(existsSync(agents)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
