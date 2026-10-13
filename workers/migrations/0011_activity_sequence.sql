ALTER TABLE ActivityLog ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT rowid AS event_rowid,
    ROW_NUMBER() OVER (ORDER BY created_at IS NOT NULL, created_at, id, rowid) AS assigned_seq
  FROM ActivityLog
)
UPDATE ActivityLog
SET seq = (SELECT assigned_seq FROM ranked WHERE ranked.event_rowid = ActivityLog.rowid);

CREATE TABLE ActivitySequence (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  last_seq INTEGER NOT NULL CHECK (
    typeof(last_seq) = 'integer'
    AND last_seq >= 0
    AND last_seq <= 9007199254740991
  )
);

INSERT INTO ActivitySequence (id, last_seq)
SELECT 1, COALESCE(MAX(seq), 0) FROM ActivityLog;

CREATE UNIQUE INDEX idx_activity_log_seq_unique ON ActivityLog(seq);
CREATE INDEX idx_activity_log_org_seq ON ActivityLog(org_id, seq);

CREATE TRIGGER trg_activity_sequence_insert_guard
BEFORE INSERT ON ActivityLog
WHEN NEW.seq != 0
BEGIN
  SELECT RAISE(ABORT, 'Activity sequence is assigned automatically');
END;

CREATE TRIGGER trg_activity_sequence_allocate
AFTER INSERT ON ActivityLog
WHEN NEW.seq = 0
BEGIN
  SELECT RAISE(ABORT, 'Activity sequence counter missing')
    WHERE NOT EXISTS (SELECT 1 FROM ActivitySequence WHERE id = 1);
  SELECT RAISE(ABORT, 'Activity sequence exhausted')
    WHERE (SELECT last_seq FROM ActivitySequence WHERE id = 1) >= 9007199254740991;

  UPDATE ActivitySequence
  SET last_seq = last_seq + 1
  WHERE id = 1;

  UPDATE ActivityLog
  SET seq = (SELECT last_seq FROM ActivitySequence WHERE id = 1)
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_activity_sequence_immutable
BEFORE UPDATE OF seq ON ActivityLog
WHEN OLD.seq != 0 AND NEW.seq != OLD.seq
BEGIN
  SELECT RAISE(ABORT, 'Activity sequence is immutable');
END;
