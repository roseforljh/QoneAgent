import { assistantPartsFromPiMessage, persistedToolResult, type AgentEvent, type AssistantMessagePart, type RunPermissionMode, type RunThinkingLevel } from "@qone/protocol";
import type { SettingsRepo } from "@qone/database";

/** What a conversation run needs to be continued by a later process. */
export interface RunCheckpointMeta {
  sessionId: string;
  origin?: "schedule" | "recovery";
  model?: string;
  permissionMode?: RunPermissionMode;
  thinking?: RunThinkingLevel;
  serverIds?: string[];
  goalId?: string;
  goalEpoch?: number;
}

export interface RecoveredRun {
  runId: string;
  meta: RunCheckpointMeta;
  raw: unknown[];
}

const key = (runId: string) => `run.checkpoint:${runId}`;

/**
 * Crash-safe copy of an in-flight conversation turn. The transcript lives in
 * memory until the run ends, and the desktop kills the runtime process tree on
 * restart, so a restart used to lose every finished step of the turn. Each raw
 * provider message is written once, when it completes; display parts are
 * rebuilt from them on recovery.
 */
export class RunCheckpoints {
  private readonly written = new Map<string, number>();

  constructor(private readonly settings: SettingsRepo, private readonly raw: Map<string, unknown[]>) {}

  start(runId: string, meta: RunCheckpointMeta) {
    this.settings.set(key(runId), meta);
    this.written.set(runId, 0);
  }

  observe(event: AgentEvent) {
    const runId = event.runId;
    if (!runId || !this.written.has(runId)) return;
    if (event.type === "agent.completed" || event.type === "agent.failed" || event.type === "agent.cancelled") {
      this.finish(runId);
      return;
    }
    if (event.type !== "message.completed") return;
    const raw = this.raw.get(runId) ?? [];
    let count = this.written.get(runId)!;
    for (; count < raw.length; count++) this.settings.set(`${key(runId)}:raw:${count}`, raw[count]);
    this.written.set(runId, count);
  }

  /** The partial turn was saved as a message (steer, stop or end); later steps start a new segment. */
  reset(runId: string) {
    if (!this.written.has(runId)) return;
    this.written.set(runId, 0);
    this.settings.deletePrefix(`${key(runId)}:`);
  }

  finish(runId: string) {
    if (!this.written.delete(runId)) return;
    this.settings.deletePrefix(key(runId));
  }

  /** Reads and removes the checkpoint a killed process left for `runId`. */
  take(runId: string): RecoveredRun | undefined {
    const meta = this.settings.get<RunCheckpointMeta>(key(runId));
    if (!meta) return undefined;
    const raw: unknown[] = [];
    for (let index = 0; ; index++) {
      const message = this.settings.get(`${key(runId)}:raw:${index}`);
      if (message === undefined) break;
      raw.push(message);
    }
    this.settings.deletePrefix(key(runId));
    return { runId, meta, raw };
  }
}

type RawMessage = { role?: unknown; toolCallId?: unknown; content?: unknown; details?: unknown; isError?: unknown };

/**
 * Display parts for a recovered transcript. A tool that was still running when
 * the process died never reported back, so it is closed as interrupted.
 */
export function recoveredParts(raw: readonly unknown[], firstSequence: number, interrupted: string): AssistantMessagePart[] {
  let parts: AssistantMessagePart[] = [];
  raw.forEach((value, index) => {
    const message = value as RawMessage;
    if (message?.role === "assistant") parts.push(...assistantPartsFromPiMessage({ message }, firstSequence + index));
    else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      parts = parts.map((part) => part.type === "tool-call" && part.toolCallId === message.toolCallId
        ? { ...part, result: persistedToolResult({ content: message.content, details: message.details }), isError: message.isError === true }
        : part);
    }
  });
  return parts.map((part) => part.type === "tool-call" && part.result === undefined
    ? { ...part, result: { content: [{ type: "text", text: interrupted }] }, isError: true }
    : part);
}
