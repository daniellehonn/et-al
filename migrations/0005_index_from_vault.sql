-- Migration 0005: D1 becomes a DERIVED index of the R2 vault.
--
-- Nothing here holds authored data. Every row is reproducible by reading the
-- markdown files in the VAULT bucket (POST /api/reindex). It is always safe to
-- DROP and rebuild these tables — the bucket is the source of truth.
--
-- The legacy `items` table is intentionally left in place (untouched) so the
-- one-time POST /api/migrate-from-d1 can read it to seed the vault. Once the
-- vault is populated and verified, `items` can be dropped manually.

DROP TABLE IF EXISTS pages_fts;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS pages;

-- One row per markdown file in the vault.
CREATE TABLE pages (
  id           TEXT PRIMARY KEY,          -- frontmatter id (UUID), stable across renames
  path         TEXT NOT NULL,             -- R2 object key, e.g. career/ship-the-portfolio.md
  title        TEXT NOT NULL,
  title_norm   TEXT NOT NULL,             -- normalized title = link-resolution key
  type         TEXT NOT NULL,             -- page | goal | idea | task | link
  space        TEXT,                      -- folder; NULL = unsorted
  status       TEXT NOT NULL,
  tags_json    TEXT NOT NULL DEFAULT '[]',
  parent_norm  TEXT,                      -- normalized title of the `parent:` link (hierarchy)
  due          INTEGER,                   -- unix seconds
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  body_excerpt TEXT NOT NULL DEFAULT ''   -- first ~200 chars of body, for list previews
);

CREATE INDEX idx_pages_space   ON pages(space);
CREATE INDEX idx_pages_type    ON pages(type);
CREATE INDEX idx_pages_status  ON pages(status);
CREATE INDEX idx_pages_norm    ON pages(title_norm);
CREATE INDEX idx_pages_parent  ON pages(parent_norm);
CREATE INDEX idx_pages_updated ON pages(updated_at DESC);

-- One row per [[wikilink]] occurrence (frontmatter parent + inline body links).
CREATE TABLE links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT NOT NULL,             -- page the link is written in
  target_norm TEXT NOT NULL,             -- normalized target title
  target_id   TEXT,                      -- resolved page id, or NULL if the target doesn't exist yet
  kind        TEXT NOT NULL,             -- 'parent' (hierarchy) | 'inline' (lateral)
  alias       TEXT,                      -- [[Title|alias]] display text, if any
  context     TEXT NOT NULL DEFAULT '',  -- the line the link appears in (backlink preview)
  FOREIGN KEY (source_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX idx_links_source ON links(source_id);
CREATE INDEX idx_links_target ON links(target_id);
CREATE INDEX idx_links_norm   ON links(target_norm);
CREATE INDEX idx_links_kind   ON links(kind);

-- Full-text search over title + body. Populated by the reindex/write paths in
-- application code (not triggers — the source rows live in R2, not a SQL table).
CREATE VIRTUAL TABLE pages_fts USING fts5(
  id UNINDEXED,
  title,
  body
);
