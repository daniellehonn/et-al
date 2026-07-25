-- et al. v7 — spine schema
-- Source of truth. See docs/DATA-MODEL.md. D1 (SQLite).
-- Timestamps are unix-ms integers. IDs are text. actor is 'human' | 'ai:<name>'.

-- Workspaces: the strict tree. parent_id NULL = a root.
CREATE TABLE workspace (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES workspace(id),
  type         TEXT NOT NULL DEFAULT 'area',      -- area|project|course|organization
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'active',    -- active|paused|archived
  position     REAL NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_workspace_parent ON workspace(parent_id);

-- Objectives: planning layer. Nest via parent_objective_id.
CREATE TABLE objective (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  parent_objective_id  TEXT REFERENCES objective(id),
  title                TEXT NOT NULL,
  description          TEXT,
  status               TEXT NOT NULL DEFAULT 'active',  -- active|done|paused
  priority             INTEGER NOT NULL DEFAULT 1,       -- 0..3
  position             REAL NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_objective_workspace ON objective(workspace_id);
CREATE INDEX idx_objective_parent ON objective(parent_objective_id);

-- Tasks: execution units. May float without an objective.
CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  objective_id  TEXT REFERENCES objective(id),
  title         TEXT NOT NULL,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'todo',     -- todo|doing|blocked|done
  priority      INTEGER NOT NULL DEFAULT 1,
  due_date      INTEGER,
  estimate_min  INTEGER,
  actor         TEXT NOT NULL DEFAULT 'human',
  position      REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX idx_task_workspace ON task(workspace_id);
CREATE INDEX idx_task_objective ON task(objective_id);
CREATE INDEX idx_task_status ON task(status);

-- Documents: living artifacts. Body is ordered blocks.
CREATE TABLE document (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  title         TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'free',     -- design|architecture|roadmap|readme|note|free
  status        TEXT NOT NULL DEFAULT 'draft',    -- draft|active|archived
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_document_workspace ON document(workspace_id);

CREATE TABLE block (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES document(id),
  type          TEXT NOT NULL,                    -- paragraph|heading|bullet|numbered|todo|code|quote|divider|image
  content_json  TEXT NOT NULL DEFAULT '{}',
  position      REAL NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  is_ai         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_block_document ON block(document_id);

-- Retained prior block versions so a patch is reversible.
CREATE TABLE block_revision (
  id            TEXT PRIMARY KEY,
  block_id      TEXT NOT NULL REFERENCES block(id),
  content_json  TEXT NOT NULL,
  version       INTEGER NOT NULL,
  actor         TEXT NOT NULL DEFAULT 'human',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_block_revision_block ON block_revision(block_id);

-- An agent's proposed document change, awaiting Accept/Reject.
CREATE TABLE document_patch (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES document(id),
  ops_json      TEXT NOT NULL,                    -- ordered block ops
  summary       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|rejected
  actor         TEXT NOT NULL DEFAULT 'human',
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE INDEX idx_document_patch_document ON document_patch(document_id);
CREATE INDEX idx_document_patch_status ON document_patch(status);

-- Sources: raw inputs. `raw` is write-once.
CREATE TABLE source (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT REFERENCES workspace(id),    -- NULL while in inbox
  kind          TEXT NOT NULL,                    -- note|idea|url|pdf|youtube|book|image|voice|github|email|document
  title         TEXT,
  url           TEXT,
  r2_key        TEXT,
  raw           TEXT,                             -- immutable original payload
  metadata_json TEXT,
  status        TEXT NOT NULL DEFAULT 'inbox',    -- inbox|processing|processed
  actor         TEXT NOT NULL DEFAULT 'human',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_source_status ON source(status);
CREATE INDEX idx_source_workspace ON source(workspace_id);

-- Insights: atomic knowledge nodes. Carry an embedding id.
CREATE TABLE insight (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT REFERENCES workspace(id),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  source_id     TEXT REFERENCES source(id),
  embedding_id  TEXT,
  is_ai         INTEGER NOT NULL DEFAULT 0,
  actor         TEXT NOT NULL DEFAULT 'human',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_insight_workspace ON insight(workspace_id);
CREATE INDEX idx_insight_source ON insight(source_id);

-- Decisions: immutable events.
CREATE TABLE decision (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  title              TEXT NOT NULL,
  rationale          TEXT NOT NULL,
  alternatives_json  TEXT,
  impact             TEXT,
  decided_on         INTEGER NOT NULL,
  actor              TEXT NOT NULL DEFAULT 'human',
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_decision_workspace ON decision(workspace_id);

-- Relationships: the universal typed edge across any two objects.
CREATE TABLE relationship (
  id            TEXT PRIMARY KEY,
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  type          TEXT NOT NULL,                    -- references|uses|inspired_by|generated_from|related_to|learned_from|created_from|depends_on
  actor         TEXT NOT NULL DEFAULT 'human',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_relationship_source ON relationship(source_type, source_id);
CREATE INDEX idx_relationship_target ON relationship(target_type, target_id);

-- Daily 3: three slots per day + the day's tracking.
CREATE TABLE daily_focus_day (
  date          TEXT PRIMARY KEY,                 -- YYYY-MM-DD
  confirmed_at  INTEGER,
  reflection    TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE daily_focus_slot (
  id     TEXT PRIMARY KEY,
  date   TEXT NOT NULL REFERENCES daily_focus_day(date),
  slot   INTEGER NOT NULL,                        -- 1..3
  task_id TEXT NOT NULL REFERENCES task(id),
  status TEXT NOT NULL DEFAULT 'planned'          -- planned|done
);
CREATE INDEX idx_daily_focus_slot_date ON daily_focus_slot(date);

-- Audit trail. One row per mutation.
CREATE TABLE event (
  id            TEXT PRIMARY KEY,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,                    -- create|update|delete|complete|patch_proposed|...
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  detail_json   TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_event_entity ON event(entity_type, entity_id);
CREATE INDEX idx_event_created ON event(created_at);

-- Full-text search across the searchable entities. Rebuilt from canonical rows.
CREATE VIRTUAL TABLE search_fts USING fts5(
  entity_type UNINDEXED,
  entity_id   UNINDEXED,
  title,
  body
);
