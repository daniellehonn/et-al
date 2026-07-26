-- Customizable workspace Overview: an ordered list of widgets per workspace.
-- config_json holds type-specific data (table columns/rows, a title, text, …).
CREATE TABLE overview_block (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  type          TEXT NOT NULL,              -- table | child_progress | tasks | text | progress
  config_json   TEXT NOT NULL DEFAULT '{}',
  position      REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_overview_block_workspace ON overview_block(workspace_id);
