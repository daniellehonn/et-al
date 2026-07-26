-- Notion-style page identity: an emoji icon and a cover image URL per
-- workspace and per document.
ALTER TABLE workspace ADD COLUMN icon TEXT;
ALTER TABLE workspace ADD COLUMN cover TEXT;
ALTER TABLE document ADD COLUMN icon TEXT;
ALTER TABLE document ADD COLUMN cover TEXT;
