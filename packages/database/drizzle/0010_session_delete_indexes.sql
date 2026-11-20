CREATE INDEX IF NOT EXISTS idx_goal_events_session ON goal_events(session_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_run ON subagent_runs(parent_run_id);
