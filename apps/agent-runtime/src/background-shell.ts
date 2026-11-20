import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TObject } from "typebox";
import type { BackgroundShellJobInfo, RunPermissionMode, RunThinkingLevel } from "@qone/protocol";
import { runtimeText } from "./runtime-localization.js";

/** Reserved prefix of the model input that carries a finished background command. */
export const BACKGROUND_SHELL_MARKER = "[QONE_BACKGROUND_SHELL]";
// Only a retry path: a session that is starting, compacting or finishing a run
// cannot take the result yet, and becomes able to within a moment.
const DELIVERY_RETRY_MS = 1000;
const PUBLISH_INTERVAL_MS = 500;
const PUBLISHED_OUTPUT_CHARS = 20_000;
const CARD_COMMAND_LENGTH = 300;

export interface BackgroundRunOptions { model?: string; permissionMode?: RunPermissionMode; thinking?: RunThinkingLevel; serverIds?: string[] }

/** `content` is the archived notice; `prompt` is what the model reads. */
export interface BackgroundNotice { jobId: string; title: string; content: string; prompt: string }

export interface BackgroundShellHost {
  /** Queue the prompt into the session's running turn; true when accepted. */
  queueLive(sessionId: string, prompt: string): boolean;
  /** Start a turn for an idle session; false while the session is busy. */
  wake(sessionId: string, notice: BackgroundNotice, options: BackgroundRunOptions): boolean;
  /** Start and terminal state, before the UI and model see them. Not output ticks. */
  lifecycle?(job: BackgroundShellJobInfo, toolName: string): void;
  /** The command's state changed. */
  publish(job: BackgroundShellJobInfo): void;
}

type ShellInput = { command: string; timeout?: number };
type ShellResult = { content?: { type: string; text?: string }[]; structuredContent?: { exit_code?: number } };

interface Job {
  id: string;
  sessionId: string;
  command: string;
  startedAt: number;
  options: BackgroundRunOptions;
  controller: AbortController;
  /** Latest streamed output, already tail-truncated by the shell tool. */
  output: string;
  result?: { text: string; exitCode?: number; seconds: number };
  stopped?: boolean;
  finished?: Promise<void>;
  retry?: ReturnType<typeof setTimeout>;
  publishTimer?: ReturnType<typeof setTimeout>;
  publishedAt: number;
}

const textOf = (result: ShellResult | undefined) =>
  (result?.content ?? []).map((part) => part.type === "text" ? part.text ?? "" : "").join("");

/**
 * Shell commands the model chose not to wait for. The command keeps running
 * after the tool call returns; its result goes back to the same conversation,
 * into the running turn or, when the conversation is idle, as a new turn.
 */
export class BackgroundShellJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly runOptions = new Map<string, BackgroundRunOptions>();

  constructor(private readonly host: BackgroundShellHost) {}

  /** The options a woken turn reuses: those of the turn that started the command. */
  noteRun(sessionId: string, options: BackgroundRunOptions): void {
    this.runOptions.set(sessionId, options);
  }

  list(sessionId: string): BackgroundShellJobInfo[] {
    return [...this.jobs.values()].filter((job) => job.sessionId === sessionId).map((job) => this.info(job));
  }

  /** Stops a command; a stopped command's result is not delivered. */
  async stop(jobId: string, sessionId?: string): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job || (sessionId && job.sessionId !== sessionId)) throw new Error(`Unknown background command ${jobId}`);
    if (!job.result) {
      job.stopped = true;
      job.controller.abort();
      await job.finished;
    }
    return job;
  }

  /** Adds `background` to a shell tool. The wrapped tool keeps its permission checks. */
  wrap(tool: ToolDefinition, sessionId: string): ToolDefinition {
    const parameters = tool.parameters as unknown as TObject;
    const guidelines = (tool as ToolDefinition & { promptGuidelines?: string[] }).promptGuidelines ?? [];
    return {
      ...tool,
      parameters: Type.Object({
        ...parameters.properties,
        background: Type.Optional(Type.Boolean({ description: "Run without waiting. Returns a jobId at once; the result is delivered to you automatically when the command ends." })),
      }) as never,
      promptGuidelines: [...guidelines,
        "For a command that may run longer than about a minute (builds, installs, long tests, downloads, servers), set background: true and continue with other work or end your turn. Its result is delivered to you automatically when it ends, even after your turn ended; do not poll or sleep waiting for it. Use shell_job to check progress or stop it.",
      ],
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const { background, ...input } = params as ShellInput & { background?: boolean };
        if (!background) return tool.execute(toolCallId, input as never, signal, onUpdate, ctx);
        const job = this.start(tool, sessionId, toolCallId, input, ctx);
        const text = `Started in background as jobId=${job.id}. Its result will be delivered to you automatically when it ends. Use shell_job to check output or stop it.`;
        return { content: [{ type: "text", text }], details: { jobId: job.id }, structuredContent: { output: text, truncated: false, exit_code: 0, wall_time_seconds: 0 } } as never;
      },
    } as ToolDefinition;
  }

  /** Lists, reads or stops this conversation's background commands. */
  tool(sessionId: string): ToolDefinition {
    return {
      name: "shell_job",
      label: "Background command",
      description: "List, read or stop background shell commands started with background=true. Omit jobId to list them. A finished command's result is delivered to you automatically; use this to check progress, such as whether a server is up, or to stop a command.",
      parameters: Type.Object({
        jobId: Type.Optional(Type.String()),
        action: Type.Optional(Type.Union([Type.Literal("output"), Type.Literal("stop")], { description: "Default output" })),
      }),
      execute: async (_toolCallId, params) => {
        const { jobId, action } = params as { jobId?: string; action?: "output" | "stop" };
        const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
        if (!jobId) {
          const rows = [...this.jobs.values()].filter((job) => job.sessionId === sessionId);
          return text(rows.length ? rows.map((job) => `${job.id} ${this.status(job)}: ${job.command}`).join("\n") : "No background commands.");
        }
        const job = action === "stop" ? await this.stop(jobId, sessionId) : this.jobs.get(jobId);
        if (!job || job.sessionId !== sessionId) throw new Error(`Unknown background command ${jobId}`);
        return text(`${this.status(job)}\n\n${job.result?.text ?? (job.output || "(no output yet)")}`);
      },
    } as ToolDefinition;
  }

  /** Stops a deleted conversation's commands; nothing is delivered for them. */
  disposeSession(sessionId: string): void {
    for (const job of this.jobs.values()) {
      if (job.sessionId !== sessionId) continue;
      job.stopped = true;
      job.controller.abort();
      clearTimeout(job.retry);
      clearTimeout(job.publishTimer);
      this.jobs.delete(job.id);
    }
    this.runOptions.delete(sessionId);
  }

  private start(tool: ToolDefinition, sessionId: string, toolCallId: string, input: ShellInput, ctx: unknown): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8), sessionId, command: input.command, startedAt: Date.now(),
      options: this.runOptions.get(sessionId) ?? {}, controller: new AbortController(), output: "", publishedAt: 0,
    };
    this.jobs.set(job.id, job);
    this.host.lifecycle?.(this.info(job), tool.name);
    this.publish(job);
    // Not the turn's signal: the command outlives the tool call and the turn.
    job.finished = Promise.resolve().then(() => tool.execute(toolCallId, input as never, job.controller.signal,
      (update) => { job.output = textOf(update as ShellResult) || job.output; this.schedulePublish(job); }, ctx as never))
      .then((result) => ({ text: textOf(result as ShellResult) || "(no output)", exitCode: (result as ShellResult).structuredContent?.exit_code }))
      .catch((error: unknown) => ({ text: error instanceof Error ? error.message : String(error), exitCode: undefined }))
      .then((result) => {
        job.result = { ...result, seconds: Math.round((Date.now() - job.startedAt) / 100) / 10 };
        clearTimeout(job.publishTimer);
        if (this.jobs.has(job.id)) {
          this.host.lifecycle?.(this.info(job), tool.name);
          this.publish(job);
        }
        if (!job.stopped) this.deliver(job, this.notice(job));
      });
    return job;
  }

  private info(job: Job): BackgroundShellJobInfo {
    const output = job.result?.text ?? job.output;
    return {
      id: job.id, sessionId: job.sessionId, command: job.command, startedAt: job.startedAt,
      status: !job.result ? "running" : job.stopped ? "stopped" : job.result.exitCode === undefined ? "ended" : "exited",
      exitCode: job.result?.exitCode,
      endedAt: job.result ? job.startedAt + job.result.seconds * 1000 : undefined,
      output: output.length > PUBLISHED_OUTPUT_CHARS ? output.slice(-PUBLISHED_OUTPUT_CHARS) : output,
    };
  }

  private publish(job: Job): void {
    job.publishedAt = Date.now();
    this.host.publish(this.info(job));
  }

  private schedulePublish(job: Job): void {
    if (job.publishTimer) return;
    job.publishTimer = setTimeout(() => {
      job.publishTimer = undefined;
      if (!job.result && this.jobs.has(job.id)) this.publish(job);
    }, Math.max(0, PUBLISH_INTERVAL_MS - (Date.now() - job.publishedAt)));
  }

  private status(job: Job): string {
    if (!job.result) return `running for ${Math.round((Date.now() - job.startedAt) / 1000)}s`;
    if (job.stopped) return "stopped";
    return job.result.exitCode === undefined ? "ended without an exit code" : `exited with code ${job.result.exitCode}`;
  }

  private commandBlock(job: Job): string {
    const command = job.command.length > CARD_COMMAND_LENGTH ? `${job.command.slice(0, CARD_COMMAND_LENGTH)}…` : job.command;
    return `\`\`\`powershell\n${command}\n\`\`\``;
  }

  private notice(job: Job): BackgroundNotice {
    const result = job.result!;
    const status = result.exitCode === undefined
      ? runtimeText("background-shell.ended", { seconds: result.seconds })
      : runtimeText("background-shell.exited", { code: result.exitCode, seconds: result.seconds });
    return {
      jobId: job.id,
      title: runtimeText("background-shell.title"),
      content: `${status}\n\n${this.commandBlock(job)}`,
      prompt: [
        BACKGROUND_SHELL_MARKER,
        `Background command jobId=${job.id} ${this.status(job)} after ${result.seconds}s.`,
        "Command:", job.command,
        "Result:", result.text,
        "This is the result of a command you started with background=true. Briefly state the outcome, then continue the work it was part of.",
      ].join("\n"),
    };
  }

  private deliver(job: Job, notice: BackgroundNotice): void {
    job.retry = undefined;
    if (!this.jobs.has(job.id) || job.stopped) return;
    // A running turn takes the result in place; the invocation shows its status.
    if (this.host.queueLive(job.sessionId, notice.prompt)) return;
    if (!this.host.wake(job.sessionId, notice, job.options)) job.retry = setTimeout(() => this.deliver(job, notice), DELIVERY_RETRY_MS);
  }
}
