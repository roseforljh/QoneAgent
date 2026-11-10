ALTER TABLE messages ADD COLUMN raw_message TEXT;
ALTER TABLE tool_calls ADD COLUMN duration_ms INTEGER;
ALTER TABLE artifacts ADD COLUMN run_id TEXT;