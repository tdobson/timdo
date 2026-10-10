-- A report retry is identified at the database boundary, so concurrent calls can create one note.
-- Ordinary notes keep a NULL key and are not deduplicated.
ALTER TABLE TaskUpdates ADD COLUMN dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_updates_dedupe_key
  ON TaskUpdates(task_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
