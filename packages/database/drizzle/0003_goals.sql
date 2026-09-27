ALTER TABLE messages ADD COLUMN goal_id TEXT;
ALTER TABLE runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE runs ADD COLUMN goal_id TEXT;
ALTER TABLE runs ADD COLUMN goal_epoch INTEGER;

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  waiting_reason TEXT,
  waiting_until INTEGER,
  stop_reason TEXT,
  run_options TEXT,
  epoch INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_goals_session ON goals(session_id);

CREATE TABLE goal_events (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_goal_events_goal ON goal_events(goal_id, created_at);
