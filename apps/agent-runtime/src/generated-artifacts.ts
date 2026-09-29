import { createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactRepo } from "@qone/database";
import { createLogger } from "@qone/shared";

const log = createLogger("generated-artifacts");
type ArtifactRow = ReturnType<ArtifactRepo["listBySession"]>[number];

export class GeneratedArtifacts {
  private directory: string;

  constructor(private repo: ArtifactRepo, databaseDirectory: string) {
    this.directory = path.join(databaseDirectory, "artifacts");
  }

  async save(input: {
    sessionId: string;
    runId: string;
    data: Uint8Array | ReadableStream<Uint8Array>;
    mimeType: string;
    extension: string;
    signal: AbortSignal;
  }): Promise<ArtifactRow> {
    const { sessionId, runId, data, mimeType, extension, signal } = input;
    signal.throwIfAborted();
    if (!/^[a-z0-9]{2,8}$/.test(extension)) throw new Error("无效的媒体文件格式");
    const id = crypto.randomUUID();
    const filePath = path.join(this.directory, `${id}.${extension}`);
    await mkdir(this.directory, { recursive: true });
    try {
      if (data instanceof Uint8Array) await writeFile(filePath, data, { flag: "wx", signal });
      else await pipeline(Readable.fromWeb(data as never), createWriteStream(filePath, { flags: "wx" }), { signal });
      signal.throwIfAborted();
      const size = (await stat(filePath)).size;
      if (!size) throw new Error("媒体生成接口返回了空文件");
      const saved = this.repo.add({ id, sessionId, runId, type: mimeType.startsWith("audio/") ? "audio" : "video",
        name: mimeType.startsWith("audio/") ? `speech.${extension}` : `video.${extension}`, path: filePath, mimeType, size });
      if (signal.aborted) {
        this.repo.delete(id);
        signal.throwIfAborted();
      }
      return saved;
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
  }

  async removeRuns(sessionId: string, runIds: string[]): Promise<void> {
    await this.removeFiles(this.repo.deleteByRunIds(sessionId, runIds));
  }

  async removeFiles(rows: readonly ArtifactRow[]): Promise<void> {
    const owned = rows.filter((row) => path.dirname(path.resolve(row.path)) === path.resolve(this.directory));
    await Promise.all(owned.map((row) => rm(row.path, { force: true })
      .catch((error) => log.warn("failed to remove generated media", { path: row.path, error: String(error) }))));
  }
}
