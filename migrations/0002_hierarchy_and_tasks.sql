-- Migration 0002: add parent_id, due_date; expand type and space enums
-- SQLite cannot ALTER TABLE to modify CHECK constraints, so we recreate the table.

-- 1. New table with updated CHECK constraints
CREATE TABLE items_new (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK(type IN ('note','goal','idea','link','tool','dump','task')),
  title      TEXT NOT NULL,
  space      TEXT NOT NULL CHECK(space IN ('learning','ideas','goals','saved','life','work','identity')),
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

-- 2. Copy all existing data
INSERT INTO items_new (id, type, title, space, status, tags, metadata, content, related, created_at, updated_at)
SELECT id, type, title, space, status, tags, metadata, content, related, created_at, updated_at
FROM items;

-- 3. Drop old FTS (stale after table swap; triggers will drop with items table)
DROP TABLE IF EXISTS items_fts;

-- 4. Drop old table (also drops its triggers)
DROP TABLE items;

-- 5. Rename new table into place
ALTER TABLE items_new RENAME TO items;

-- 6. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_items_type    ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_space   ON items(space);
CREATE INDEX IF NOT EXISTS idx_items_status  ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_parent  ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_due     ON items(due_date);

-- 7. Recreate FTS virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  id UNINDEXED,
  title,
  content,
  tags
);

-- 8. Populate FTS from existing data
INSERT INTO items_fts (id, title, content, tags)
SELECT id, title, content, tags FROM items;

-- 9. Recreate triggers
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(id, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  DELETE FROM items_fts WHERE id = old.id;
  INSERT INTO items_fts(id, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE id = old.id;
END;
