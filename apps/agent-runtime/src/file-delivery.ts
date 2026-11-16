import { realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ArtifactRepo } from "@qone/database";
import { mediaMimeTypeFromName, type ArtifactInfo } from "@qone/protocol";

type ArtifactRow = ReturnType<ArtifactRepo["listBySession"]>[number];

export const SEND_FILE_TOOL = "qone_send_file";

export function artifactInfo(row: ArtifactRow): ArtifactInfo {
  return { id: row.id, sessionId: row.sessionId, runId: row.runId ?? undefined, type: row.type, name: row.name,
    path: row.path, mimeType: row.mimeType ?? undefined, size: row.size ?? undefined, createdAt: row.createdAt };
}

function kindOf(mimeType: string | undefined, directory: boolean): string {
  if (directory) return "folder";
  const major = mimeType?.split("/", 1)[0];
  return major === "image" || major === "audio" || major === "video" ? major : "file";
}

/**
 * Hands files the agent produced on this machine to the user. Files are
 * referenced in place — never copied or re-downloaded — and no type or size
 * is refused: whatever exists locally can be delivered.
 */
export class FileDelivery {
  constructor(
    private repo: ArtifactRepo,
    private emit: (type: string, payload: unknown, sessionId?: string, runId?: string) => void,
    private send: (event: { type: "artifact.deleted"; requestId?: string; sessionId: string; artifactId: string }) => void,
  ) {}

  async deliver(sessionId: string, runId: string, inputs: readonly string[], cwd: string): Promise<ArtifactInfo[]> {
    const delivered: ArtifactInfo[] = [];
    for (const input of new Set(inputs)) {
      const target = await realpath(path.resolve(cwd, input));
      const info = await stat(target);
      const mimeType = info.isDirectory() ? undefined : mediaMimeTypeFromName(target) ?? (Bun.file(target).type.split(";", 1)[0] || undefined);
      // Delivering the same file again moves its card to the latest answer.
      for (const previous of this.repo.listBySession(sessionId).filter((row) => row.path === target)) {
        this.repo.delete(previous.id);
        this.send({ type: "artifact.deleted", sessionId, artifactId: previous.id });
      }
      const row = artifactInfo(this.repo.add({ sessionId, runId, type: kindOf(mimeType, info.isDirectory()),
        name: path.basename(target), path: target, mimeType, size: info.isDirectory() ? undefined : info.size }));
      this.emit("artifact.created", row, sessionId, runId);
      delivered.push(row);
    }
    return delivered;
  }

  /** Removes the file from disk for real (not to a recycle bin), then its record. */
  async delete(sessionId: string, artifactId: string, requestId?: string): Promise<void> {
    const row = this.repo.get(sessionId, artifactId);
    if (!row) return;
    await rm(row.path, { recursive: true, force: true });
    this.repo.delete(row.id);
    this.send({ type: "artifact.deleted", requestId, sessionId, artifactId });
  }

  tool(sessionId: string, workspacePath: string, activeRunId: () => string | undefined): ToolDefinition {
    return {
      name: SEND_FILE_TOOL,
      label: "Send files to the user",
      description: "Deliver files or folders you created or found on this computer to the user, shown in the chat with inline image, video and audio playback and an open/locate action. Any file type and size works and nothing is uploaded or copied: pass the local paths of finished deliverables. Use it whenever the user should receive a produced file (for example a rendered video, generated audio, an image, a document or an archive) instead of only mentioning its path.",
      parameters: Type.Object({ paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Absolute paths, or paths relative to the workspace." }) }),
      execute: async (_toolCallId, params) => {
        const runId = activeRunId();
        if (!runId) throw new Error("No active run to attach the files to.");
        const files = await this.deliver(sessionId, runId, (params as { paths: string[] }).paths, workspacePath);
        return {
          content: [{ type: "text", text: `Delivered to the user: ${files.map((file) => file.path).join(", ")}` }],
          details: { files },
        };
      },
    };
  }
}
