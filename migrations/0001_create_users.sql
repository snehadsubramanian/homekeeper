-- The allow-listed people who can sign in.
-- refresh_token_enc, tasklist_id and last_synced_at are filled in by later steps.
CREATE TABLE users (
  id                INTEGER PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name      TEXT,
  google_sub        TEXT NOT NULL UNIQUE,
  refresh_token_enc TEXT,
  tasklist_id       TEXT,
  last_synced_at    TEXT,
  created_at        TEXT NOT NULL
);
