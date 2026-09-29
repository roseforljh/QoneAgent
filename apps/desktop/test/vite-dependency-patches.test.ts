import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyPatches, readDependencyPatches } from "../scripts/vite-dependency-patches";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qone-patch-cache-"));
  directories.push(root);
  mkdirSync(join(root, "patches"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ patchedDependencies: { "example@1": "patches/example.patch" } }));
  const patch = join(root, "patches/example.patch");
  writeFileSync(patch, "old patch");
  return { root, patch };
}

test("editing patch contents invalidates Vite's config hash even when timestamps are unchanged", () => {
  const { root, patch } = fixture();
  const before = dependencyPatches(root).name;
  const fileStat = statSync(patch);
  const directoryStat = statSync(join(root, "patches"));
  writeFileSync(patch, "new patch");
  utimesSync(patch, fileStat.atime, fileStat.mtime);
  utimesSync(join(root, "patches"), directoryStat.atime, directoryStat.mtime);
  expect(dependencyPatches(root).name).not.toBe(before);
});

test("unchanged patches reuse the cache and all declared inputs are watched", () => {
  const { root, patch } = fixture();
  const before = readDependencyPatches(root);
  expect(before.files).toEqual([join(root, "package.json"), patch]);
  writeFileSync(join(root, "patches", "README.md"), "documentation only");
  expect(readDependencyPatches(root).fingerprint).toBe(before.fingerprint);
});
