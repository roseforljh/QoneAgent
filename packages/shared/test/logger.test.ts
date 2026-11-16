import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/logger";


/** Async appends land shortly after the call; poll instead of guessing a delay. */
async function waitForLines(file: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  let lines: string[] = [];
  while (Date.now() < deadline) {
    try { lines = readFileSync(file, "utf8").trim().split("\n").filter(line => line.startsWith("{")); } catch { lines = []; }
    if (lines.length >= count) return lines;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return lines;
}

function sandbox() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qone-logger-"));
  const previousDir = process.env.QONE_LOG_DIR;
  const previousMax = process.env.QONE_LOG_MAX_BYTES;
  process.env.QONE_LOG_DIR = directory;
  return {
    directory,
    file: path.join(directory, "runtime.log"),
    restore: () => {
      if (previousDir === undefined) delete process.env.QONE_LOG_DIR;
      else process.env.QONE_LOG_DIR = previousDir;
      if (previousMax === undefined) delete process.env.QONE_LOG_MAX_BYTES;
      else process.env.QONE_LOG_MAX_BYTES = previousMax;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("log lines reach the file asynchronously and keep the JSON shape", async () => {
  const box = sandbox();
  try {
    const log = createLogger("test-module");
    log.info("hello", { sessionId: "s1" });
    log.error("boom");
    const lines = (await waitForLines(box.file, 2)).map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: "info", module: "test-module", msg: "hello", sessionId: "s1" });
    expect(lines[1]).toMatchObject({ level: "error", msg: "boom" });
    expect(typeof lines[0].timestamp).toBe("number");
  } finally { box.restore(); }
});

test("the file rotates at the configured cap instead of growing without bound", async () => {
  const box = sandbox();
  try {
    process.env.QONE_LOG_MAX_BYTES = "2048";
    // Existing content counts toward the cap, so the next line rotates.
    writeFileSync(box.file, "x".repeat(2040), "utf8");
    const log = createLogger("rotate");
    log.info("first line after cap");
    const lines = await waitForLines(box.file, 1);
    expect(lines.join("\n")).toContain("first line after cap");
    expect(existsSync(`${box.file}.1`)).toBe(true);
    expect(statSync(`${box.file}.1`).size).toBe(2040);
    // The previous segment is kept, never deleted.
    expect(readFileSync(`${box.file}.1`, "utf8")).toBe("x".repeat(2040));
    expect(statSync(box.file).size).toBeLessThan(2048);
  } finally { box.restore(); }
});

test("multiple modules share one ordered writer through repeated rotations", async () => {
  const box = sandbox();
  try {
    process.env.QONE_LOG_MAX_BYTES = "512";
    const first = createLogger("first"), second = createLogger("second");
    for (let index = 0; index < 12; index++) {
      const marker = `entry-${index}`;
      (index % 2 ? first : second).info(marker, { value: "x".repeat(100) });
      const deadline = Date.now() + 5_000;
      while (!(await waitForLines(box.file, 1)).some(line => line.includes(`\"${marker}\"`))) {
        if (Date.now() > deadline) throw new Error("log did not rotate");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(statSync(box.file).size).toBeLessThanOrEqual(512);
      if (existsSync(`${box.file}.1`)) expect(statSync(`${box.file}.1`).size).toBeLessThanOrEqual(512);
      for (const file of [box.file, `${box.file}.1`]) if (existsSync(file)) {
        expect(readFileSync(file, "utf8").trim().split("\n").every(line => Boolean(JSON.parse(line)))).toBe(true);
      }
    }
    expect(require("node:fs").readdirSync(box.directory).sort()).toEqual(["runtime.log", "runtime.log.1"]);
  } finally { box.restore(); }
});

test("an unset or invalid cap falls back to the default instead of disabling logs", async () => {
  const box = sandbox();
  try {
    process.env.QONE_LOG_MAX_BYTES = "not-a-number";
    const log = createLogger("default");
    log.warn("still written");
    expect((await waitForLines(box.file, 1)).join("\n")).toContain("still written");
  } finally { box.restore(); }
});
