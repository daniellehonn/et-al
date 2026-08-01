-- Trash and favorites.
--
-- Deleting was permanent and cascading, which is a bad trade for a personal
-- workspace: the cost of an accidental delete is total, and Notion's answer
-- (30 days in a trash you can restore from) is the reason people delete freely.
-- `trashed_at` records when a page went in, so a purge policy has something to
-- work from; `status` gains 'trashed' alongside active/archived.
ALTER TABLE page ADD COLUMN trashed_at INTEGER;

-- Favorites pin a page to the top of the sidebar. A column rather than a
-- property because the sidebar sorts on it and properties are a JSON blob.
ALTER TABLE page ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_page_trashed ON page(trashed_at);
CREATE INDEX idx_page_favorite ON page(favorite);
