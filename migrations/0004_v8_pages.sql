-- et al. v8 — the page/collection model.
--
-- v7 had seven first-class entity types, each with its own table and its own UI
-- tab. That is the thing that made et al. unpleasant to live in: the app decided
-- the shape of a project, and you tabbed around it instead of reading it.
--
-- v8 has two primitives, the same two Notion has:
--   page       — a title, an icon, a body of blocks, and child pages. Nests
--                freely. A workspace and a document are both just pages now.
--   collection — a set of pages with typed properties and saved views.
--
-- Tasks, sources, insights and decisions stop being tables and become pages
-- inside collections. What keeps the agent layer alive is `collection.role`: a
-- well-known tag ('tasks', 'sources', …) that lets list_tasks / weekly_review /
-- suggest_daily3 keep working as property queries. Structure becomes yours to
-- author; the typed surface agents rely on stays intact.
--
-- v7 tables are renamed to legacy_* rather than dropped, so this is reversible.

-- ── New primitives ───────────────────────────────────────────────────────────

CREATE TABLE page (
  id              TEXT PRIMARY KEY,
  parent_page_id  TEXT REFERENCES page(id),        -- NULL = a root page
  collection_id   TEXT,                            -- set when this page is a row in a collection
  title           TEXT NOT NULL DEFAULT '',
  icon            TEXT,
  cover           TEXT,
  properties_json TEXT NOT NULL DEFAULT '{}',      -- values, keyed by property key
  position        REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',  -- active|archived
  is_ai           INTEGER NOT NULL DEFAULT 0,
  actor           TEXT NOT NULL DEFAULT 'human',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_page_parent ON page(parent_page_id, position);
CREATE INDEX idx_page_collection ON page(collection_id);

-- Named `collection` rather than `database`: DATABASE is a SQL keyword, and
-- quoting it everywhere for the rest of the project's life is not worth it.
CREATE TABLE collection (
  id             TEXT PRIMARY KEY,
  parent_page_id TEXT REFERENCES page(id),         -- the page it is embedded in
  title          TEXT NOT NULL DEFAULT '',
  icon           TEXT,
  role           TEXT,                             -- tasks|sources|insights|decisions|NULL for a plain one
  schema_json    TEXT NOT NULL DEFAULT '[]',       -- [{key,name,type,options?}]
  inline         INTEGER NOT NULL DEFAULT 1,
  position       REAL NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_collection_parent ON collection(parent_page_id, position);
CREATE INDEX idx_collection_role ON collection(role);

CREATE TABLE collection_view (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collection(id),
  name          TEXT NOT NULL DEFAULT 'Table',
  type          TEXT NOT NULL DEFAULT 'table',     -- table|board|list|gallery|calendar
  filter_json   TEXT NOT NULL DEFAULT '[]',
  sort_json     TEXT NOT NULL DEFAULT '[]',
  group_by      TEXT,                              -- property key, for board
  position      REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_collection_view_collection ON collection_view(collection_id, position);

-- ── Blocks, reparented to pages and made nestable ────────────────────────────
-- v7 blocks were flat and belonged to a document. Notion's blocks nest (toggles,
-- list children, columns), which is most of why its documents feel structured,
-- so parent_block_id is the point of this rewrite as much as page_id is.

ALTER TABLE block RENAME TO legacy_block;
ALTER TABLE block_revision RENAME TO legacy_block_revision;
ALTER TABLE document_patch RENAME TO legacy_document_patch;

-- A renamed table keeps its index names, so the v7 indexes have to go before
-- the v8 tables below can claim those names again.
DROP INDEX idx_block_document;
DROP INDEX idx_block_revision_block;
DROP INDEX idx_document_patch_document;
DROP INDEX idx_document_patch_status;

CREATE TABLE block (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES page(id),
  parent_block_id TEXT REFERENCES block(id),       -- NULL = top level of the page
  type            TEXT NOT NULL,
  content_json    TEXT NOT NULL DEFAULT '{}',
  position        REAL NOT NULL DEFAULT 0,
  version         INTEGER NOT NULL DEFAULT 1,
  is_ai           INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_block_page ON block(page_id, position);
CREATE INDEX idx_block_parent ON block(parent_block_id, position);

CREATE TABLE block_revision (
  id           TEXT PRIMARY KEY,
  block_id     TEXT NOT NULL REFERENCES block(id),
  content_json TEXT NOT NULL,
  version      INTEGER NOT NULL,
  actor        TEXT NOT NULL DEFAULT 'human',
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_block_revision_block ON block_revision(block_id);

-- An agent's proposed page change, awaiting Accept/Reject. Still the only way
-- an agent is allowed to edit a body — that gate is the product, not a detail.
CREATE TABLE page_patch (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES page(id),
  ops_json    TEXT NOT NULL,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending|accepted|rejected
  actor       TEXT NOT NULL DEFAULT 'human',
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_page_patch_page ON page_patch(page_id);
CREATE INDEX idx_page_patch_status ON page_patch(status);
