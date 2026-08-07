-- Column widths live on the view, not the collection: the same data can be
-- shown as a wide reference table and a narrow checklist, and Notion treats
-- width as a property of how you are looking at something rather than of the
-- data itself.
ALTER TABLE collection_view ADD COLUMN widths_json TEXT NOT NULL DEFAULT '{}';
