ALTER TABLE tool_calls ADD COLUMN parent_tool_call_id TEXT;
ALTER TABLE tool_calls ADD COLUMN server_operation TEXT;
ALTER TABLE subagent_runs ADD COLUMN server_ids TEXT;
