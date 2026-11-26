import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@qone/shared";
import type { PiAdapter, IsolatedSessionPolicy } from "../pi-adapter.js";
import { extractTextContent } from "../pi-message-utils.js";
import { observedTarget, teamToolDenial } from "./team-environment.js";
import type { TeamTurnObserver, TeamTurnRequest, TeamTurnRunner } from "./team-orchestrator.js";

const log = createLogger("team-runner");
export const TEAM_SESSION_PREFIX = "team:";

/** 运行时总线事件的最小形状（与 index.ts 的 RuntimeBusEvent 一致）。 */
export interface TeamBusEvent { type: string; payload?: unknown; sessionId?: string; runId?: string }

interface LiveTurn {
  runId: string;
  observer: TeamTurnObserver;
  policy: IsolatedSessionPolicy;
  text: string;
  /** 当前助手消息是否已经收到流式文本；没有时以完成事件里的全文兜底。 */
  streamed: boolean;
}

type Payload = { delta?: unknown; blockType?: unknown; toolName?: unknown; toolCallId?: unknown; args?: unknown; result?: unknown; update?: unknown; message?: { role?: unknown }; approvalId?: unknown };

/** 审批卡片上展示的参数摘要：命令或路径。 */
function approvalDetail(args: unknown): string | undefined {
  const value = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const raw = [value.command, value.path, value.file, value.remote_path, value.local_path].find((item) => typeof item === "string") as string | undefined;
  return raw?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
}

/**
 * 用主 PiAdapter 在隔离会话里执行成员回合：复用同一套模型、密钥、MCP、权限审批与服务器工具，
 * 但会话不进入普通聊天的持久化与事件回放，由本类把总线事件翻译给编排器。
 */
export class PiTeamTurnRunner implements TeamTurnRunner {
  private readonly turns = new Map<string, LiveTurn>();

  constructor(private readonly adapter: Pick<PiAdapter, "run" | "stop" | "setIsolatedSessionResolver">) {
    adapter.setIsolatedSessionResolver((sessionId) => this.turns.get(sessionId)?.policy);
  }

  static owns(sessionId: string | undefined): boolean { return Boolean(sessionId?.startsWith(TEAM_SESSION_PREFIX)); }

  async run(request: TeamTurnRequest, observer: TeamTurnObserver, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const runId = crypto.randomUUID();
    const tools: ToolDefinition[] = request.tools;
    const turn: LiveTurn = {
      runId, observer, text: "", streamed: false,
      policy: { gate: (toolName, args) => teamToolDenial(request.scope, toolName, args), tools, cacheKey: request.cacheKey },
    };
    this.turns.set(request.sessionId, turn);
    const abort = () => this.adapter.stop(runId);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.adapter.run(request.sessionId, request.prompt, {
        runId, model: request.model, thinking: request.thinking, cwd: request.scope.cwd, eventSessionId: request.sessionId,
        permissionMode: request.permissionMode, serverIds: request.scope.servers.map((server) => server.id),
        ...(request.attachments?.length ? { attachments: request.attachments } : {}),
      }, () => undefined);
      return turn.text;
    } finally {
      signal.removeEventListener("abort", abort);
      this.turns.delete(request.sessionId);
    }
  }

  /** 处理团队会话的总线事件；返回 true 表示事件属于团队模式，不再进入普通会话管线。 */
  observe(event: TeamBusEvent): boolean {
    if (!PiTeamTurnRunner.owns(event.sessionId)) return false;
    const turn = this.turns.get(event.sessionId!);
    if (!turn || (event.runId && event.runId !== turn.runId)) return true;
    const payload = (event.payload ?? {}) as Payload;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
    const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    switch (event.type) {
      case "message.started":
        turn.streamed = false;
        break;
      case "message.delta":
        if (payload.blockType === undefined && typeof payload.delta === "string" && payload.delta) this.append(turn, payload.delta);
        break;
      case "message.completed":
        if (!turn.streamed && payload.message?.role === "assistant") {
          const text = extractTextContent(payload.message);
          if (text) this.append(turn, text);
        }
        break;
      case "tool.started":
        turn.observer.toolStarted(toolName, payload.args, callId);
        break;
      case "tool.updated": {
        const target = observedTarget(toolName, payload.update);
        if (target?.kind === "server") turn.observer.target(target);
        break;
      }
      case "tool.completed":
      case "tool.failed": {
        const target = observedTarget(toolName, payload.result);
        if (target) turn.observer.target(target);
        const details = (payload.result as { details?: { denied?: unknown; rejected?: unknown } } | undefined)?.details;
        const outcome = details?.denied || details?.rejected ? "blocked" : event.type === "tool.failed" ? "failed" : "done";
        let failureDetail: string | undefined;
        if (outcome === "failed") {
          const text = extractTextContent(payload.result)?.replace(/\s+/g, " ").trim();
          if (text) {
            failureDetail = text.slice(0, 120);
            log.warn("team tool failed", { sessionId: event.sessionId, toolName, detail: text.slice(0, 300) });
          }
        }
        turn.observer.toolFinished(toolName, outcome, callId, failureDetail);
        break;
      }
      case "approval.requested":
        if (typeof payload.approvalId === "string") turn.observer.approval({ approvalId: payload.approvalId, toolName, detail: approvalDetail(payload.args) });
        break;
      case "approval.resolved":
        turn.observer.approval(undefined);
        break;
    }
    return true;
  }

  private append(turn: LiveTurn, text: string) {
    // 同一回合的多条助手消息之间空一行，流式与最终文本保持一致。
    const separator = !turn.streamed && turn.text && !turn.text.endsWith("\n") ? "\n\n" : "";
    turn.streamed = true;
    turn.text += separator + text;
    turn.observer.delta(separator + text);
  }
}
