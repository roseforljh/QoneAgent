CREATE TABLE subagent_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  title TEXT NOT NULL,
  task TEXT NOT NULL,
  model TEXT,
  content TEXT NOT NULL DEFAULT '',
  parts TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_subagent_runs_parent ON subagent_runs(parent_session_id, parent_run_id);

CREATE TABLE subagent_messages (
  id TEXT PRIMARY KEY,
  subagent_run_id TEXT NOT NULL REFERENCES subagent_runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  parts TEXT,
  raw_message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_subagent_messages_run ON subagent_messages(subagent_run_id, sequence);