ALTER TABLE sessions ADD COLUMN last_user_message_at INTEGER NOT NULL DEFAULT 0;

UPDATE sessions
SET last_user_message_at = COALESCE(
  (SELECT MAX(created_at)
   FROM messages
   WHERE messages.session_id = sessions.id
     AND messages.role = 'user'),
  created_at
);
