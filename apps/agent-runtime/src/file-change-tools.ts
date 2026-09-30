import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import type { ToolFileChange } from "@qone/protocol";

/** Instrument the SDK's filesystem operations, inside its existing mutation
 * queue, not guessed names/results or a workspace-wide Git diff. Each execute
 * owns its evidence so parallel calls cannot share a stale snapshot.
 */
export function createFileChangeTools(cwd: string) {
  const edit = createEditTool(cwd);
  const write = createWriteTool(cwd);
  type FileTool = typeof edit | typeof write;

  function tracked<T extends FileTool>(base: T, create: (changes: ToolFileChange[]) => T): T {
    return {
      ...base,
      execute: async (...args: Parameters<T["execute"]>) => {
        const changes: ToolFileChange[] = [];
        try {
          const [id, params, signal, onUpdate] = args;
          const result = await create(changes).execute(id, params as never, signal, onUpdate);
          return { ...result, details: { ...result.details, fileChanges: changes } };
        } catch (error) {
          // A cancellation can arrive after a successful disk write. Preserve
          // that actual mutation without relabelling the failed tool success.
          if (!changes.length) throw error;
          return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: { fileChanges: changes }, isError: true };
        }
      },
    } as T;
  }

  async function evidence(file: string, oldContent: string | null, newContent: string) {
    // realpath also unifies relative/absolute paths and symlink aliases.
    const canonical = await realpath(file).catch(() => file);
    return { path: canonical, oldContent, newContent };
  }

  return [
    tracked(edit, (changes) => {
      let before: string;
      return createEditTool(cwd, { operations: {
        access: (file) => access(file, constants.R_OK | constants.W_OK),
        readFile: async (file) => {
          const buffer = await readFile(file);
          before = buffer.toString("utf8");
          return buffer;
        },
        writeFile: async (file, content) => {
          await writeFile(file, content, "utf8");
          changes.push(await evidence(file, before, content));
        },
      } });
    }),
    tracked(write, (changes) => createWriteTool(cwd, { operations: {
      mkdir: async (dir) => { await mkdir(dir, { recursive: true }); },
      writeFile: async (file, content) => {
        let before: string | null | undefined;
        try { before = await readFile(file, "utf8"); }
        catch (error) {
          // An unreadable baseline is not an empty file. Do not invent counts
          // or prevent an otherwise permitted write.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") before = null;
        }
        await writeFile(file, content, "utf8");
        if (before !== undefined) changes.push(await evidence(file, before, content));
      },
    } })),
  ];
}
