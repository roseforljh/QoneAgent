import type { AgentEvent, AutomationCommand, RuntimeCommand, RuntimeEvent, ScheduleInfo, ScheduleRunInfo, ScheduleRunStatus } from "@qone/protocol";
import type { RunRepo, SessionRepo, SettingsRepo, WorkspaceRepo } from "@qone/database";
import { runtimeError, runtimeErrorInfo, runtimeText } from "../runtime-localization";
import { nextRunAt } from "./schedule-rule";

type ScheduleCommand = Extract<AutomationCommand, { type: `schedule.${string}` }>;
type AgentRun = Extract<RuntimeCommand, { type: "agent.run" }>;

export interface ScheduleServiceDeps {
  settings: SettingsRepo;
  sessions: SessionRepo;
  workspaces: WorkspaceRepo;
  runs: RunRepo;
  send(event: RuntimeEvent): void;
  /** Resolves with the runtime's error message when the turn did not start. */
  run(command: AgentRun): Promise<string | undefined>;
  busy(sessionId: string): boolean;
  sessionsChanged(): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

const STORE_KEY = "schedules";
const TICK_MS = 30_000;
const ACTIVE = new Set(["created", "running", "waiting_approval", "paused"]);
const HISTORY_LIMIT = 30;
const runStatus = (status: string): ScheduleRunStatus => ACTIVE.has(status) ? "running" : status as ScheduleRunStatus;

/**
 * Runs saved prompts on a clock. Each task owns one conversation; every run is
 * appended to it, so results stay in one place and the sidebar does not fill
 * up. A due task whose conversation is still busy stays due and starts on a
 * later tick. Missed runs while Qone was closed fire once on the next start.
 */
export class ScheduleService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly firing = new Set<string>();

  constructor(private readonly deps: ScheduleServiceDeps) {}

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop() { clearInterval(this.timer); }

  private list(): ScheduleInfo[] { return this.deps.settings.get<ScheduleInfo[]>(STORE_KEY) ?? []; }

  private update(id: string, patch: Partial<ScheduleInfo>) {
    this.deps.settings.set(STORE_KEY, this.list().map((item) => item.id === id ? { ...item, ...patch } : item));
    this.publish();
  }

  private status(item: ScheduleInfo): Pick<ScheduleInfo, "lastStatus" | "lastError"> {
    const run = item.lastRunId ? this.deps.runs.get(item.lastRunId) : undefined;
    if (!run) return { lastError: item.lastError };
    const lastStatus = runStatus(run.status);
    return { lastStatus, lastError: lastStatus === "failed" ? run.error ?? undefined : undefined };
  }

  /** Recent fires of every task, newest first; each opens its task's conversation. */
  private history(schedules: ScheduleInfo[]): ScheduleRunInfo[] {
    return schedules.flatMap((item) => item.sessionId ? this.deps.runs.listBySession(item.sessionId)
      .filter((run) => run.origin === "schedule")
      .slice(0, HISTORY_LIMIT)
      .map((run) => ({
        id: run.id, scheduleId: item.id, sessionId: item.sessionId!, startedAt: run.startedAt ?? 0, status: runStatus(run.status),
        ...(run.status === "failed" && run.error ? { error: run.error } : {}),
      })) : [])
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, HISTORY_LIMIT);
  }

  publish(requestId?: string) {
    const schedules = this.list();
    this.deps.send({ type: "schedule.list", requestId, schedules: schedules.map((item) => ({ ...item, ...this.status(item) })), runs: this.history(schedules) });
  }

  /** A task's run ended: refresh its status on screen. */
  observe(event: AgentEvent) {
    if (!event.runId || !/^agent\.(completed|failed|cancelled)$/.test(event.type)) return;
    if (this.list().some((item) => item.lastRunId === event.runId)) this.publish();
  }

  async handle(cmd: ScheduleCommand) {
    if (cmd.type === "schedule.list") return this.publish(cmd.requestId);
    if (cmd.type === "schedule.delete") {
      this.deps.settings.set(STORE_KEY, this.list().filter((item) => item.id !== cmd.id));
      return this.publish(cmd.requestId);
    }
    if (cmd.type === "schedule.run") {
      await this.fire(cmd.id, true);
      return this.publish(cmd.requestId);
    }
    const { id: requestedId, ...fields } = cmd.schedule;
    if (!this.deps.workspaces.get(fields.workspaceId)) throw runtimeError("schedule.workspace_missing");
    const list = this.list();
    const existing = requestedId ? list.find((item) => item.id === requestedId) : undefined;
    if (requestedId && !existing) throw runtimeError("schedule.not_found");
    const now = Date.now();
    const saved: ScheduleInfo = {
      id: existing?.id ?? crypto.randomUUID(),
      // Moving a task to another project starts a conversation there.
      sessionId: existing?.workspaceId === fields.workspaceId ? existing.sessionId : undefined,
      lastRunAt: existing?.lastRunAt,
      lastRunId: existing?.lastRunId,
      createdAt: existing?.createdAt ?? now,
      ...fields,
      updatedAt: now,
      nextRunAt: fields.enabled ? nextRunAt(fields.rule, now) : undefined,
    };
    this.deps.settings.set(STORE_KEY, existing ? list.map((item) => item.id === saved.id ? saved : item) : [...list, saved]);
    this.publish(cmd.requestId);
  }

  private async tick() {
    const now = Date.now();
    for (const item of this.list()) {
      if (!item.enabled || item.nextRunAt === undefined || item.nextRunAt > now) continue;
      try { await this.fire(item.id, false); }
      catch (error) {
        this.deps.warn("scheduled task failed to start", { scheduleId: item.id, err: String(error) });
        this.update(item.id, { lastError: runtimeErrorInfo(error).message, lastRunId: undefined });
      }
    }
  }

  private async fire(id: string, manual: boolean) {
    if (this.firing.has(id)) return;
    this.firing.add(id);
    try {
      const item = this.list().find((candidate) => candidate.id === id);
      if (!item) throw runtimeError("schedule.not_found");
      const now = Date.now();
      // Automatic runs advance the clock first, so a failure cannot refire every tick.
      const advance = manual ? {} : {
        nextRunAt: nextRunAt(item.rule, now, item.lastRunAt ?? item.updatedAt),
        ...(item.rule.kind === "once" ? { enabled: false } : {}),
      };
      if (!this.deps.workspaces.get(item.workspaceId)) {
        this.update(id, { ...advance, lastError: runtimeText("schedule.workspace_missing"), lastRunId: undefined });
        if (manual) throw runtimeError("schedule.workspace_missing");
        return;
      }
      const existingSession = item.sessionId ? this.deps.sessions.get(item.sessionId) : undefined;
      const session = existingSession ? { id: existingSession.id, title: existingSession.title } : this.deps.sessions.create(item.title, item.workspaceId);
      if (!existingSession) {
        this.update(id, { sessionId: session.id });
        this.deps.sessionsChanged();
      }
      if (this.deps.busy(session.id)) {
        if (manual) throw runtimeError("schedule.busy");
        return; // Still due; a later tick starts it.
      }
      const error = await this.deps.run({
        type: "agent.run", requestId: crypto.randomUUID(), sessionId: session.id, message: item.prompt,
        // The same prompt every time must append a turn, never replace the earlier one.
        continuation: true, origin: "schedule",
        model: item.model, permissionMode: item.permissionMode, thinking: item.thinking,
        notice: { content: item.prompt, communication: { fromId: `schedule:${item.id}`, fromTitle: runtimeText("schedule.sender", { title: item.title }), toId: session.id, toTitle: session.title } },
      });
      const run = error ? undefined : this.deps.runs.listBySession(session.id)[0];
      const started = run && (run.startedAt ?? 0) >= now && run.origin === "schedule" ? run.id : undefined;
      this.update(id, { ...advance, lastRunAt: now, lastRunId: started, lastError: started ? undefined : error ?? runtimeText("schedule.busy") });
      if (manual && error) throw new Error(error);
    } finally {
      this.firing.delete(id);
    }
  }
}
