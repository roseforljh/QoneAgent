import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, ConfigFile, ExecutionIncidentRepo, ExecutionLessonRepo, ExecutionUsageRepo, openDb, PreferencesRepo, RunRepo, SessionRepo, ToolCallRepo } from "@qone/database";
import { ExecutionRecorder } from "../src/execution-recorder.js";
import { ExecutionStats } from "../src/execution-stats.js";
import { MemoryIncidents } from "../src/memory/memory-incidents.js";

test("global recording attributes all models; memory only gets new authorized metadata and drops revoked replies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qone-execution-test-"));
  const db = openDb(":memory:");
  const incidents = new ExecutionIncidentRepo(db);
  const lessons = new ExecutionLessonRepo(db);
  const usage = new ExecutionUsageRepo(db);
  const runs = new RunRepo(db);
  const session = new SessionRepo(db).create("Fixture");
  let now = 100;
  const time = () => ++now;
  const prefs = new PreferencesRepo(new ConfigFile(join(dir, "settings.json")));
  prefs.set("execution.memory.analysis", true); // Old pause flag cannot authorize access for all models.
  prefs.set("execution.incident.analysis:test/m", { provider: "test", model: "m", since: 1 });
  const recorder: ExecutionRecorder = new ExecutionRecorder(incidents, runs, () => stats.recordEnabled());
  const stats: ExecutionStats = new ExecutionStats({ usage, incidents, lessons, recorder, models: () => [{ provider: "test", model: "m" }],
    prefs, onChange: () => analysis.invalidate(), onError: (err) => { throw err; } }, time);
  const prompts: string[] = [];
  let hold: ReturnType<typeof Promise.withResolvers<{ text: string; tokens: number }>> | undefined;
  const analysis: MemoryIncidents = new MemoryIncidents({ stats, permission: () => stats.memoryAccess() ? "on" : undefined,
    complete: () => async (_system, prompt) => { prompts.push(prompt); return hold?.promise ?? { text: '["rg-path"]', tokens: 1 }; }, onError: (err) => { throw err; } });
  try {
    const run = runs.create(session.id), other = runs.create(session.id);
    runs.setModel(run.id, "test/m");
    runs.setModel(other.id, "another-provider/m"); // Records without any model configuration entry.
    const fail = (runId = run.id) => recorder.toolFailed(runId, crypto.randomUUID(), "powershell", { content: [{ type: "text", text: "Cannot find path PRIVATE_OUTPUT" }] }, time());
    const count = () => incidents.counts(0).reduce((total, row) => total + row.count, 0);
    const advice = (command = "rg needle src/*.ts") => analysis.advice("test", "m", "powershell", { command });
    expect(stats.state("today")).toMatchObject({ recording: true, memoryAccess: false });
    fail(); fail(); fail(other.id); fail(other.id);
    await analysis.check();
    expect(count()).toBe(4);
    expect(incidents.counts(0).map(({ provider, model, count }) => [provider, model, count]))
      .toEqual([["another-provider", "m", 2], ["test", "m", 2]]);
    expect(prompts).toHaveLength(0);
    stats.setRecord(false);
    fail(); fail(other.id);
    expect(count()).toBe(4);
    stats.setMemoryAccess(true);
    expect(stats.state("today")).toMatchObject({ recording: false, memoryAccess: true });
    stats.setRecord(true);
    await analysis.check();
    expect(prompts).toHaveLength(0);
    fail(); fail();
    hold = Promise.withResolvers();
    const work = analysis.check();
    expect(prompts).toHaveLength(1);
    stats.setMemoryAccess(false);
    stats.setMemoryAccess(true);
    hold.resolve({ text: '["rg-path"]', tokens: 1 });
    await work;
    expect(advice()).toBeUndefined();
    hold = undefined;
    fail(); fail(); fail(other.id); fail(other.id);
    const timer = spyOn(globalThis, "setInterval");
    let tick: () => void;
    try {
      analysis.start(); // launch runs immediately
      const [callback, interval] = timer.mock.calls[0]!;
      expect(interval).toBe(4 * 60 * 60_000);
      tick = callback as () => void;
    } finally { timer.mockRestore(); }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(advice()).toContain("pass a real directory");
    expect(analysis.advice("another-provider", "m", "powershell", { command: "rg needle src/*.ts" })).toContain("pass a real directory");
    expect(advice("rg needle src")).toBeUndefined();
    tick!();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(prompts).toHaveLength(3);
    expect(JSON.stringify(prompts)).not.toContain("PRIVATE_OUTPUT");
    const analyzed = prompts.map(prompt => JSON.parse(prompt));
    expect(analyzed.slice(1).map(item => [item.provider, item.candidates[0].count]).sort()).toEqual([["another-provider", 2], ["test", 2]]);
    stats.setMemoryAccess(false);
    expect(advice()).toBeUndefined();
    fail();
    expect(count()).toBe(11);
    stats.setMemoryAccess(true);
    expect(advice()).toBeUndefined(); // Old advice cannot become active under the new grant.
    await analysis.check();
    expect(prompts).toHaveLength(3);
    new ToolCallRepo(db).start(run.id, "powershell", {}, "interrupted");
    stats.setRecord(false);
    stats.recover();
    const recovered = () => db.$client.prepare("SELECT provider,reason FROM execution_incidents WHERE outcome='interrupted'").all();
    expect(recovered()).toEqual([]);
    stats.setRecord(true);
    stats.recover();
    const rows = recovered();
    expect(rows.map(row => row.provider)).toContain("another-provider");
    expect(rows.every((row) => row.reason === "outcome-unknown")).toBe(true);
    expect(JSON.stringify(db.$client.prepare("SELECT * FROM execution_incidents").all())).not.toContain("PRIVATE_OUTPUT");
    const sample = { provider: "test", model: "m", cache: "reported" as const, input: 50, output: 5, cacheRead: 20, cacheWrite: 30 };
    const sampledAt = time();
    stats.observe(undefined, sample, "memory", sampledAt);
    stats.observe(undefined, sample, "memory", sampledAt);
    stats.observe(undefined, { ...sample, cache: "unknown", input: 1000 }, "chat", sampledAt);
    const usageStats = stats.state("today").period;
    expect(usageStats.total.requests).toBe(3);
    expect(usageStats.total.cacheHitRate).toBe(20);
    expect(usageStats.sources.map(({ source, total }) => [source, total.cacheHitRate])).toEqual([["chat", undefined], ["memory", 20]]);
  } finally { analysis.close(); stats.close(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
