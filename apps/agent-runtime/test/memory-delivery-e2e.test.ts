import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDb, ConfigFile, MessageRepo, ModelConfigRepo, openDb, PreferencesRepo, SessionRepo, SettingsRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { MemoryStore } from "../src/memory/memory-store";
import { parseAutomaticPreferences } from "../src/memory/memory-automatic-preferences";

type Payload = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
const latest = (payload: Payload) => JSON.stringify(payload.messages.findLast((item) => item.role === "user")?.content);
const assertPrefix = (next: Payload, previous: Payload) => {
  expect(JSON.stringify(next.messages.slice(0, previous.messages.length))).toBe(JSON.stringify(previous.messages));
  // This includes tool definitions and every other serialized request option.
  expect(JSON.stringify({ ...next, messages: undefined })).toBe(JSON.stringify({ ...previous, messages: undefined }));
};

function start(directory: string, database: string) {
  const child = Bun.spawn([Bun.which("bun")!, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, QONE_DATA_DIR: directory, QONE_DB: database, APPDATA: directory,
      QONE_LOG_DIR: path.join(directory, "logs"), QONE_PLUGINS_DIR: path.join(directory, "plugins") },
  });
  const events: RuntimeEvent[] = [];
  const output = (async () => {
    const decode = new TextDecoder();
    let buffer = "";
    for await (const bytes of child.stdout) {
      buffer += decode.decode(bytes, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines.filter((line) => line.trim())) {
        const event = JSON.parse(line);
        events.push(...(Array.isArray(event) ? event : [event]));
      }
    }
  })();
  const stderr = new Response(child.stderr).text();
  return {
    async request<T extends RuntimeEvent["type"]>(command: RuntimeCommand, type: T, match: (e: Extract<RuntimeEvent, { type: T }>) => boolean = () => true) {
      const from = events.length;
      child.stdin.write(JSON.stringify(command) + "\n"); await child.stdin.flush();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const window = events.slice(from);
        const found = window.find((event) => event.type === type && match(event as Extract<RuntimeEvent, { type: T }>));
        if (found) return found as Extract<RuntimeEvent, { type: T }>;
        if (window.some((event) => event.type === "error" && "requestId" in command && event.requestId === command.requestId
          || event.type === "agent.event" && event.event.type === "agent.failed")) break;
        await Bun.sleep(10);
      }
      throw new Error(`No ${type} for ${command.type}: ${JSON.stringify(events.slice(from).filter((event) => event.type === "agent.event" || event.type === "error").slice(-4))}`);
    },
    async close() { child.kill(); await child.exited; await output; await stderr; },
  };
}

test("scoped preference deltas and explicit continuation preserve serialized request prefixes through restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qone-memory-delivery-"));
  const database = path.join(directory, "agent.db");
  const requests: Payload[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [] });
    const payload = await request.json() as Payload;
    const id = `chatcmpl-memory-${requests.push(payload)}`;
    const stream = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const lookup = payload.tools?.some((tool) => tool.function.name === "qone_memory")
      && latest(payload)?.includes("Bring the old validation evidence forward") && payload.messages.at(-1)?.role === "user";
    const result = lookup ? stream({ role: "assistant", tool_calls: [{ index: 0, id: "old-validation", type: "function",
      function: { name: "qone_memory", arguments: JSON.stringify({ action: "search_conversations", query: "previous validation" }) } }] }, null) + stream({}, "tool_calls")
      : stream({ role: "assistant", content: "Verified response" }, null) + stream({}, "stop");
    return new Response(result + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  let runtime: ReturnType<typeof start> | undefined;
  try {
    const config = new ConfigFile(path.join(directory, "settings.json"));
    const prefs = new PreferencesRepo(config);
    prefs.set("memory.enabled", true);
    prefs.set("memory.model", "unavailable/m"); // Ordinary summaries are independent; do not route them through the chat fixture.
    new ModelConfigRepo(config).upsert({ provider: "local", model: "m", enabled: true, config: {
      apiType: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, thinking: "none", autoMetadata: false,
      contextWindow: 128000, maxTokens: 4096, input: ["text"], output: ["text"],
    } });
    const workA = path.join(directory, "A"); const workB = path.join(directory, "B");
    await Promise.all([mkdir(workA), mkdir(workB)]);
    const projectRule = "Locate the actual root cause; do not build an installer.";
    await writeFile(path.join(workA, "AGENTS.md"), `# Local project rules\n\n- ${projectRule}\n`, "utf8");
    const db = openDb(database);
    const [a, b] = [workA, workB].map((root) => new WorkspaceRepo(db).upsert(path.basename(root), root));
    const repo = new SessionRepo(db);
    const oldA = repo.create("Old task", a!.id); const oldB = repo.create("Other task", b!.id);
    new MessageRepo(db).add(oldA.id, "user", "previous validation EVIDENCE_ONLY_A");
    new MessageRepo(db).add(oldB.id, "user", "previous validation EVIDENCE_ONLY_B");
    const currentA = repo.create("Current A", a!.id); const currentB = repo.create("Current B", b!.id);
    const memory = new MemoryStore(new SettingsRepo(db));
    memory.putSummaries(Object.fromEntries([oldA, oldB].map((old, i) => [old.id, { id: old.id, title: old.title,
      content: `PENDING_TASK_${i}: verify remaining test`, generatedAt: Date.now(), sourceUpdatedAt: old.updatedAt }])));
    const evidence = "previous validation EVIDENCE_ONLY_A";
    const automatic = parseAutomaticPreferences([{ content: "AUTOMATIC_PREFERENCE", scope: "workspace", basis: "explicit",
      evidence: [{ id: oldA.id, quote: evidence }] }], new Map([[oldA.id, { id: oldA.id, workspaceId: a!.id, excerpts: [evidence] }]]))[0]!;
    memory.setOverview({ content: "WHOLE_OVERVIEW_DO_NOT_SEND", generatedAt: Date.now(), fingerprint: "seed", automaticPreferences: [automatic] });
    closeDb(db);
    runtime = start(directory, database);
    await runtime.request({ type: "secret.set", requestId: "key", key: "model.apiKey:local", value: "local-fixture" }, "secret.saved");
    const save = (requestId: string, content: string, preference?: { workspaceId?: string }, id?: string) => runtime!.request(
      { type: "memory.note.save", requestId, content, preference, id }, "memory.state", (event) => event.requestId === requestId);
    await save("note", "PLAIN_NOTE_DO_NOT_SEND");
    await save("global", "GLOBAL_PREFERENCE", {});
    const scoped = await save("a", "A_ONLY_PREFERENCE", { workspaceId: a!.id });
    const preferenceId = scoped.state.notes.find((note) => note.content === "A_ONLY_PREFERENCE")!.id;
    await save("rule", projectRule, { workspaceId: a!.id });
    await save("a-third", "A_THIRD_PREFERENCE", { workspaceId: a!.id });
    await save("a-fourth", "A_FOURTH_PREFERENCE", { workspaceId: a!.id });
    await save("b", "B_ONLY_PREFERENCE", { workspaceId: b!.id });
    const turn = async (sessionId: string, message: string) => {
      const from = requests.length;
      await runtime!.request({ type: "agent.run", requestId: crypto.randomUUID(), sessionId, message, model: "local/m", permissionMode: "full" }, "agent.event",
        (event) => event.event.type === "agent.completed" && event.event.sessionId === sessionId);
      expect(requests.length).toBe(from + 1);
      return requests[from]!;
    };
    const first = await turn(currentA.id, "修一下这个 Bug");
    expect(latest(first)).toContain("A_ONLY_PREFERENCE");
    expect(latest(first)).toContain("A_FOURTH_PREFERENCE");
    expect(latest(first)).toContain("GLOBAL_PREFERENCE");
    expect(latest(first)).toContain("AUTOMATIC_PREFERENCE");
    expect(latest(first)).toContain('\\"automatic\\":true');
    expect(latest(first)).not.toContain(evidence);
    expect(JSON.stringify(first)).not.toContain("qoneMemoryPreferences");
    expect(JSON.stringify(first.messages)).toContain(projectRule);
    expect(latest(first)).not.toContain(projectRule);
    for (const absent of ["B_ONLY_PREFERENCE", "PLAIN_NOTE_DO_NOT_SEND", "WHOLE_OVERVIEW_DO_NOT_SEND", "PENDING_TASK_"]) expect(JSON.stringify(first)).not.toContain(absent);
    const second = await turn(currentA.id, "看看剩下的验证项");
    assertPrefix(second, first);
    expect(latest(second)).not.toContain("<qone-memory>");
    const edited = await runtime.request({ type: "memory.preference.edit", requestId: "edit", id: automatic.id,
      value: { content: "EDITED_PREFERENCE", preference: { workspaceId: a!.id } } }, "memory.state", (event) => event.requestId === "edit");
    expect(edited.state.automaticPreferences).toEqual([]);
    expect(edited.state.notes.find(({ content }) => content === "EDITED_PREFERENCE")?.preference).toEqual({ workspaceId: a!.id });
    await save("changed", "A_UPDATED_PREFERENCE", { workspaceId: a!.id }, preferenceId);
    const third = await turn(currentA.id, "继续昨天没做完的部分");
    assertPrefix(third, second);
    expect(latest(third)).toContain("A_UPDATED_PREFERENCE");
    expect(latest(third)).toContain("EDITED_PREFERENCE");
    expect(latest(third)).toContain(`\\"${automatic.id}\\":null`);
    for (const absent of ["A_ONLY_PREFERENCE", "GLOBAL_PREFERENCE", "PENDING_TASK_", "AUTOMATIC_PREFERENCE"]) expect(latest(third)).not.toContain(absent);
    const other = await turn(currentB.id, "Check this workspace");
    expect(latest(other)).toContain("B_ONLY_PREFERENCE");
    expect(latest(other)).toContain("GLOBAL_PREFERENCE");
    expect(JSON.stringify(other)).not.toContain("A_UPDATED_PREFERENCE");
    expect(JSON.stringify(other)).not.toContain("EDITED_PREFERENCE");
    expect(JSON.stringify(other)).not.toContain("AUTOMATIC_PREFERENCE");
    const wrong = await runtime.request({ type: "session.create", requestId: "wrong", workspaceId: b!.id, resumeFrom: oldA.id }, "error", (event) => event.requestId === "wrong");
    expect(wrong).toMatchObject({ type: "error" });
    const resume = await runtime.request({ type: "session.create", requestId: "resume", workspaceId: a!.id, resumeFrom: oldA.id }, "session.created");
    await runtime.close(); runtime = start(directory, database);
    await runtime.request({ type: "secret.set", requestId: "restarted-key", key: "model.apiKey:local", value: "local-fixture" }, "secret.saved");
    const afterRestart = await turn(currentA.id, "Runtime has restarted");
    assertPrefix(afterRestart, third);
    expect(latest(afterRestart)).not.toContain("<qone-memory>");
    const resumed = await turn(resume.session.id, "What should I verify next?");
    expect(latest(resumed)).toContain("PENDING_TASK_0");
    expect(latest(resumed)).toContain(oldA.id);
    expect(latest(resumed)).not.toContain("PENDING_TASK_1");
    const normal = await turn(resume.session.id, "Now check the evidence");
    assertPrefix(normal, resumed);
    expect(latest(normal)).not.toContain("PENDING_TASK_");
    const lookupStart = requests.length;
    await runtime.request({ type: "agent.run", requestId: "lookup", sessionId: resume.session.id, message: "Bring the old validation evidence forward", model: "local/m", permissionMode: "full" },
      "agent.event", (event) => event.event.type === "agent.completed" && event.event.sessionId === resume.session.id);
    const lookup = requests.slice(lookupStart);
    expect(lookup).toHaveLength(2);
    assertPrefix(lookup[1]!, lookup[0]!);
    expect(JSON.stringify(lookup[1]!.messages.at(-1))).toContain("EVIDENCE_ONLY_A");
    expect(JSON.stringify(lookup[1]!.messages.at(-1))).not.toContain("EVIDENCE_ONLY_B");
    await runtime.request({ type: "session.compact", requestId: "compact", sessionId: resume.session.id, model: "local/m" }, "session.compacted");
    const afterCompaction = await turn(resume.session.id, "Continue after compaction");
    expect(latest(afterCompaction)).toContain("A_UPDATED_PREFERENCE");
    expect(latest(afterCompaction)).toContain("GLOBAL_PREFERENCE");
    expect(latest(afterCompaction)).not.toContain("PENDING_TASK_");
    await runtime.request({ type: "memory.note.delete", requestId: "remove", id: preferenceId }, "memory.state", (event) => event.requestId === "remove");
    const revoked = await turn(currentA.id, "Check the updated defaults");
    assertPrefix(revoked, afterRestart);
    expect(latest(revoked)).toContain(`\\"${preferenceId}\\":null`);
    const off = await runtime.request({ type: "memory.enabled.set", requestId: "off", enabled: false }, "memory.state", (event) => event.requestId === "off");
    expect(off.state.enabled).toBe(false);
    expect(latest(await turn(currentA.id, "No new memories here"))).not.toContain("<qone-memory>");
  } finally {
    if (runtime) await runtime.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 60_000);
