import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanManagedPonytailProjectInstructions } from "../src/project-instructions.js";
import { workspaceInstructions } from "../src/workspace-instructions.js";

test("cleans legacy managed ponytail blocks while preserving user project rules", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-project-instructions-"));
  const agents = path.join(root, "AGENTS.md");
  writeFileSync(agents, "# Project rules\nKeep the existing API stable.\n\n<!-- QoneAgent managed: ponytail:start -->\n# Ponytail\n<!-- QoneAgent managed: ponytail:end -->\n");
  try {
    await cleanManagedPonytailProjectInstructions(root);
    expect(readFileSync(agents, "utf8")).toBe("# Project rules\nKeep the existing API stable.\n");
    expect(readFileSync(agents, "utf8")).not.toContain("QoneAgent managed: ponytail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removes a legacy generated AGENTS.md when the managed block is the only content", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-project-instructions-empty-"));
  const agents = path.join(root, "AGENTS.md");
  writeFileSync(agents, "<!-- QoneAgent managed: ponytail:start -->\nPrompt\n<!-- QoneAgent managed: ponytail:end -->\n");
  try {
    await cleanManagedPonytailProjectInstructions(root);
    expect(existsSync(agents)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspaceInstructions loads both AGENTS.md and CLAUDE.md and lets AGENTS.override.md take precedence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-workspace-instructions-"));
  const agents = path.join(root, "AGENTS.md");
  const claude = path.join(root, "CLAUDE.md");
  const override = path.join(root, "AGENTS.override.md");
  writeFileSync(agents, "Agent rules.");
  writeFileSync(claude, "Claude rules.");
  try {
    expect(workspaceInstructions(root)).toEqual([
      { path: agents, content: "Agent rules." },
      { path: claude, content: "Claude rules." },
    ]);
    writeFileSync(override, "Override rules.");
    expect(workspaceInstructions(root)).toEqual([{ path: override, content: "Override rules." }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspaceInstructions is case-sensitive, loads AGENT.md and CLAUDE.md in fixed order, normalizes CRLF, and skips empty files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-workspace-agent-claude-"));
  const lowerRoot = mkdtempSync(path.join(tmpdir(), "qone-workspace-lowercase-"));
  const agent = path.join(root, "AGENT.md");
  const claude = path.join(root, "CLAUDE.md");
  const emptyAgents = path.join(root, "AGENTS.md");
  writeFileSync(agent, "Singular agent rules.\r\nLine 2.");
  writeFileSync(claude, "Claude rules.");
  writeFileSync(emptyAgents, "   \r\n");
  writeFileSync(path.join(lowerRoot, "agent.md"), "Lowercase agent.");
  writeFileSync(path.join(lowerRoot, "claude.md"), "Lowercase claude.");
  try {
    expect(workspaceInstructions(lowerRoot)).toEqual([]);
    expect(workspaceInstructions(root)).toEqual([
      { path: agent, content: "Singular agent rules.\nLine 2." },
      { path: claude, content: "Claude rules." },
    ]);
    writeFileSync(emptyAgents, "Plural agents rules.");
    expect(workspaceInstructions(root)).toEqual([
      { path: emptyAgents, content: "Plural agents rules." },
      { path: agent, content: "Singular agent rules.\nLine 2." },
      { path: claude, content: "Claude rules." },
    ]);
    expect(workspaceInstructions(path.join(root, "missing"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(lowerRoot, { recursive: true, force: true });
  }
});
