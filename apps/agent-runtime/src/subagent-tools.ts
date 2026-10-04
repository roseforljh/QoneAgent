import { runtimeError } from "./runtime-localization";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunPermissionMode } from "@qone/protocol";
import type { PiAdapter } from "./pi-adapter.js";
import type { SubagentController } from "./subagent-runner.js";
import { subagentResultForModel } from "./subagent-result.js";
import { subagentProfileSchema, subagentTargetSchema, type SubagentSelection, type SubagentWorkflowStep } from "./subagent-selection.js";

interface SubagentToolOptions {
  controller?: SubagentController;
  delegate?: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
  canDelegate: boolean;
  eventSessionId: string;
  subagentRunId?: string;
  subagentDepth: number;
  modelName?: string;
  maxConcurrent?: number;
  parentRunId: () => string | undefined;
  permissionMode: () => RunPermissionMode;
  mediaMimeType: (runId: string, mediaPath: string) => string | undefined;
}

/** Model-facing delegation contract; routing and task execution stay in the runner. */
export function createSubagentTools(options: SubagentToolOptions): ToolDefinition[] {
  const { eventSessionId, subagentRunId, subagentDepth, modelName, canDelegate } = options;
  const checkChild = (id: string) => {
    const target = options.controller!.query(id);
    const owner = subagentRunId ? options.controller!.query(subagentRunId) : undefined;
    if (!target || target.parentSessionId !== (owner?.parentSessionId ?? eventSessionId)) throw new Error("Subagent is outside this conversation");
    if (subagentRunId) {
      let ancestor = target.parentSubagentId;
      while (ancestor && ancestor !== subagentRunId) ancestor = options.controller!.query(ancestor)?.parentSubagentId;
      if (ancestor !== subagentRunId) throw new Error("Only descendant subagents can be inspected or controlled");
    }
  };
  const inspectTools: ToolDefinition[] = options.controller ? [{
    name: "finalize_response",
    label: "Finalize response",
    description: "Authorize the final answer only after every required subagent has ended and its result or failure has been processed.",
    promptSnippet: "Call finalize_response only after inspecting every required child and handling retryable failures. If it reports missing dependencies, continue the required child work first.",
    parameters: Type.Object({ resolvedSubagentRunIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256 }) }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const parentRunId = options.parentRunId();
      if (!parentRunId) throw new Error("No active parent run");
      const result = options.controller!.finalize(parentRunId, (params as { resolvedSubagentRunIds: string[] }).resolvedSubagentRunIds);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  }, {
    name: "inspect_subagent",
    label: "Inspect subagent",
    description: "Read a subagent's actual status, latest turn summary, generated images and child IDs by run ID. Returns a compact result, not the full transcript.",
    promptSnippet: "Use inspect_subagent before following up with an existing agent. After reading, briefly tell the user what was actually returned and how you will use it before calling other tools. An active status or empty summary does not establish completion or verification; do not defer this acknowledgement to the end of the final answer.",
    parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }) }),
    execute: async (_toolCallId, params) => {
      const runId = (params as { runId: string }).runId;
      checkChild(runId);
      const result = options.controller!.query(runId);
      if (!result) throw new Error(`Unknown subagent ${runId}`);
      options.controller!.acknowledge(runId);
      return subagentResultForModel(result);
    },
  }, {
    name: "run_subagent_workflow",
    label: "Run subagent workflow",
    description: 'Run dependent or independent subagent steps. Choose capability="temporary" for ordinary steps, a media capability for media steps, or subagentId for a saved profile. Independent steps run in parallel; dependent steps wait for their prerequisites.',
    promptSnippet: "Use run_subagent_workflow for multi-step delegation such as scout → implement → review.",
    parameters: Type.Object({
      steps: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 120 }),
        task: Type.String({ minLength: 1, maxLength: 32_000 }),
        capability: subagentTargetSchema,
        subagentId: subagentProfileSchema,
        dependsOn: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
      }), { minItems: 1, maxItems: 128 }),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const input = params as { steps: SubagentWorkflowStep[] };
      const parentRunId = options.parentRunId();
      if (!parentRunId) throw new Error("No active parent run");
      void options.controller!.workflow(eventSessionId, parentRunId, input.steps, {
        model: modelName, permissionMode: options.permissionMode(), signal, background: true,
      }).catch(() => undefined);
      return { content: [{ type: "text" as const, text: "Subagent workflow started in background. Use list_subagents or inspect_subagent when you want to process a result." }], details: { background: true } };
    },
  }, {
    name: "wait_subagent",
    label: "Wait for subagent",
    description: "Wait for a subagent to finish and return its current result.",
    promptSnippet: "Use wait_subagent when you need a background child's final result. After it returns, briefly acknowledge the actual returned status and summary before continuing; a timeout or empty summary is not a completed result.",
    parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }), timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 86_400_000 })) }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const input = params as { runId: string; timeoutMs?: number };
      checkChild(input.runId);
      const result = await options.controller!.wait(input.runId, input.timeoutMs, signal, subagentRunId);
      options.controller!.acknowledge(input.runId);
      return subagentResultForModel(result);
    },
  }, {
    name: "control_subagent",
    label: "Control subagent",
    description: "Stop, resume, retry, steer or send a follow-up to an existing subagent session.",
    promptSnippet: "For follow-up questions about the same task or media, reuse the existing runId with follow_up, including after completion and in later user turns. Use steer to correct an active task. This retains the child conversation; do not dispatch a new agent merely because the previous turn completed. If this call returns a finished turn's result, briefly acknowledge that result before continuing other tools; if the child remains active, only report that the control request was accepted, not that the task finished.",
    parameters: Type.Object({
      runId: Type.String({ minLength: 1, maxLength: 128 }),
      action: Type.Union([Type.Literal("stop"), Type.Literal("resume"), Type.Literal("retry"), Type.Literal("steer"), Type.Literal("follow_up")]),
      message: Type.Optional(Type.String({ maxLength: 32_000 })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const input = params as { runId: string; action: "stop" | "resume" | "retry" | "steer" | "follow_up"; message?: string };
      checkChild(input.runId);
      const result = await options.controller!.control(input.runId, input.action, input.message);
      return subagentResultForModel(result);
    },
  }] : [];
  const delegateTool: ToolDefinition[] = canDelegate ? [{
    name: "list_subagents",
    label: "List subagents",
    description: "List existing agent sessions and available delegation targets. The temporary target is the default for ordinary code review, file analysis, research, and other tasks without a special media ability. Capability targets are only for their named media ability.",
    promptSnippet: 'For ordinary code, file, research, or read-only work, explicitly select the configured temporary general agent with capability="temporary" and leave subagentId omitted/null/empty. Media targets are only for their named media tasks. For follow-ups, reuse an existing runId.',
    parameters: Type.Object({}),
    execute: async () => {
      const result = { ...options.controller!.catalog(), existing: options.controller!.list(eventSessionId, subagentRunId) };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }, {
    name: "dispatch_subagent",
    label: "Delegate to subagent",
    description: `Create a NEW agent session only when the parent cannot efficiently complete the work directly. The required reason and expectedResult fields must explain why delegation is needed, what concrete compact result is required, and which parent step depends on it. For ordinary code review, file analysis, research, or read-only work, explicitly choose capability="temporary" to use the configured temporary general agent. Choose a media capability only for a task that explicitly needs that named media ability. To select a saved profile, supply subagentId and omit capability or set it to null. Do not combine targets. Omitted/null capability with no profile also uses the temporary agent for legacy calls. Ordinary tasks run in the background by default; background permits parallel work but every created child blocks finalization until its result or failure is processed. Media tasks with a temporary attachment remain foreground. For follow-up questions, reuse the existing runId. The user's original attachments are forwarded by reference; do not download them before delegation. Background children remain attached to this parent conversation: their completion or failure is delivered at the next assistant-turn boundary after the current generation and tool batch, and the persistent ledger is restored after compaction or on the next run. Do not assume a background child was forgotten; use list_subagents or inspect_subagent to process it. The configured maximum of ${options.maxConcurrent ?? "the current"} is a simultaneous running limit.`,
    promptSnippet: 'Before dispatching, explain why the child is needed, what concrete result it must return, and which parent step depends on it. Do not dispatch simple work the parent can complete directly. Use capability="temporary" for ordinary code or research work and leave subagentId omitted/null/empty. Background execution allows independent work in parallel but still blocks finalization until every child result is processed. Reuse existing runIds with control_subagent follow_up for recoverable failures and follow-up work.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 120 }),
      task: Type.String({ minLength: 1, maxLength: 32_000 }),
      reason: Type.String({ minLength: 1, maxLength: 4_000 }),
      expectedResult: Type.String({ minLength: 1, maxLength: 8_000 }),
      capability: subagentTargetSchema,
      subagentId: subagentProfileSchema,
      mediaPath: Type.Optional(Type.String()),
      background: Type.Optional(Type.Boolean()),
    }),
    executionMode: "parallel",
    execute: async (toolCallId, params, signal) => {
      const input = params as SubagentSelection & { title: string; task: string; reason: string; expectedResult: string; mediaPath?: string; background?: boolean };
      if (!input.reason?.trim() || !input.expectedResult?.trim()) throw new Error("Subagent reason and expectedResult are required");
      const parentRunId = options.parentRunId();
      if (!parentRunId || !options.delegate) throw new Error("No active parent run");
      const background = input.background ?? !input.mediaPath;
      if (input.mediaPath && background) throw runtimeError("subagent-tools.a_subagent_receiving_a_temporary_video_file_must_wait", {});
      const mediaMimeType = input.mediaPath ? options.mediaMimeType(parentRunId, input.mediaPath) : undefined;
      if (input.mediaPath && !mediaMimeType) throw runtimeError("subagent-tools.mediapath_must_be_a_media_path_just_retrieved_by", {});
      const result = await options.delegate({
        parentSessionId: eventSessionId, parentRunId, parentSubagentId: subagentRunId, depth: subagentDepth + 1, toolCallId,
        title: input.title.trim(), task: input.task.trim(), subagentId: input.subagentId, capability: input.capability,
        mediaAttachment: input.mediaPath ? { type: "file", name: input.mediaPath.split(/[\\/]/).at(-1) ?? "video", mimeType: mediaMimeType!, data: "", localPath: input.mediaPath, temporary: true } : undefined,
        fallbackModel: modelName, permissionMode: options.permissionMode(), background, signal,
        reason: input.reason.trim(), expectedResult: input.expectedResult.trim(),
      });
      const completed = (() => {
        try { return JSON.parse(result) as { runId?: string }; } catch { return undefined; }
      })();
      const info = completed?.runId ? options.controller?.query(completed.runId) : undefined;
      return info ? subagentResultForModel(info) : { content: [{ type: "text", text: result }], details: {} };
    },
  }] : [];
  return [...inspectTools, ...delegateTool];
}
