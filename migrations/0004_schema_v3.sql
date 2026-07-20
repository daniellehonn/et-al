-- Migration 0004: schema v3 (matches SCHEMA_VERSION = 3 in src/index.ts)
--
-- 1. Identity becomes a first-class, writable space value ('identity') instead
--    of the ambiguous space = NULL. NULL now means exactly one thing: unsorted
--    (captured but not yet filed). Unsorted items are always visible in their
--    own bucket — nothing can vanish from views again.
-- 2. Existing NULL rows are split by a heuristic: rows that other items point
--    at (as parent_id, or inside a related array) are identity anchors and
--    become space = 'identity'. Unreferenced NULL rows stay NULL and surface
--    in the visible Unsorted bucket for manual triage.
-- 3. metadata.checklist entries are promoted to real child task items
--    (type = 'task', parent_id = the owning item), then removed from metadata.
--    Subtask progress is now queryable via get_children.

CREATE TABLE items_v3 (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK(type IN ('page','goal','idea','task','link')),
  title      TEXT NOT NULL,
  space      TEXT CHECK(space IN ('identity','school','career','learning','projects','life','saved')),
  -- NULL space = unsorted (not yet filed). Never invisible: the UI and the
  -- 'unsorted' filter value both surface these rows.
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

-- Copy, resolving the NULL ambiguity: referenced NULL rows are identity
-- anchors; the rest are unsorted and stay NULL (but become visible).
INSERT INTO items_v3 (id, type, title, space, status, tags, metadata, content, related, parent_id, due_date, created_at, updated_at)
SELECT
  items.id, items.type, items.title,
  CASE
    WHEN items.space IS NOT NULL THEN items.space
    WHEN EXISTS (SELECT 1 FROM items other WHERE other.parent_id = items.id AND other.id != items.id)
      OR EXISTS (
        SELECT 1 FROM items other, json_each(other.related) je
        WHERE je.value = items.id AND other.id != items.id
      )
    THEN 'identity'
    ELSE NULL
  END,
  items.status, items.tags, items.metadata, items.content, items.related,
  items.parent_id, items.due_date, items.created_at, items.updated_at
FROM items;

-- Promote metadata.checklist entries to child task items.
INSERT INTO items_v3 (id, type, title, space, status, tags, metadata, content, related, parent_id, due_date, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  'task',
  COALESCE(json_extract(je.value, '$.text'), 'Untitled task'),
  v3.space,
  CASE WHEN COALESCE(json_extract(je.value, '$.done'), 0) THEN 'done' ELSE 'active' END,
  '[]', '{}', '', '[]',
  v3.id,
  NULL,
  v3.created_at,
  unixepoch()
FROM items AS old, items_v3 AS v3, json_each(old.metadata, '$.checklist') AS je
WHERE v3.id = old.id
  AND json_type(old.metadata, '$.checklist') = 'array';

-- Checklists now live as task rows; drop the freeform copy.
UPDATE items_v3
SET metadata = json_remove(metadata, '$.checklist')
WHERE json_extract(metadata, '$.checklist') IS NOT NULL;

-- Swap tables
DROP TABLE IF EXISTS items_fts;
DROP TABLE items;
ALTER TABLE items_v3 RENAME TO items;

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
