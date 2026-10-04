ALTER TABLE runs ADD COLUMN finalization_authorized INTEGER NOT NULL DEFAULT 0;

ALTER TABLE subagent_runs ADD COLUMN required_before_final INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subagent_runs ADD COLUMN failure_kind TEXT;
ALTER TABLE subagent_runs ADD COLUMN dependency_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE subagent_runs ADD COLUMN completion_acknowledged INTEGER NOT NULL DEFAULT 0;
