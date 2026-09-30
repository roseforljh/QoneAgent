import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunPermissionMode } from "@qone/protocol";
import type { PiAdapter } from "./pi-adapter.js";
import type { SubagentController } from "./subagent-runner.js";
import { subagentResultForModel, subagentWorkflowResultForModel } from "./subagent-result.js";
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
    name: "inspect_subagent",
    label: "Inspect subagent",
    description: "Read a subagent's status, text result, generated images, streaming output and child IDs by run ID. Set includeMessages to read previous conversation text as well as the latest result.",
    promptSnippet: "Use inspect_subagent to read current progress or previous replies before following up with an existing agent.",
    parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }), includeMessages: Type.Optional(Type.Boolean()) }),
    execute: async (_toolCallId, params) => {
      const runId = (params as { runId: string }).runId;
      checkChild(runId);
      const result = options.controller!.query(runId);
      if (!result) throw new Error(`Unknown subagent ${runId}`);
      return subagentResultForModel(result, (params as { includeMessages?: boolean }).includeMessages);
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
      const result = await options.controller!.workflow(eventSessionId, parentRunId, input.steps, {
        model: modelName, permissionMode: options.permissionMode(), signal,
      });
      return subagentWorkflowResultForModel(result);
    },
  }, {
    name: "wait_subagent",
    label: "Wait for subagent",
    description: "Wait for a subagent to finish and return its current result.",
    promptSnippet: "Use wait_subagent after starting a background subagent when you need its final result.",
    parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }), timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 86_400_000 })) }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const input = params as { runId: string; timeoutMs?: number };
      checkChild(input.runId);
      const result = await options.controller!.wait(input.runId, input.timeoutMs, signal, subagentRunId);
      return subagentResultForModel(result);
    },
  }, {
    name: "control_subagent",
    label: "Control subagent",
    description: "Stop, resume, retry, steer or send a follow-up to an existing subagent session.",
    promptSnippet: "For follow-up questions about the same task or media, reuse the existing runId with follow_up, including after completion and in later user turns. Use steer to correct an active task. This retains the child conversation; do not dispatch a new agent merely because the previous turn completed.",
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
    description: `Create a NEW agent session. For ordinary code review, file analysis, research, or read-only work, explicitly choose capability="temporary" to use the configured temporary general agent. Choose a media capability only for a task that explicitly needs that named media ability. To select a saved profile, supply subagentId and omit capability or set it to null. Do not combine targets. Omitted/null capability with no profile also uses the temporary agent for legacy calls. For follow-up questions, reuse the existing runId. The user's original attachments are forwarded by reference; do not download them before delegation. The configured maximum of ${options.maxConcurrent ?? "the current"} is a simultaneous running limit.`,
    promptSnippet: 'Use dispatch_subagent with capability="temporary" for ordinary code or research work. Leave subagentId omitted/null/empty. Select media targets only for matching media tasks. Before creating an agent for a follow-up, recover existing runIds and use control_subagent follow_up.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 120 }),
      task: Type.String({ minLength: 1, maxLength: 32_000 }),
      capability: subagentTargetSchema,
      subagentId: subagentProfileSchema,
      mediaPath: Type.Optional(Type.String()),
      background: Type.Optional(Type.Boolean()),
    }),
    executionMode: "parallel",
    execute: async (toolCallId, params, signal) => {
      const input = params as SubagentSelection & { title: string; task: string; mediaPath?: string; background?: boolean };
      const parentRunId = options.parentRunId();
      if (!parentRunId || !options.delegate) throw new Error("No active parent run");
      if (input.mediaPath && input.background) throw new Error("传递临时视频文件的子代理必须等待完成，不能在后台运行");
      const mediaMimeType = input.mediaPath ? options.mediaMimeType(parentRunId, input.mediaPath) : undefined;
      if (input.mediaPath && !mediaMimeType) throw new Error("mediaPath 必须是当前子代理刚取得的媒体路径");
      const result = await options.delegate({
        parentSessionId: eventSessionId, parentRunId, parentSubagentId: subagentRunId, depth: subagentDepth + 1, toolCallId,
        title: input.title.trim(), task: input.task.trim(), subagentId: input.subagentId, capability: input.capability,
        mediaAttachment: input.mediaPath ? { type: "file", name: input.mediaPath.split(/[\\/]/).at(-1) ?? "video", mimeType: mediaMimeType!, data: "", localPath: input.mediaPath, temporary: true } : undefined,
        fallbackModel: modelName, permissionMode: options.permissionMode(), background: input.background, signal,
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
