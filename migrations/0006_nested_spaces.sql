-- Migration 0006: schema v5 — nested spaces (folders) with a derived index.
--
-- The R2 vault is a real directory tree now. Folders are spaces/subspaces; the
-- folder path IS a page's space (no more flat `space` enum). This index is still
-- fully derived from the bucket — DROP and rebuild it any time via POST /api/reindex.
--
-- Three distinct structures, none overlapping:
--   folder (path)  = area / place (where a page lives) — the nav tree
--   parent (link)  = goal breakdown (a goal owns subtasks/notes/pages)
--   [[wikilink]]   = lateral reference (backlinks)

DROP TABLE IF EXISTS pages_fts;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS pages;
DROP TABLE IF EXISTS spaces;

-- One row per folder that has a _space.md (metadata). Folders without one still
-- "exist" implicitly via the pages inside them; the store fills those in at
-- reindex so the tree is always complete.
CREATE TABLE spaces (
  path         TEXT PRIMARY KEY,        -- e.g. "career" or "career/internships"; "" is never stored
  parent_path  TEXT,                    -- immediate parent folder ("" = top level)
  name         TEXT NOT NULL,           -- display name
  slug         TEXT NOT NULL,           -- last path segment
  color        TEXT,
  icon         TEXT,
  description  TEXT,
  sort         INTEGER,
  id           TEXT,                    -- _space.md id, if any
  has_meta     INTEGER NOT NULL DEFAULT 0, -- 1 if a real _space.md backs this row
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_spaces_parent ON spaces(parent_path);

CREATE TABLE pages (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL,           -- full R2 key, e.g. career/internships/apply.md
  space_path   TEXT NOT NULL,           -- the folder it lives in ("" = vault root)
  title        TEXT NOT NULL,
  title_norm   TEXT NOT NULL,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL,
  tags_json    TEXT NOT NULL DEFAULT '[]',
  parent_norm  TEXT,                    -- normalized parent-goal title (goal breakdown)
  due          INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  body_excerpt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_pages_space   ON pages(space_path);
CREATE INDEX idx_pages_type    ON pages(type);
CREATE INDEX idx_pages_status  ON pages(status);
CREATE INDEX idx_pages_norm    ON pages(title_norm);
CREATE INDEX idx_pages_parent  ON pages(parent_norm);
CREATE INDEX idx_pages_updated ON pages(updated_at DESC);

CREATE TABLE links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT NOT NULL,
  target_norm TEXT NOT NULL,
  target_id   TEXT,
  kind        TEXT NOT NULL,            -- 'parent' (goal breakdown) | 'inline' (lateral)
  alias       TEXT,
  context     TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (source_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE INDEX idx_links_source ON links(source_id);
CREATE INDEX idx_links_target ON links(target_id);
CREATE INDEX idx_links_norm   ON links(target_norm);
CREATE INDEX idx_links_kind   ON links(kind);

CREATE VIRTUAL TABLE pages_fts USING fts5(id UNINDEXED, title, body);
