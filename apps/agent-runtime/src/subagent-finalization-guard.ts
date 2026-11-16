import type { SubagentController } from "./subagent-runner.js";

export interface FinalizationGuardContext {
  runId(): string | undefined;
  controller(): SubagentController | undefined;
  push(type: string, payload: unknown, sessionId: string, runId?: string): void;
  eventSessionId: string;
}

/**
 * Gates the final answer behind required subagent results. finishTurn also runs
 * after every tool batch, so tool turns and turns with queued input are left
 * alone: the parent keeps working while children run. Only an actual end-of-turn
 * with no queued work waits for the children, then asks for finalize_response.
 * Extracted from PiAdapter.getSession so the adapter only wires it up.
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
    const typedTurn = turn as { message: { stopReason?: string; content?: { type?: string }[] } };
    if (!runId || !controller || typedTurn.message.stopReason === "error" || typedTurn.message.stopReason === "aborted") return previous;
    // finishTurn also runs after every tool batch, not only when the model
    // wants to stop. Gating a tool turn would stall the parent mid-task, which
    // is exactly the "created a subagent and then nothing happens" failure.
    if (typedTurn.message.content?.some((part) => part.type === "toolCall")) return previous;
    // Queued input (a user steer or a child's message) is work the parent can
    // do now; let it proceed instead of holding the turn open.
    if (agent.hasQueuedMessages()) return previous;
    let dependencies = controller.dependencyStatus?.(runId);
    if (!dependencies || (!dependencies.blocking.length && !dependencies.unacknowledged.length && dependencies.authorized !== false)) return previous;
    const active = () => dependencies!.blocking.filter((child) => ["created", "running", "waiting_approval", "paused"].includes(child.status));
    const running = active();
    if (running.length) {
      ctx.push("agent.waiting_subagents", { subagents: running.map((child) => ({ runId: child.id, title: child.title })) }, ctx.eventSessionId, runId);
    }
    // The model tried to end its turn while required children are still open.
    // That is the only point where waiting is correct: independent work is done.
    if (running.length) {
      try {
        await controller.waitForDependencyChange(runId, signal);
      } catch (error) {
        // An aborted turn ends normally; the child keeps running for the next
        // turn. Any other failure must not be reported as a completed turn.
        if (signal?.aborted) return previous;
        throw error;
      }
      dependencies = controller.dependencyStatus(runId);
    }
    const ids = dependencies.blocking.map((child) => child.id);
    const instruction = ids.length
      ? `Required subagent results remain unresolved: ${ids.join(", ")}. Inspect each compact result, continue retryable failures with the same runId using follow_up, then call finalize_response before the final answer.`
      : "All required subagent results have been processed, but finalization has not been authorized. Call finalize_response with the handled run IDs before the final answer.";
    if (!agent.hasQueuedMessages()) {
      agent.steer({ role: "user", content: [{ type: "text", text: `[QONE_SUBAGENT_LEDGER]\n${instruction}` }], timestamp: Date.now() });
    }
    return { action: "continue" };
  }) as typeof agent.finishTurn;
}