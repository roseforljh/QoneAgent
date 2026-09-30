import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { RunPermissionMode } from "@qone/protocol";
import { Type } from "typebox";
import { ApprovalQueue, decide, evaluatePermission, withPermission } from "../src/permissions.js";

const modes: RunPermissionMode[] = ["ask", "auto", "full"];
const readTools = ["read", "grep", "find", "ls"];
const workspacePath = path.resolve(".test-data", "access-workspace");
const externalPaths = [
  path.resolve(workspacePath, "../other-project/file.txt"),
  "C:/Program Files/WindowsApps/OpenAI.Codex_26.924.6891.0_x64__2p2nqsd0c76g0/app",
  "D:\\Program Files\\Another Application\\config.json",
  "C:/Windows/System32/drivers/etc/hosts",
];
const textOf = (result: unknown) => (result as { content: Array<{ text?: string }> }).content.map((part) => part.text ?? "").join("\n");
const execute = (tool: ToolDefinition, params: unknown) => tool.execute("access-test", params, undefined, undefined, undefined);

describe("external filesystem access policy", () => {
  for (const mode of modes) {
    test(`${mode}: all read tools allow ordinary external and installation paths`, () => {
      for (const toolName of readTools) {
        for (const target of [...externalPaths, "../other-project/file.txt"]) {
          const ctx = { toolName, workspacePath, args: { path: target } };
          expect(decide(ctx)).toBe("allow");
          expect(evaluatePermission(ctx, mode)).toMatchObject({ decision: "allow", reason: "allowed" });
        }
      }
    });

    test(`${mode}: external mutations retain mode-dependent approval`, () => {
      for (const toolName of ["write", "edit"]) {
        for (const target of [...externalPaths, "../other-project/file.txt"]) {
          const result = evaluatePermission({ toolName, workspacePath, args: { path: target } }, mode);
          expect(result.decision).toBe(mode === "full" ? "allow" : "ask");
          expect(result.reason).toBe(mode === "full" ? "allowed" : "workspace");
        }
      }
    });

    test(`${mode}: explicit deny still blocks external reads and shell`, () => {
      const rules = { get: () => "deny" as const };
      for (const toolName of [...readTools, "powershell"]) {
        expect(evaluatePermission({ toolName, workspacePath, args: { path: externalPaths[0] } }, mode, rules))
          .toMatchObject({ decision: "deny", reason: "rule" });
      }
    });

    test(`${mode}: credential stores remain protected`, () => {
      for (const directory of [".ssh", ".aws", ".gnupg"]) {
        const target = path.join(os.homedir(), directory, "credential");
        for (const toolName of [...readTools, "write", "edit"]) {
          expect(evaluatePermission({ toolName, workspacePath, args: { path: target } }, mode))
            .toMatchObject({ decision: "deny", reason: "protected-path" });
        }
        expect(evaluatePermission({ toolName: "powershell", args: { command: `Get-Content '${target}'` } }, mode))
          .toMatchObject({ decision: "deny", reason: "protected-path" });
      }
    });

    test(`${mode}: installation path commands follow shell approval, not a path blacklist`, () => {
      for (const command of [
        `Get-ChildItem -LiteralPath '${externalPaths[1]}'`,
        "Get-Content C:/Windows/System32/drivers/etc/hosts",
      ]) {
        expect(evaluatePermission({ toolName: "powershell", workspacePath, args: { command } }, mode).decision)
          .toBe(mode === "full" ? "allow" : "ask");
      }
    });
  }

  test("explicit ask rules on reads still request approval", () => {
    for (const mode of ["ask", "auto"] as const) {
      for (const toolName of readTools) {
        expect(evaluatePermission({ toolName, workspacePath, args: { path: externalPaths[0] } }, mode, { get: () => "ask" }).decision)
          .toBe("ask");
      }
    }
  });

  test("explicit allow cannot widen external writes in non-full modes", () => {
    for (const mode of ["ask", "auto"] as const) {
      expect(evaluatePermission({ toolName: "write", workspacePath, args: { path: externalPaths[0] } }, mode, { get: () => "allow" }))
        .toMatchObject({ decision: "ask", reason: "workspace" });
    }
  });

  test("OS access errors propagate unchanged instead of becoming policy denials", async () => {
    const error = Object.assign(new Error("OS access denied"), { code: "EACCES" });
    const tool = withPermission(defineTool({
      name: "read", label: "Read", description: "Read",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => { throw error; },
    }), {
      queue: new ApprovalQueue(), workspacePath,
      emitApproval: () => { throw new Error("Unexpected approval"); },
    });
    await expect(execute(tool, { path: externalPaths[1] })).rejects.toBe(error);
  });
});

describe("wrapped Pi tools outside the imported workspace", () => {
  test("read/grep/find/ls execute for absolute and parent-relative paths in all modes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qone-external-access-"));
    const workspace = path.join(root, "project");
    const external = path.join(root, "other application");
    mkdirSync(workspace);
    mkdirSync(external);
    writeFileSync(path.join(external, "sample.txt"), "external-access-marker\n", "utf8");
    let approvals = 0;
    try {
      for (const mode of modes) {
        const wrap = (tool: ToolDefinition) => withPermission(tool, {
          queue: new ApprovalQueue(), workspacePath: workspace, mode: () => mode,
          emitApproval: () => { approvals++; throw new Error("Unexpected external read approval"); },
        });
        for (const directory of [external, path.relative(workspace, external)]) {
          expect(textOf(await execute(wrap(createReadTool(workspace)), { path: path.join(directory, "sample.txt") })))
            .toContain("external-access-marker");
          expect(textOf(await execute(wrap(createGrepTool(workspace)), { path: directory, pattern: "external-access-marker" })))
            .toContain("sample.txt");
          expect(textOf(await execute(wrap(createFindTool(workspace)), { path: directory, pattern: "**/*.txt" })))
            .toContain("sample.txt");
          expect(textOf(await execute(wrap(createLsTool(workspace)), { path: directory })))
            .toContain("sample.txt");
        }
      }
      expect(approvals).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });

  test("junctions to external directories allow reads without auto-approving external writes", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qone-access-junction-"));
    const workspace = path.join(root, "project");
    const external = path.join(root, "external");
    mkdirSync(workspace);
    mkdirSync(external);
    const link = path.join(workspace, "linked");
    symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(path.join(external, "sample.txt"), "external");
    try {
      const args = { path: path.join(link, "sample.txt") };
      expect(evaluatePermission({ toolName: "read", workspacePath: workspace, args }, "auto").decision).toBe("allow");
      expect(evaluatePermission({ toolName: "write", workspacePath: workspace, args }, "auto"))
        .toMatchObject({ decision: "ask", reason: "workspace" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
