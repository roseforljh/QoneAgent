import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default("New session"),
    workspaceId: text("workspace_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_sessions_workspace").on(t.workspaceId)]
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    role: text("role").notNull(), // user | assistant | system | tool
    content: text("content").notNull(),
    parts: text("parts"), // ordered visible Pi assistant parts; null for legacy messages
    attachments: text("attachments"),
    model: text("model"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_messages_session").on(t.sessionId)]
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // created | running | waiting_approval | paused | completed | failed | cancelled | interrupted
    status: text("status").notNull().default("created"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    error: text("error"),
  },
  (t) => [index("idx_runs_session").on(t.sessionId)]
);

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    arguments: text("arguments"), // JSON
    resultSummary: text("result_summary"),
    // queued | running | success | failed | cancelled | waiting_approval
    status: text("status").notNull().default("queued"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
  },
  (t) => [index("idx_tool_calls_run").on(t.runId)]
);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    mimeType: text("mime_type"),
    size: integer("size"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_artifacts_session").on(t.sessionId)]
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON
  updatedAt: integer("updated_at").notNull(),
});

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    status: text("status").notNull().default("running"),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [index("idx_turns_run").on(t.runId)]
);

export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  manifest: text("manifest").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at").notNull(),
});

export const pluginPermissions = sqliteTable(
  "plugin_permissions",
  {
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    decision: text("decision").notNull().default("ask"),
  },
  (t) => [
    primaryKey({ columns: [t.pluginId, t.permission] }),
    index("idx_plugin_permissions_plugin").on(t.pluginId),
  ]
);

// Product-level permission overrides. subjectId is stable and namespaced:
// builtin, plugin:<id>, or mcp:<id>. Keeping this separate from the legacy
// plugin_permissions table also lets MCP and built-in tools be managed without
// inventing a fake plugin row.
export const permissionRules = sqliteTable(
  "permission_rules",
  {
    subjectId: text("subject_id").notNull(),
    permission: text("permission").notNull(),
    decision: text("decision").notNull().default("ask"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectId, t.permission] }),
    index("idx_permission_rules_subject").on(t.subjectId),
  ],
);

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  config: text("config").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at").notNull(),
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  description: text("description"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at").notNull(),
});

export const modelConfigs = sqliteTable("model_configs", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  config: text("config").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    eventId: text("event_id").primaryKey(),
    sessionId: text("session_id"),
    runId: text("run_id"),
    sequence: integer("sequence").notNull().unique(),
    type: text("type").notNull(),
    timestamp: integer("timestamp").notNull(),
    payload: text("payload").notNull(),
  },
  (t) => [index("idx_events_session_sequence").on(t.sessionId, t.sequence)]
);
