import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { qoneProjectDir, qoneProjectsDir, qoneSessionDir } from "@qone/shared";
import type { SessionInfo, WorkspaceInfo } from "@qone/protocol";

/** SQLite owns metadata; these small projections make resource folders identifiable. */
export class ProjectResources {
  private readonly written = new Map<string, string>();
  private readonly ensuredDirs = new Set<string>();
  constructor(readonly root = qoneProjectsDir()) {}

  project(workspace: WorkspaceInfo): void {
    const file = path.join(qoneProjectDir(workspace.id, this.root), "project.json");
    const key = JSON.stringify([workspace.id, workspace.name, workspace.path]);
    if (this.written.get(file) === key) return;
    this.write(file, workspace, key);
  }

  session(session: SessionInfo): string {
    const directory = this.sessionDirectory(session.workspaceId, session.id);
    const file = path.join(directory, "session.json");
    // 仅在会话标识或标题等结构信息变更时落盘，避免每次 touchSession/session.list 反复同步写盘。
    const key = JSON.stringify([session.id, session.title, session.workspaceId ?? null, session.sideChat ?? null]);
    if (this.written.get(file) !== key) this.write(file, session, key);
    if (!this.ensuredDirs.has(directory)) {
      for (const name of ["attachments", "artifacts"]) mkdirSync(path.join(directory, name), { recursive: true });
      this.ensuredDirs.add(directory);
    }
    return directory;
  }

  sessionDirectory(projectId: string | undefined | null, sessionId: string): string {
    return qoneSessionDir(projectId ?? "unassigned", sessionId, this.root);
  }

  removeSession(projectId: string | undefined | null, sessionId: string): Promise<void> {
    const directory = this.sessionDirectory(projectId, sessionId);
    this.written.delete(path.join(directory, "session.json"));
    this.ensuredDirs.delete(directory);
    // The path comes from encoded IDs under our own root, never from the source workspace.
    return rm(directory, { recursive: true, force: true });
  }

  removeProjectMetadata(projectId: string): void {
    const file = path.join(qoneProjectDir(projectId, this.root), "project.json");
    this.written.delete(file);
    rmSync(file, { force: true });
  }

  private write(file: string, value: unknown, cacheKey: string): void {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    try {
      if (readFileSync(file, "utf8") === content) {
        this.written.set(file, cacheKey);
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { flag: "wx" });
      renameSync(temporary, file);
      this.written.set(file, cacheKey);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
