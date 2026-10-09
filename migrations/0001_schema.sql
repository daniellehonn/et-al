-- et al. — the whole schema.
--
-- Five things: notes (what you write), tasks (what you're doing), sources (what
-- you saved), proposals (what an agent or the extractor suggests), and the
-- event log (who wrote what). Blocks are a note's body.
--
-- The trust model is in the shape of the tables, not in filters on top of them:
-- an agent's suggestion is a `proposal` row, so it cannot surface in search,
-- context or the note tree until a human accepts it and it becomes real.

-- ── Notes ────────────────────────────────────────────────────────────────────

CREATE TABLE note (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES note(id),   -- NULL = a root note
  title       TEXT NOT NULL DEFAULT '',
  position    REAL NOT NULL DEFAULT 0,
  source_id   TEXT,                       -- set when the note was accepted from an extracted insight
  actor       TEXT NOT NULL,              -- 'human' | 'ai:<client>' | 'system'
  trashed_at  INTEGER,                    -- set on a trashed note and everything under it
  trash_root  INTEGER NOT NULL DEFAULT 0, -- 1 on the note the user actually trashed
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_note_parent ON note(parent_id, position);

-- A note's body. Nested: parent_block_id gives toggles, sub-bullets and the like.
CREATE TABLE block (
  id              TEXT PRIMARY KEY,
  note_id         TEXT NOT NULL REFERENCES note(id),
  parent_block_id TEXT REFERENCES block(id),
  type            TEXT NOT NULL,          -- paragraph|heading|bullet|numbered|todo|code|quote|divider|image|table|page_link
  content_json    TEXT NOT NULL DEFAULT '{}',
  position        REAL NOT NULL DEFAULT 0,
  version         INTEGER NOT NULL DEFAULT 1,
  actor           TEXT NOT NULL,          -- who wrote this version: an accepted patch keeps its agent
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_block_note ON block(note_id, position);

-- Prior versions of a block, so any edit — including an accepted patch — can be undone.
CREATE TABLE block_revision (
  id           TEXT PRIMARY KEY,
  block_id     TEXT NOT NULL REFERENCES block(id),
  content_json TEXT NOT NULL,
  version      INTEGER NOT NULL,
  actor        TEXT NOT NULL,             -- who wrote the version being kept
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_block_revision_block ON block_revision(block_id);

-- ── Tasks ────────────────────────────────────────────────────────────────────

CREATE TABLE task (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'todo',  -- todo|doing|done
  due_at       INTEGER,
  parent_id    TEXT REFERENCES task(id),      -- a subtask
  note_id      TEXT REFERENCES note(id),      -- the note it belongs to, if any
  position     REAL NOT NULL DEFAULT 0,
  actor        TEXT NOT NULL,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_task_parent ON task(parent_id, position);
CREATE INDEX idx_task_note ON task(note_id);

-- ── Sources ──────────────────────────────────────────────────────────────────

CREATE TABLE source (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  url          TEXT,
  text         TEXT,                          -- what was typed or shared alongside it
  status       TEXT NOT NULL DEFAULT 'inbox', -- inbox|done
  note_id      TEXT REFERENCES note(id),      -- where it was filed
  fetch_status TEXT,                          -- NULL (nothing to fetch)|pending|fetched|failed
  fetch_error  TEXT,
  site         TEXT,
  description  TEXT,
  image        TEXT,
  actor        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_source_status ON source(status, created_at);
CREATE INDEX idx_source_note ON source(note_id);

-- ── Proposals ────────────────────────────────────────────────────────────────
-- kind 'patch':   an agent's change to a note's body. payload = {ops: BlockOp[]}
-- kind 'insight': a fact the extractor drew from a source. payload = {title, content, segment, importance}
-- Accepting applies the patch, or creates a note from the insight (result_id).

CREATE TABLE proposal (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  note_id     TEXT REFERENCES note(id),        -- the note a patch targets
  source_id   TEXT REFERENCES source(id),      -- the source an insight came from
  summary     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected
  actor       TEXT NOT NULL,                   -- who proposed it
  result_id   TEXT,                            -- the note an accepted insight became
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_proposal_status ON proposal(status, created_at);
CREATE INDEX idx_proposal_note ON proposal(note_id);

-- ── Event log ────────────────────────────────────────────────────────────────

CREATE TABLE event (
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,   -- note|task|source|proposal
  entity_id   TEXT NOT NULL,
  detail_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_event_entity ON event(entity_type, entity_id);
CREATE INDEX idx_event_actor ON event(actor, created_at);

-- ── Search ───────────────────────────────────────────────────────────────────
-- Keyword half of hybrid search. Only real things are indexed: notes, tasks and
-- sources. Proposals never are. Vectorize holds the semantic half.

CREATE VIRTUAL TABLE search_fts USING fts5(
  entity_type UNINDEXED,
  entity_id   UNINDEXED,
  title,
  body
);
