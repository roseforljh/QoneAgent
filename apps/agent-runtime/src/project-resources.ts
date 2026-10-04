import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { qoneProjectDir, qoneProjectsDir, qoneSessionDir } from "@qone/shared";
import type { SessionInfo, WorkspaceInfo } from "@qone/protocol";

/** SQLite owns metadata; these small projections make resource folders identifiable. */
export class ProjectResources {
  constructor(readonly root = qoneProjectsDir()) {}

  project(workspace: WorkspaceInfo): void {
    this.write(path.join(qoneProjectDir(workspace.id, this.root), "project.json"), workspace);
  }

  session(session: SessionInfo): string {
    const directory = this.sessionDirectory(session.workspaceId, session.id);
    this.write(path.join(directory, "session.json"), session);
    for (const name of ["attachments", "artifacts"]) mkdirSync(path.join(directory, name), { recursive: true });
    return directory;
  }

  sessionDirectory(projectId: string | undefined | null, sessionId: string): string {
    return qoneSessionDir(projectId ?? "unassigned", sessionId, this.root);
  }

  removeSession(projectId: string | undefined | null, sessionId: string): void {
    // The path comes from encoded IDs under our own root, never from the source workspace.
    rmSync(this.sessionDirectory(projectId, sessionId), { recursive: true, force: true });
  }

  removeProjectMetadata(projectId: string): void {
    rmSync(path.join(qoneProjectDir(projectId, this.root), "project.json"), { force: true });
  }

  private write(file: string, value: unknown): void {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    try {
      if (readFileSync(file, "utf8") === content) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { flag: "wx" });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
