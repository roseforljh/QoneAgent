import { describe, expect, test } from "bun:test";
import os from "node:os";
import { createPowerShellTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BackgroundShellJobInfo } from "@qone/protocol";
import { BackgroundShellJobs, BACKGROUND_SHELL_MARKER, type BackgroundNotice } from "../src/background-shell";
import { isSubagentUpdatePrompt } from "../src/subagent-notifications";

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]!.text);

function setup(state: { live?: boolean; busy?: number }) {
  const events: { kind: string; notice: Partial<BackgroundNotice>; options?: unknown }[] = [];
  const published: BackgroundShellJobInfo[] = [];
  const jobs = new BackgroundShellJobs({
    queueLive: (_sessionId, prompt) => {
      if (!state.live) return false;
      events.push({ kind: "live", notice: { prompt } });
      return true;
    },
    wake: (_sessionId, notice, options) => {
      if (state.busy && state.busy-- > 0) return false;
      events.push({ kind: "wake", notice, options });
      return true;
    },
    publish: (job) => { published.push(job); },
  });
  const shell = jobs.wrap(createPowerShellTool(os.tmpdir()) as unknown as ToolDefinition, "s1");
  const job = jobs.tool("s1");
  const run = (params: Record<string, unknown>) => shell.execute("call", params as never, undefined, undefined, undefined as never);
  const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(25); };
  return { jobs, run, job, events, published, until };
}

describe("background shell commands", () => {
  test("starting returns a job link; an idle conversation is woken with the result and the starting turn's options", async () => {
    const { jobs, run, events, published, until } = setup({});
    jobs.noteRun("s1", { model: "p/m", permissionMode: "full" });
    const started = await run({ command: "Start-Sleep -Milliseconds 300; 'built ok'", background: true });
    expect(started.details).toEqual({ jobId: published[0]?.id });
    expect(events).toEqual([]);
    expect(published[0]).toMatchObject({ status: "running", command: "Start-Sleep -Milliseconds 300; 'built ok'" });
    await until(() => events.length > 0);
    const [wake] = events;
    expect(wake!.kind).toBe("wake");
    expect(wake!.options).toEqual({ model: "p/m", permissionMode: "full" });
    expect(wake!.notice.prompt).toContain("built ok");
    expect(wake!.notice.prompt).toContain("exited with code 0");
    expect(isSubagentUpdatePrompt({ role: "user", content: [{ type: "text", text: wake!.notice.prompt }] })).toBe(true);
    expect(published.at(-1)).toMatchObject({ status: "exited", exitCode: 0 });
    expect(published.at(-1)!.output).toContain("built ok");
  }, 20_000);

  test("a running turn receives the result live; a busy one is retried", async () => {
    const live = setup({ live: true });
    await live.run({ command: "exit 3", background: true });
    await live.until(() => live.events.length > 0);
    expect(live.events[0]!.kind).toBe("live");
    expect(live.events[0]!.notice.prompt).toContain("exited with code 3");

    const busy = setup({ busy: 1 });
    await busy.run({ command: "'x'", background: true });
    await busy.until(() => busy.events.length > 0);
    expect(busy.events[0]!.kind).toBe("wake");
  }, 20_000);

  test("a stopped command reports stopped and is not delivered", async () => {
    const { jobs, run, job, published, events } = setup({});
    const jobId = /jobId=(\w+)/.exec(text(await run({ command: "'started'; Start-Sleep -Seconds 30", background: true })))![1]!;
    expect(text(await job.execute("j", {} as never, undefined, undefined, undefined as never))).toContain(jobId);
    await jobs.stop(jobId);
    expect(published.at(-1)).toMatchObject({ id: jobId, status: "stopped" });
    expect(text(await job.execute("j", { jobId } as never, undefined, undefined, undefined as never))).toStartWith("stopped");
    await Bun.sleep(200);
    expect(events).toHaveLength(0);
  }, 20_000);

  test("without background the command runs in the call", async () => {
    const { run, events } = setup({});
    expect(text(await run({ command: "'inline'" }))).toContain("inline");
    expect(events).toHaveLength(0);
  }, 20_000);
});
