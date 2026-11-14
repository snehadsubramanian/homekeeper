-- One row per background-job run, for troubleshooting and the status line.
-- ok is 1 for success, 0 for failure, and NULL while running (or if the run died).
CREATE TABLE job_runs (
  id          INTEGER PRIMARY KEY,
  job         TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER,
  error       TEXT
);

CREATE INDEX job_runs_by_job ON job_runs (job, started_at);
