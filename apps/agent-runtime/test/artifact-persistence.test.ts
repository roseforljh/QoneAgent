import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactRepo, SessionRepo, openDb } from "@qone/database";
import { GeneratedArtifacts } from "../src/generated-artifacts";

test("generated artifact keeps its run association after reopening the database", () => {
  const first = openDb(":memory:");
  const session = new SessionRepo(first).create("Speech", undefined);
  const saved = new ArtifactRepo(first).add({ sessionId: session.id, runId: "run-1", type: "audio", name: "speech.mp3", path: "C:\\media\\speech.mp3", mimeType: "audio/mpeg", size: 4 });
  const snapshot = first.$client.serialize();
  first.$client.close();
  const reopened = openDb(":memory:", { open: () => Database.deserialize(snapshot) });
  const [artifact] = new ArtifactRepo(reopened).listBySession(session.id);
  expect(artifact).toMatchObject({ id: saved.id, runId: "run-1", type: "audio", mimeType: "audio/mpeg", size: 4 });
  expect(new ArtifactRepo(reopened).deleteByRunIds(session.id, ["other-run"])).toEqual([]);
  expect(new ArtifactRepo(reopened).deleteByRunIds(session.id, ["run-1"])).toHaveLength(1);
  expect(new ArtifactRepo(reopened).listBySession(session.id)).toEqual([]);
  reopened.$client.close();
});

test("existing artifact tables gain a nullable run ID column", () => {
  const legacy = new Database(":memory:");
  legacy.exec("CREATE TABLE artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT, size INTEGER, created_at INTEGER NOT NULL)");
  const db = openDb(":memory:", { open: () => legacy });
  const columns = db.$client.query("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
  expect(columns.some((column) => column.name === "run_id")).toBe(true);
  db.$client.close();
});

test("generated video streams to disk and is removed with its run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-artifact-test-"));
  const db = openDb(":memory:");
  try {
    const session = new SessionRepo(db).create("Video");
    const generated = new GeneratedArtifacts(new ArtifactRepo(db), directory);
    const payload = new Uint8Array([0, 1, 2, 3]);
    const saved = await generated.save({ sessionId: session.id, runId: "video-run", data: new Response(payload).body!, mimeType: "video/mp4", extension: "mp4", signal: new AbortController().signal });
    expect(new Uint8Array(await readFile(saved.path))).toEqual(payload);
    expect(saved.size).toBe(payload.byteLength);
    await generated.removeRuns(session.id, ["video-run"]);
    expect(existsSync(saved.path)).toBe(false);
    expect(new ArtifactRepo(db).listBySession(session.id)).toEqual([]);
  } finally {
    db.$client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelling a video download removes the partial generated file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-artifact-cancel-"));
  const db = openDb(":memory:");
  try {
    const session = new SessionRepo(db).create("Video");
    const generated = new GeneratedArtifacts(new ArtifactRepo(db), directory);
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(sink) { sink.enqueue(new Uint8Array([0, 1])); setTimeout(() => controller.abort(), 30); },
    });
    await expect(generated.save({ sessionId: session.id, runId: "cancelled", data: stream, mimeType: "video/mp4", extension: "mp4", signal: controller.signal })).rejects.toThrow();
    expect(new ArtifactRepo(db).listBySession(session.id)).toEqual([]);
    expect(await (await import("node:fs/promises")).readdir(path.join(directory, "artifacts"))).toEqual([]);
  } finally {
    db.$client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
