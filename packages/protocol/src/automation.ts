import { z } from "zod";

/** When a scheduled task fires. Times are wall-clock local time on this computer. */
export type ScheduleRule =
  | { kind: "once"; at: number }
  | { kind: "daily"; time: string }
  /** `days` uses Date#getDay(): 0 is Sunday. */
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "interval"; minutes: number };

export type ScheduleRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** One time a task fired; it lives in the task's conversation. */
export interface ScheduleRunInfo {
  id: string;
  scheduleId: string;
  sessionId: string;
  startedAt: number;
  status: ScheduleRunStatus;
  error?: string;
}

export interface ScheduleInput {
  id?: string;
  title: string;
  prompt: string;
  workspaceId: string;
  rule: ScheduleRule;
  enabled: boolean;
  model?: string;
  permissionMode?: "ask" | "auto" | "full";
  thinking?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ScheduleInfo extends ScheduleInput {
  id: string;
  /** Conversation every run of this task is appended to. */
  sessionId?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  lastRunId?: string;
  lastStatus?: ScheduleRunStatus;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** One field of an MCP form request (the spec's flat primitive schema). */
export interface McpElicitationField {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title: string }[];
  items?: { enum?: string[]; anyOf?: { const: string; title: string }[] };
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
}

/** A pending question an MCP server asked the person while one of its tools runs. */
export interface McpElicitationInfo {
  id: string;
  serverId: string;
  serverName: string;
  /** Conversation whose tool call is waiting; shown above its composer. */
  sessionId?: string;
  message: string;
  mode: "form" | "url";
  url?: string;
  fields?: Record<string, McpElicitationField>;
  required?: string[];
  createdAt: number;
}

export type McpElicitationAction = "accept" | "decline" | "cancel";
export type McpElicitationContent = Record<string, string | number | boolean | string[]>;

export type AutomationCommand =
  | { type: "schedule.list"; requestId: string }
  | { type: "schedule.save"; requestId: string; schedule: ScheduleInput }
  | { type: "schedule.delete"; requestId: string; id: string }
  | { type: "schedule.run"; requestId: string; id: string }
  | { type: "mcp.elicitation.respond"; requestId: string; elicitationId: string; action: McpElicitationAction; content?: McpElicitationContent };

export type AutomationEvent =
  | { type: "schedule.list"; requestId?: string; schedules: ScheduleInfo[]; runs: ScheduleRunInfo[] }
  | { type: "mcp.elicitations"; requests: McpElicitationInfo[] };

const request = { requestId: z.string().min(1), locale: z.enum(["en", "zh-CN"]).optional() };
const id = z.string().min(1).max(200);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const rule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.number().int().positive() }),
  z.object({ kind: z.literal("daily"), time }),
  z.object({ kind: z.literal("weekly"), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), time }),
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(5).max(60 * 24 * 30) }),
]);
const schedule = z.object({
  id: id.optional(),
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(32_000),
  workspaceId: id,
  rule,
  enabled: z.boolean(),
  model: z.string().max(512).optional(),
  permissionMode: z.enum(["ask", "auto", "full"]).optional(),
  thinking: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
});
const contentValue = z.union([z.string().max(100_000), z.number(), z.boolean(), z.array(z.string().max(10_000)).max(200)]);

export const automationCommandSchemas = {
  "schedule.list": z.object({ type: z.literal("schedule.list"), ...request }),
  "schedule.save": z.object({ type: z.literal("schedule.save"), ...request, schedule }),
  "schedule.delete": z.object({ type: z.literal("schedule.delete"), ...request, id }),
  "schedule.run": z.object({ type: z.literal("schedule.run"), ...request, id }),
  "mcp.elicitation.respond": z.object({
    type: z.literal("mcp.elicitation.respond"), ...request, elicitationId: id,
    action: z.enum(["accept", "decline", "cancel"]), content: z.record(z.string(), contentValue).optional(),
  }),
};
