import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactRepo, SessionRepo, openDb } from "@qone/database";
import { FileDelivery } from "../src/file-delivery";

test("delivered files are referenced in place with any type, re-delivery moves the card, and delete frees the disk", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-delivery-"));
  const db = openDb(":memory:");
  const created: unknown[] = [];
  const deleted: string[] = [];
  try {
    const session = new SessionRepo(db).create("Delivery");
    const repo = new ArtifactRepo(db);
    const delivery = new FileDelivery(repo, (type, payload) => { if (type === "artifact.created") created.push(payload); }, (event) => deleted.push(event.artifactId));
    await writeFile(path.join(directory, "clip.mp4"), new Uint8Array(4096));
    await writeFile(path.join(directory, "model.blend"), "x");
    await mkdir(path.join(directory, "site"));
    await writeFile(path.join(directory, "site", "index.html"), "<p>");

    const files = await delivery.deliver(session.id, "run-1", ["clip.mp4", "model.blend", "site", "clip.mp4"], directory);
    expect(files.map((file) => [file.name, file.type])).toEqual([["clip.mp4", "video"], ["model.blend", "file"], ["site", "folder"]]);
    expect(files[0]).toMatchObject({ mimeType: "video/mp4", size: 4096, runId: "run-1" });
    // Referenced where it was made: the stored path is the original file, never a copy.
    expect(files[0]!.path).toBe(await realpath(path.join(directory, "clip.mp4")));
    expect(created).toHaveLength(3);

    const [again] = await delivery.deliver(session.id, "run-2", [path.join(directory, "clip.mp4")], directory);
    expect(deleted).toEqual([files[0]!.id]);
    expect(repo.listBySession(session.id).filter((row) => row.name === "clip.mp4").map((row) => row.runId)).toEqual(["run-2"]);

    await delivery.delete(session.id, again!.id, "request");
    await delivery.delete(session.id, files[2]!.id);
    expect(existsSync(path.join(directory, "clip.mp4"))).toBe(false);
    expect(existsSync(path.join(directory, "site"))).toBe(false);
    expect(repo.listBySession(session.id).map((row) => row.name)).toEqual(["model.blend"]);
    await expect(delivery.deliver(session.id, "run-3", ["missing.bin"], directory)).rejects.toThrow();
  } finally {
    db.$client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
