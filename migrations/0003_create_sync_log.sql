-- TEMPORARY (Step 3 round-trip spike): every task change the sync job sees.
-- Dropped when Step 5 replaces the spike with real occurrences and assignments.
-- (google_task_id, google_updated) is unique, so overlapping sync windows
-- never log the same version of a task twice.
CREATE TABLE sync_log (
  id             INTEGER PRIMARY KEY,
  seen_at        TEXT NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users (id),
  google_task_id TEXT NOT NULL,
  title          TEXT,
  status         TEXT,
  due_date       TEXT,
  completed_date TEXT,
  completed_at   TEXT,
  deleted        INTEGER NOT NULL DEFAULT 0,
  hidden         INTEGER NOT NULL DEFAULT 0,
  google_updated TEXT NOT NULL,
  UNIQUE (google_task_id, google_updated)
);

CREATE INDEX sync_log_by_user ON sync_log (user_id, id);
