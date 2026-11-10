import type { SubagentController } from "./subagent-runner.js";

export interface FinalizationGuardContext {
  runId(): string | undefined;
  controller(): SubagentController | undefined;
  push(type: string, payload: unknown, sessionId: string, runId?: string): void;
  eventSessionId: string;
}

/**
 * Blocks the final answer while required subagent results are still open, and
 * asks the model to call finalize_response once they are handled. Extracted from
 * PiAdapter.getSession so the adapter only wires it up.
 */
export function installSubagentFinalizationGuard(
  session: {
    agent: {
      finishTurn?: (...args: never[]) => unknown;
      hasQueuedMessages(): boolean;
      steer(message: unknown): void;
    };
  },
  ctx: FinalizationGuardContext,
): void {
  const agent = session.agent as {
    finishTurn?: (turn: unknown, signal: AbortSignal) => Promise<unknown>;
    hasQueuedMessages(): boolean;
    steer(message: unknown): void;
  };
  const previousFinishTurn = agent.finishTurn;
  agent.finishTurn = (async (turn, signal) => {
    const previous = await previousFinishTurn?.(turn, signal);
    const runId = ctx.runId();
    const controller = ctx.controller();
    const typedTurn = turn as { message: { stopReason?: string } };
    if (!runId || !controller || typedTurn.message.stopReason === "error" || typedTurn.message.stopReason === "aborted") return previous;
    let dependencies = controller.dependencyStatus?.(runId);
    if (!dependencies || (!dependencies.blocking.length && !dependencies.unacknowledged.length && dependencies.authorized !== false)) return previous;
    const active = () => dependencies!.blocking.filter((child) => ["created", "running", "waiting_approval", "paused"].includes(child.status));
    if (active().length) {
      ctx.push("agent.waiting_subagents", { subagents: active().map((child) => ({ runId: child.id, title: child.title })) }, ctx.eventSessionId, runId);
      await controller.waitForDependencyChange(runId, signal);
      dependencies = controller.dependencyStatus(runId);
    }
    const ids = dependencies.blocking.map((child) => child.id);
    const instruction = ids.length
      ? `Required subagent results remain unresolved: ${ids.join(", ")}. Confirm the actual state, inspect each compact result, continue retryable failures with the same runId using follow_up, then call finalize_response before the final answer.`
      : "All required subagent results have been processed, but finalization has not been authorized. Call finalize_response with the handled run IDs before the final answer.";
    if (!agent.hasQueuedMessages()) {
      agent.steer({ role: "user", content: [{ type: "text", text: `[QONE_SUBAGENT_LEDGER]\n${instruction}` }], timestamp: Date.now() });
    }
    return { action: "continue" };
  }) as typeof agent.finishTurn;
}