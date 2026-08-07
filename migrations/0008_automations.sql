-- User-defined recurring tasks. The Daily 3 nudges are two hard-coded prompts;
-- this generalises them so "every Friday, summarise what I shipped" is a row
-- rather than a code change.
--
-- next_run_at is stored rather than computed on read: the hourly scheduled()
-- handler needs to find due rows with an index, not evaluate a cron expression
-- against every row.
CREATE TABLE automation (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  schedule      TEXT NOT NULL,              -- 5-field cron, evaluated in `timezone`
  timezone      TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  task          TEXT NOT NULL,              -- what to do, in plain language
  action        TEXT NOT NULL DEFAULT 'message', -- message | digest
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   INTEGER,
  next_run_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_automation_due ON automation(enabled, next_run_at);

CREATE TABLE automation_run (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automation(id),
  status        TEXT NOT NULL,              -- ok | error
  result        TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_automation_run_automation ON automation_run(automation_id, created_at);
