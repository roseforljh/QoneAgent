CREATE TABLE subagent_notifications (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  subagent_run_id TEXT NOT NULL REFERENCES subagent_runs(run_id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL,
  summary_preview TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  acknowledged_at INTEGER
);
CREATE INDEX idx_subagent_notifications_session_status ON subagent_notifications(session_id, status);
CREATE INDEX idx_subagent_notifications_run ON subagent_notifications(subagent_run_id);
