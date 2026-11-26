import type { GoalRepo, MessageRepo, RunRepo, SessionRepo, SettingsRepo, SubagentRunRepo } from "@qone/database";
import type { RuntimeCommand } from "@qone/protocol";
import { recoveredParts, type RecoveredRun, type RunCheckpoints } from "./run-checkpoints.js";
import { runtimeText } from "./runtime-localization";

type Warn = (message: string, meta?: Record<string, unknown>) => void;

/** On boot, before runs are marked interrupted: saves what each cut-off turn finished and returns what can continue. */
export function recoverInterruptedRuns(deps: {
  runs: RunRepo; subagents: SubagentRunRepo; messages: MessageRepo; settings: SettingsRepo; checkpoints: RunCheckpoints; nextSequence: number; warn: Warn;
}): RecoveredRun[] {
  const recovered: RecoveredRun[] = [];
  for (const run of deps.runs.listActive()) {
    if (deps.subagents.get(run.id)) continue;
    try {
      const checkpoint = deps.checkpoints.take(run.id);
      if (!checkpoint) continue;
      if (checkpoint.raw.length) {
        const parts = recoveredParts(checkpoint.raw, deps.nextSequence, runtimeText("recovery.tool_interrupted"));
        const content = parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n").trim();
        deps.messages.addAssistant(run.sessionId, content, run.id, run.model ?? checkpoint.meta.model, parts, undefined, checkpoint.raw);
      }
      recovered.push(checkpoint);
    } catch (error) {
      deps.warn("interrupted run recovery failed", { runId: run.id, err: String(error) });
    }
  }
  // Anything left belongs to runs that already ended; the previous process is gone.
  deps.settings.deletePrefix("run.checkpoint:");
  return recovered;
}

/** Continues turns a restart cut off. A recovery turn that is itself cut off is not retried, so a crash cannot loop. */
export function resumeInterruptedRuns(recovered: readonly RecoveredRun[], deps: {
  sessions: SessionRepo; goals: GoalRepo; busy(sessionId: string): boolean;
  continueGoal(sessionId: string, goalId: string, epoch: number): void;
  run(command: RuntimeCommand): Promise<string | undefined>; warn: Warn;
}) {
  for (const { meta } of recovered) {
    const session = deps.sessions.get(meta.sessionId);
    if (meta.origin === "recovery" || !session || deps.busy(session.id)) continue;
    if (meta.goalId) {
      const goal = deps.goals.get(meta.goalId);
      if (goal?.status === "active" && !goal.waitingReason) deps.continueGoal(session.id, goal.id, goal.epoch);
      continue;
    }
    void deps.run({
      type: "agent.run", requestId: crypto.randomUUID(), sessionId: session.id, message: runtimeText("recovery.prompt"),
      continuation: true, origin: "recovery",
      model: meta.model, permissionMode: meta.permissionMode, thinking: meta.thinking, serverIds: meta.serverIds,
      notice: { content: runtimeText("recovery.notice"), communication: { fromId: "qone", fromTitle: runtimeText("recovery.sender"), toId: session.id, toTitle: session.title } },
    }).then((error) => { if (error) deps.warn("interrupted run did not resume", { sessionId: session.id, err: error }); });
  }
}

/** The window sends model keys after it connects; automatic turns at startup need them sooner. */
export async function restoreModelKeys(providers: readonly string[], secrets: Map<string, string>,
  read: (keys: string[]) => Promise<Record<string, string>>, apply: (key: string, value: string) => Promise<void>) {
  const keys = [...new Set(providers.map((provider) => `model.apiKey:${provider}`))].filter((key) => !secrets.has(key));
  if (!keys.length) return;
  const values = await read(keys);
  for (const key of keys) {
    const value = values[key];
    if (value === undefined || secrets.has(key)) continue;
    secrets.set(key, value);
    await apply(key, value);
  }
}
