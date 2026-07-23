-- Migration 0007: schema v6 — D1 becomes the CANONICAL store.
--
-- This inverts the v5 arrangement. Through 0006, R2 held the truth and every
-- table here was a rebuildable projection of it. From v6 on:
--
--   D1  = canonical relational data (this file)
--   R2  = assets, imports, and Markdown *exports* / snapshots
--   Vectorize = embeddings for semantic search (vectors live outside D1;
--               `embeddings` below only tracks what has been indexed)
--
-- Consequently `POST /api/reindex` is no longer a recovery path — it becomes an
-- export/verify tool. Losing D1 now means losing data, so exports matter.
--
-- The v5 vault is intentionally wiped rather than converted (see
-- docs/v6-redesign.md): one generic `page` type cannot be mechanically split
-- into the typed entities below without inventing data.
--
-- Design notes:
--   * Lifecycle vocabularies are per-type (CHECK constraints), not one shared
--     status enum bent to fit five different jobs.
--   * Typed metadata lives in these tables; expressive prose lives in
--     `documents` -> ordered `document_blocks`.
--   * High-volume typed links get real join tables (project_areas,
--     project_goals). Everything semantic goes in the generic `relations` table.
--   * `user_id` is on every table from day one even though this launches
--     single-user, so authorization boundaries never have to be retrofitted.

DROP TABLE IF EXISTS pages_fts;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS pages;
DROP TABLE IF EXISTS spaces;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT,
  name       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Structure: Life Areas -> Goals -> Projects
-- ---------------------------------------------------------------------------

-- Long-term identities/responsibilities with no natural completion date.
-- The successor to v5's `spaces` (folders-as-context), but a real entity:
-- Areas are filters and context, never top-level workspaces.
CREATE TABLE areas (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  accent      TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  sort        INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_areas_user   ON areas(user_id);
CREATE UNIQUE INDEX idx_areas_name ON areas(user_id, name);

-- Measurable direction inside an Area: answers *why* a project matters.
CREATE TABLE goals (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  area_id       TEXT,                     -- primary Area (a goal has exactly one)
  title         TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'outcome' CHECK (type IN ('outcome','habit','identity')),
  timeframe     TEXT CHECK (timeframe IS NULL OR timeframe IN ('quarter','year','long-term')),
  metric_name   TEXT,
  target_value  REAL,
  current_value REAL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE SET NULL
);
CREATE INDEX idx_goals_user   ON goals(user_id);
CREATE INDEX idx_goals_area   ON goals(area_id);
CREATE INDEX idx_goals_status ON goals(status);

-- Finite efforts intended to produce an outcome. An `active` project MUST have
-- a next_action — enforced in the store layer (a CHECK cannot express it
-- cleanly across status transitions), and surfaced in the UI before activation.
CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  title            TEXT NOT NULL,
  summary          TEXT,                  -- one-sentence outcome
  status           TEXT NOT NULL DEFAULT 'idea'
                     CHECK (status IN ('idea','planned','active','paused','completed','archived')),
  priority         TEXT CHECK (priority IS NULL OR priority IN ('low','medium','high')),
  next_action      TEXT,                  -- required while status='active'
  start_date       INTEGER,
  target_date      INTEGER,
  repository_url   TEXT,
  live_url         TEXT,
  cover_asset_id   TEXT,
  body_document_id TEXT,                  -- flexible overview document
  portfolio_ready  INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER,               -- drives stale detection
  completed_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_projects_user     ON projects(user_id);
CREATE INDEX idx_projects_status   ON projects(status);
CREATE INDEX idx_projects_updated  ON projects(updated_at DESC);
CREATE INDEX idx_projects_activity ON projects(last_activity_at);

-- One activity can serve several identities (spec 1.5): many-to-many by design.
CREATE TABLE project_areas (
  project_id TEXT NOT NULL,
  area_id    TEXT NOT NULL,
  PRIMARY KEY (project_id, area_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (area_id)    REFERENCES areas(id)    ON DELETE CASCADE
);
CREATE INDEX idx_project_areas_area ON project_areas(area_id);

CREATE TABLE project_goals (
  project_id TEXT NOT NULL,
  goal_id    TEXT NOT NULL,
  PRIMARY KEY (project_id, goal_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id)    REFERENCES goals(id)    ON DELETE CASCADE
);
CREATE INDEX idx_project_goals_goal ON project_goals(goal_id);

-- ---------------------------------------------------------------------------
-- Execution: the engineer's log
-- ---------------------------------------------------------------------------

-- Separate records (not just blocks) so they can be filtered, searched,
-- related, and converted into content.
CREATE TABLE project_logs (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  entry_type          TEXT NOT NULL DEFAULT 'progress'
                        CHECK (entry_type IN ('progress','decision','experiment','problem','learning','reflection')),
  title               TEXT,               -- derived from first line when absent
  body_document_id    TEXT,
  content_seed_status TEXT NOT NULL DEFAULT 'none'
                        CHECK (content_seed_status IN ('none','suggested','created')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_logs_project ON project_logs(project_id, created_at DESC);
CREATE INDEX idx_logs_type    ON project_logs(entry_type);
CREATE INDEX idx_logs_seed    ON project_logs(content_seed_status);

-- ---------------------------------------------------------------------------
-- Knowledge
-- ---------------------------------------------------------------------------

-- Durable explanations. `mastery` makes learning progress visible; AI-generated
-- prose is tracked in `ai_sections` so it can be labeled and never passed off
-- as the user's own understanding.
CREATE TABLE knowledge_notes (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  title            TEXT NOT NULL,
  title_norm       TEXT NOT NULL,         -- link-resolution key (carried over from v5)
  note_type        TEXT NOT NULL DEFAULT 'concept'
                     CHECK (note_type IN ('concept','how-to','reference','comparison','question','mental-model')),
  mastery          TEXT NOT NULL DEFAULT 'captured'
                     CHECK (mastery IN ('captured','learning','understood','applied')),
  body_document_id TEXT,
  ai_sections      TEXT NOT NULL DEFAULT '{}',  -- JSON: which sections are AI-generated
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_notes_user    ON knowledge_notes(user_id);
CREATE INDEX idx_notes_mastery ON knowledge_notes(mastery);
CREATE INDEX idx_notes_norm    ON knowledge_notes(title_norm);
CREATE INDEX idx_notes_updated ON knowledge_notes(updated_at DESC);

-- ---------------------------------------------------------------------------
-- Intake: captures -> AI proposals -> approved records
-- ---------------------------------------------------------------------------

-- A Capture is immutable raw input recorded before its destination is known.
-- `raw_input` is written once and never mutated by processing, so the original
-- always survives a failed or bad extraction.
CREATE TABLE captures (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  raw_input          TEXT NOT NULL,       -- write-once
  input_type         TEXT NOT NULL DEFAULT 'text'
                       CHECK (input_type IN ('text','url','image','audio','file')),
  source_url         TEXT,
  platform           TEXT,
  asset_id           TEXT,                -- R2 payload for image/audio/file
  processing_status  TEXT NOT NULL DEFAULT 'unprocessed'
                       CHECK (processing_status IN ('unprocessed','processing','ready','failed')),
  processing_error   TEXT,
  classification     TEXT CHECK (classification IS NULL OR classification IN
                       ('project-idea','tool','knowledge','content-idea','task','reference','other')),
  review_status      TEXT NOT NULL DEFAULT 'pending'
                       CHECK (review_status IN ('pending','accepted','partially-accepted','dismissed')),
  proposal_bundle_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_captures_user    ON captures(user_id);
CREATE INDEX idx_captures_review  ON captures(review_status);
CREATE INDEX idx_captures_proc    ON captures(processing_status);
CREATE INDEX idx_captures_created ON captures(created_at DESC);

-- What the AI wants to create, shown to the user before anything is written.
CREATE TABLE proposal_bundles (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  capture_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','applied','partially-applied','dismissed')),
  model         TEXT,                     -- model id used for extraction
  prompt_version TEXT,
  schema_version TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);
CREATE INDEX idx_bundles_user    ON proposal_bundles(user_id);
CREATE INDEX idx_bundles_capture ON proposal_bundles(capture_id);
CREATE INDEX idx_bundles_status  ON proposal_bundles(status);

-- One row per proposed object/relation. `confidence` drives review routing:
-- low-confidence never auto-applies, and only metadata changes may auto-apply
-- at all (see docs/v6-implementation-plan.md, Decision F).
CREATE TABLE proposed_changes (
  id              TEXT PRIMARY KEY,
  bundle_id       TEXT NOT NULL,
  change_kind     TEXT NOT NULL CHECK (change_kind IN ('create','update','relate')),
  target_type     TEXT NOT NULL,          -- project | tool | knowledge_note | source | content_item | relation
  target_id       TEXT,                   -- set for update/relate, and after a create is applied
  payload         TEXT NOT NULL DEFAULT '{}',  -- JSON, schema-validated before insert
  confidence      REAL,
  is_metadata_only INTEGER NOT NULL DEFAULT 0, -- only these are ever auto-approvable
  duplicate_of_id TEXT,                   -- dedupe candidate, if any
  review_status   TEXT NOT NULL DEFAULT 'pending'
                    CHECK (review_status IN ('pending','accepted','edited','rejected','auto-applied')),
  applied_at      INTEGER,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (bundle_id) REFERENCES proposal_bundles(id) ON DELETE CASCADE
);
CREATE INDEX idx_changes_bundle ON proposed_changes(bundle_id);
CREATE INDEX idx_changes_review ON proposed_changes(review_status);

-- ---------------------------------------------------------------------------
-- Curation: tools, sources, content
-- ---------------------------------------------------------------------------

-- Saved tools move through a deliberate test lifecycle so the library cannot
-- decay into a link graveyard. `expected_use` is prompted at save/shortlist and
-- a written `verdict` is required before tested/adopted/rejected.
CREATE TABLE tools (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  url           TEXT,
  status        TEXT NOT NULL DEFAULT 'saved'
                  CHECK (status IN ('saved','shortlisted','testing','tested','adopted','rejected')),
  expected_use  TEXT,
  test_criteria TEXT,
  verdict       TEXT,                     -- required before tested/adopted/rejected
  rating        INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  source_id     TEXT,                     -- where it was discovered
  tested_at     INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_tools_user   ON tools(user_id);
CREATE INDEX idx_tools_status ON tools(status);

-- External material the user consumed. Distinct from the knowledge created
-- from it. `processing_version` allows reprocessing after prompt/model changes.
CREATE TABLE sources (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  title              TEXT NOT NULL,
  url                TEXT,
  platform           TEXT NOT NULL DEFAULT 'other'
                       CHECK (platform IN ('youtube','tiktok','instagram','article','paper','book','podcast','other')),
  author             TEXT,
  published_at       INTEGER,
  transcript         TEXT,                -- when legally + technically available
  summary            TEXT,                -- AI-generated; labeled as such in UI
  capture_id         TEXT,
  processing_version TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE SET NULL
);
CREATE INDEX idx_sources_user     ON sources(user_id);
CREATE INDEX idx_sources_platform ON sources(platform);

-- Distinguishes an idea from an actual publication. Provenance back to the work
-- that created it is preserved via `relations` (origin relations).
CREATE TABLE content_items (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'idea'
                     CHECK (status IN ('idea','draft','review','scheduled','published','archived')),
  format           TEXT CHECK (format IS NULL OR format IN
                     ('short-post','thread','video','article','newsletter','case-study')),
  channel          TEXT CHECK (channel IS NULL OR channel IN
                     ('linkedin','x','medium','substack','youtube','instagram','tiktok','portfolio')),
  hook             TEXT,
  audience         TEXT,
  body_document_id TEXT,
  published_url    TEXT,
  published_at     INTEGER,
  scheduled_for    INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_content_user   ON content_items(user_id);
CREATE INDEX idx_content_status ON content_items(status);

-- ---------------------------------------------------------------------------
-- Documents and blocks (the writing surface)
-- ---------------------------------------------------------------------------

-- A document is owned by exactly one record (project overview, log entry,
-- note body, content draft). Blocks are ordered rows so they can be queried
-- and converted (e.g. a Learning block -> a Knowledge Note) without parsing.
CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  owner_type  TEXT NOT NULL,              -- project | project_log | knowledge_note | content_item | area
  owner_id    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_documents_owner ON documents(owner_type, owner_id);

CREATE TABLE document_blocks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  position    INTEGER NOT NULL,           -- dense ordering, rewritten on reorder
  type        TEXT NOT NULL,              -- paragraph|heading|bullet|todo|code|quote|callout|image|table
                                          -- |decision|experiment|learning|content-seed|relation|tool-card|log-ref
  text        TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL DEFAULT '{}', -- JSON: block-type-specific fields
  is_ai       INTEGER NOT NULL DEFAULT 0, -- AI-generated content is labeled, never silent
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_blocks_doc  ON document_blocks(document_id, position);
CREATE INDEX idx_blocks_type ON document_blocks(type);

-- ---------------------------------------------------------------------------
-- Relations (the generic semantic graph)
-- ---------------------------------------------------------------------------

-- Everything can connect, but not everything is the same thing: strongly typed
-- high-volume links use the join tables above; this carries semantic edges.
-- Generalizes v5's `links` table, including unresolved [[wikilink]] targets
-- (target_id NULL until the page is created).
CREATE TABLE relations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  target_norm  TEXT,                      -- normalized title, for unresolved links
  relation_type TEXT NOT NULL,            -- learned-from|used-in|prerequisite-of|inspired-by|created-from|mentions
  context      TEXT NOT NULL DEFAULT '',  -- the line it appeared in (backlink preview)
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_relations_source ON relations(source_type, source_id);
CREATE INDEX idx_relations_target ON relations(target_type, target_id);
CREATE INDEX idx_relations_norm   ON relations(target_norm);
CREATE INDEX idx_relations_type   ON relations(relation_type);

-- ---------------------------------------------------------------------------
-- Assets, jobs, embeddings, audit
-- ---------------------------------------------------------------------------

CREATE TABLE assets (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  r2_key       TEXT NOT NULL,             -- assets/{asset_id}/{filename}
  filename     TEXT,
  content_type TEXT,
  size_bytes   INTEGER,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_assets_user ON assets(user_id);

-- Durable queue bookkeeping. `job_key` is the idempotency key so a retried or
-- duplicated message never produces duplicate output.
CREATE TABLE processing_jobs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  job_key       TEXT NOT NULL UNIQUE,
  job_type      TEXT NOT NULL,            -- fetch|transcribe|extract|embed|export
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','succeeded','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  failure_stage TEXT,
  error         TEXT,
  duration_ms   INTEGER,
  token_usage   INTEGER,
  version       TEXT,                     -- prompt/model/parser/schema version
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_jobs_status  ON processing_jobs(status);
CREATE INDEX idx_jobs_subject ON processing_jobs(subject_type, subject_id);

-- Tracks what has been pushed to Vectorize. The vectors themselves live in
-- Vectorize, so this is best-effort metadata: never gate a read on it.
CREATE TABLE embeddings (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  vector_id    TEXT NOT NULL,             -- id in the Vectorize index
  model        TEXT NOT NULL,
  content_hash TEXT,                      -- skip re-embedding unchanged content
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_embeddings_subject ON embeddings(subject_type, subject_id);

-- Which proposal created or modified each record (spec 3.2: audit trail).
CREATE TABLE audit_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  action        TEXT NOT NULL,            -- created|updated|deleted|status-changed
  actor         TEXT NOT NULL DEFAULT 'user' CHECK (actor IN ('user','ai','system')),
  bundle_id     TEXT,                     -- the proposal responsible, if any
  change_id     TEXT,
  detail        TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_audit_subject ON audit_events(subject_type, subject_id);
CREATE INDEX idx_audit_bundle  ON audit_events(bundle_id);

-- ---------------------------------------------------------------------------
-- Full-text search
-- ---------------------------------------------------------------------------

-- One row per searchable object (title + flattened body). Maintained by the
-- store layer, not triggers, because bodies are assembled from block rows.
CREATE VIRTUAL TABLE documents_fts USING fts5(
  subject_id UNINDEXED,
  subject_type UNINDEXED,
  title,
  body
);
