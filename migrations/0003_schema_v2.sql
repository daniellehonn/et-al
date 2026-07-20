-- Migration 0003: schema v2
-- Identity becomes a separate layer (space = NULL), not a peer space.
-- Types consolidated: note→page, dump→idea, tool→link.
-- Spaces renamed: work→career, ideas→projects. goals→NULL (identity layer).
-- Space column is now nullable: NULL means the item belongs to the identity layer.

CREATE TABLE items_v2 (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK(type IN ('page','goal','idea','task','link')),
  title      TEXT NOT NULL,
  space      TEXT CHECK(space IN ('school','career','learning','projects','life','saved')),
  -- NULL space = identity layer (above all spaces)
  status     TEXT NOT NULL DEFAULT 'inbox'
             CHECK(status IN ('active','paused','done','archived','inbox')),
  tags       TEXT NOT NULL DEFAULT '[]',
  metadata   TEXT NOT NULL DEFAULT '{}',
  content    TEXT NOT NULL DEFAULT '',
  related    TEXT NOT NULL DEFAULT '[]',
  parent_id  TEXT,
  due_date   INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Copy and transform all existing data
INSERT INTO items_v2 (id, type, title, space, status, tags, metadata, content, related, parent_id, due_date, created_at, updated_at)
SELECT
  id,
  CASE type
    WHEN 'note' THEN 'page'
    WHEN 'dump' THEN 'idea'
    WHEN 'tool' THEN 'link'
    ELSE type
  END,
  title,
  CASE space
    WHEN 'identity' THEN NULL
    WHEN 'goals'    THEN NULL
    WHEN 'work'     THEN 'career'
    WHEN 'ideas'    THEN 'projects'
    ELSE space
  END,
  status, tags, metadata, content, related, parent_id, due_date, created_at, updated_at
FROM items;

-- Swap tables
DROP TABLE IF EXISTS items_fts;
DROP TABLE items;
ALTER TABLE items_v2 RENAME TO items;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_items_type    ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_space   ON items(space);
CREATE INDEX IF NOT EXISTS idx_items_status  ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_parent  ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_due     ON items(due_date);

-- FTS
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  id UNINDEXED, title, content, tags
);

INSERT INTO items_fts (id, title, content, tags)
SELECT id, title, content, tags FROM items;

-- Triggers
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(id, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  DELETE FROM items_fts WHERE id = old.id;
  INSERT INTO items_fts(id, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE id = old.id;
END;
