-- Duties, their occurrences, and each person's Google Task for an occurrence.
-- See the data model in the architecture. Dates are YYYY-MM-DD in the household
-- time zone; *_at columns are UTC ISO timestamps.

-- What needs doing and how often.
CREATE TABLE duties (
  id                  INTEGER PRIMARY KEY,
  title               TEXT NOT NULL,
  notes               TEXT,
  links               TEXT,    -- JSON array of URLs
  owner               TEXT NOT NULL CHECK (owner IN ('user', 'joint')),
  owner_user_id       INTEGER REFERENCES users (id),
  joint_mode          TEXT CHECK (joint_mode IN ('any', 'all')),
  cadence             TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'semiannual', 'yearly')),
  cadence_months      TEXT,    -- JSON array of named months, e.g. [4,10]
  anchor_mode         TEXT NOT NULL CHECK (anchor_mode IN ('fixed', 'after_completion')),
  last_done_date      TEXT,
  last_done_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (last_done_precision IN ('day', 'month', 'year', 'unknown')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  -- The one-time token from the form that created this duty, so a double submit creates one duty.
  create_token        TEXT UNIQUE,
  created_at          TEXT NOT NULL
);

-- One instance of a duty. slot_date is when it was originally due; due_date is
-- its current date (after roll-forward).
CREATE TABLE occurrences (
  id             INTEGER PRIMARY KEY,
  duty_id        INTEGER NOT NULL REFERENCES duties (id),
  slot_date      TEXT NOT NULL,
  due_date       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('open', 'done', 'skipped', 'cancelled')),
  completed_date TEXT
);

-- Exactly one open occurrence per duty: this is the merge rule.
CREATE UNIQUE INDEX occurrences_one_open_per_duty ON occurrences (duty_id) WHERE status = 'open';

-- One person's Google Task for an occurrence. google_task_id is NULL until the
-- task has been created in Google (sync retries any that failed).
CREATE TABLE assignments (
  id                 INTEGER PRIMARY KEY,
  occurrence_id      INTEGER NOT NULL REFERENCES occurrences (id),
  user_id            INTEGER NOT NULL REFERENCES users (id),
  google_task_id     TEXT,
  status             TEXT NOT NULL CHECK (status IN ('open', 'done', 'removed')),
  completed_date     TEXT,
  moved_in_google_to TEXT,
  moved_in_google_at TEXT,
  UNIQUE (occurrence_id, user_id)
);

CREATE INDEX assignments_by_user ON assignments (user_id, status);
