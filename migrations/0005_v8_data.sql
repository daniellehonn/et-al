-- et al. v8 — move v7 data onto the page/collection model.
--
-- Ids are preserved throughout: every v7 type used its own id prefix (ws_, doc_,
-- tsk_, src_, ins_, dec_), so old ids stay unique as page ids and every existing
-- relationship, event and backlink keeps resolving without rewriting.
--
-- Parents are set in a second pass rather than inserted in tree order, because
-- page.parent_page_id is a self-referencing foreign key and there is no ordering
-- guarantee on INSERT … SELECT.

-- ── Workspaces and documents both become pages ───────────────────────────────

INSERT INTO page (id, parent_page_id, collection_id, title, icon, cover, properties_json, position, status, actor, created_at, updated_at)
SELECT w.id, NULL, NULL, w.title, w.icon, w.cover,
       json_object('type', w.type, 'status', w.status),
       w.position, CASE WHEN w.status = 'archived' THEN 'archived' ELSE 'active' END,
       'human', w.created_at, w.updated_at
FROM workspace w;

UPDATE page SET parent_page_id = (SELECT w.parent_id FROM workspace w WHERE w.id = page.id)
WHERE id IN (SELECT id FROM workspace WHERE parent_id IS NOT NULL);

INSERT INTO page (id, parent_page_id, collection_id, title, icon, cover, properties_json, position, status, actor, created_at, updated_at)
SELECT d.id, d.workspace_id, NULL, d.title, d.icon, d.cover,
       json_object('type', d.type, 'status', d.status),
       0, CASE WHEN d.status = 'archived' THEN 'archived' ELSE 'active' END,
       'human', d.created_at, d.updated_at
FROM document d;

-- A workspace's description was a field with nowhere to live in a page body.
-- It becomes the page's first paragraph, which is where it belonged all along.
INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, version, is_ai, created_at, updated_at)
SELECT 'blk_' || lower(hex(randomblob(16))), w.id, NULL, 'paragraph',
       json_object('text', w.description), -1, 1, 0, w.created_at, w.updated_at
FROM workspace w
WHERE w.description IS NOT NULL AND trim(w.description) <> '';

-- Document bodies carry over unchanged, flat (v7 had no nesting to preserve).
INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, version, is_ai, created_at, updated_at)
SELECT b.id, b.document_id, NULL, b.type, b.content_json, b.position, b.version, b.is_ai, b.created_at, b.updated_at
FROM legacy_block b
WHERE EXISTS (SELECT 1 FROM page p WHERE p.id = b.document_id);

INSERT INTO block_revision (id, block_id, content_json, version, actor, created_at)
SELECT r.id, r.block_id, r.content_json, r.version, r.actor, r.created_at
FROM legacy_block_revision r
WHERE EXISTS (SELECT 1 FROM block b WHERE b.id = r.block_id);

INSERT INTO page_patch (id, page_id, ops_json, summary, status, actor, created_at, resolved_at)
SELECT p.id, p.document_id, p.ops_json, p.summary, p.status, p.actor, p.created_at, p.resolved_at
FROM legacy_document_patch p
WHERE EXISTS (SELECT 1 FROM page pg WHERE pg.id = p.document_id);

-- ── An Inbox page, so unfiled captures have somewhere real to live ───────────

INSERT INTO page (id, parent_page_id, collection_id, title, icon, properties_json, position, status, actor, created_at, updated_at)
SELECT 'ws_inbox', NULL, NULL, 'Inbox', '📥', json_object('type', 'area', 'status', 'active'),
       -1, 'active', 'human',
       CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE EXISTS (SELECT 1 FROM source WHERE workspace_id IS NULL);

-- ── Collections: one per page per role, only where rows actually exist ───────

INSERT INTO collection (id, parent_page_id, title, icon, role, schema_json, inline, position, created_at, updated_at)
SELECT 'col_' || lower(hex(randomblob(16))), w.id, 'Tasks', '✅', 'tasks',
       json_array(
         json_object('key','status','name','Status','type','select','options',json_array('todo','doing','blocked','done')),
         json_object('key','priority','name','Priority','type','number'),
         json_object('key','due_date','name','Due','type','date'),
         json_object('key','objective','name','Objective','type','select'),
         json_object('key','notes','name','Notes','type','text')
       ),
       1, 0, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM workspace w WHERE EXISTS (SELECT 1 FROM task t WHERE t.workspace_id = w.id);

INSERT INTO collection (id, parent_page_id, title, icon, role, schema_json, inline, position, created_at, updated_at)
SELECT 'col_' || lower(hex(randomblob(16))), p.id, 'Sources', '🔗', 'sources',
       json_array(
         json_object('key','kind','name','Kind','type','select'),
         json_object('key','url','name','URL','type','url'),
         json_object('key','status','name','Status','type','select','options',json_array('inbox','processed')),
         json_object('key','captured','name','Captured','type','date')
       ),
       1, 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM page p
WHERE EXISTS (SELECT 1 FROM source s WHERE COALESCE(s.workspace_id, 'ws_inbox') = p.id);

INSERT INTO collection (id, parent_page_id, title, icon, role, schema_json, inline, position, created_at, updated_at)
SELECT 'col_' || lower(hex(randomblob(16))), w.id, 'Knowledge', '💡', 'insights',
       json_array(
         json_object('key','source_id','name','From source','type','text'),
         json_object('key','is_ai','name','AI','type','checkbox')
       ),
       1, 2, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM workspace w WHERE EXISTS (SELECT 1 FROM insight i WHERE i.workspace_id = w.id);

INSERT INTO collection (id, parent_page_id, title, icon, role, schema_json, inline, position, created_at, updated_at)
SELECT 'col_' || lower(hex(randomblob(16))), w.id, 'Decisions', '⚖️', 'decisions',
       json_array(
         json_object('key','decided_on','name','Decided','type','date'),
         json_object('key','impact','name','Impact','type','select')
       ),
       1, 3, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM workspace w WHERE EXISTS (SELECT 1 FROM decision d WHERE d.workspace_id = w.id);

-- Every collection opens on a table view; tasks also get a board, since status
-- is exactly the kind of property a board exists to group by.
INSERT INTO collection_view (id, collection_id, name, type, filter_json, sort_json, group_by, position, created_at)
SELECT 'cvw_' || lower(hex(randomblob(16))), c.id, 'Table', 'table', '[]', '[]', NULL, 0,
       CAST(strftime('%s','now') AS INTEGER) * 1000
FROM collection c;

INSERT INTO collection_view (id, collection_id, name, type, filter_json, sort_json, group_by, position, created_at)
SELECT 'cvw_' || lower(hex(randomblob(16))), c.id, 'Board', 'board', '[]', '[]', 'status', 1,
       CAST(strftime('%s','now') AS INTEGER) * 1000
FROM collection c WHERE c.role = 'tasks';

-- ── The four entity types become pages inside those collections ─────────────
-- Objectives are not a type any more. An objective was already "a label a task
-- can carry"; here it finishes the journey and becomes a select property value.

INSERT INTO page (id, parent_page_id, collection_id, title, properties_json, position, status, is_ai, actor, created_at, updated_at)
SELECT t.id, NULL, c.id, t.title,
       json_object(
         'status', t.status,
         'priority', t.priority,
         'due_date', t.due_date,
         'objective', (SELECT o.title FROM objective o WHERE o.id = t.objective_id),
         'notes', t.notes,
         'estimate_min', t.estimate_min,
         'completed_at', t.completed_at
       ),
       t.position, CASE WHEN t.status = 'done' THEN 'active' ELSE 'active' END,
       CASE WHEN t.actor LIKE 'ai:%' THEN 1 ELSE 0 END, t.actor, t.created_at, t.created_at
FROM task t JOIN collection c ON c.parent_page_id = t.workspace_id AND c.role = 'tasks';

INSERT INTO page (id, parent_page_id, collection_id, title, properties_json, position, status, is_ai, actor, created_at, updated_at)
SELECT s.id, NULL, c.id, COALESCE(NULLIF(trim(s.title), ''), s.url, s.kind),
       json_object(
         'kind', s.kind,
         'url', s.url,
         'status', s.status,
         'captured', s.created_at,
         'r2_key', s.r2_key,
         'metadata_json', s.metadata_json
       ),
       0, 'active', CASE WHEN s.actor LIKE 'ai:%' THEN 1 ELSE 0 END, s.actor, s.created_at, s.updated_at
FROM source s JOIN collection c ON c.parent_page_id = COALESCE(s.workspace_id, 'ws_inbox') AND c.role = 'sources';

-- A source's captured text becomes the body of its page, so a saved link reads
-- as a page you can open rather than a row you can only inspect.
INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, version, is_ai, created_at, updated_at)
SELECT 'blk_' || lower(hex(randomblob(16))), s.id, NULL, 'paragraph',
       json_object('text', s.raw), 0, 1, 0, s.created_at, s.updated_at
FROM source s
WHERE s.raw IS NOT NULL AND trim(s.raw) <> ''
  AND EXISTS (SELECT 1 FROM page p WHERE p.id = s.id);

INSERT INTO page (id, parent_page_id, collection_id, title, properties_json, position, status, is_ai, actor, created_at, updated_at)
SELECT i.id, NULL, c.id, i.title,
       json_object('source_id', i.source_id, 'is_ai', i.is_ai, 'embedding_id', i.embedding_id),
       0, 'active', i.is_ai, i.actor, i.created_at, i.updated_at
FROM insight i JOIN collection c ON c.parent_page_id = i.workspace_id AND c.role = 'insights';

INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, version, is_ai, created_at, updated_at)
SELECT 'blk_' || lower(hex(randomblob(16))), i.id, NULL, 'paragraph',
       json_object('text', i.body), 0, 1, i.is_ai, i.created_at, i.updated_at
FROM insight i
WHERE EXISTS (SELECT 1 FROM page p WHERE p.id = i.id);

INSERT INTO page (id, parent_page_id, collection_id, title, properties_json, position, status, is_ai, actor, created_at, updated_at)
SELECT d.id, NULL, c.id, d.title,
       json_object('decided_on', d.decided_on, 'impact', d.impact, 'alternatives_json', d.alternatives_json),
       0, 'active', CASE WHEN d.actor LIKE 'ai:%' THEN 1 ELSE 0 END, d.actor, d.created_at, d.created_at
FROM decision d JOIN collection c ON c.parent_page_id = d.workspace_id AND c.role = 'decisions';

INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, version, is_ai, created_at, updated_at)
SELECT 'blk_' || lower(hex(randomblob(16))), d.id, NULL, 'paragraph',
       json_object('text', d.rationale), 0, 1, 0, d.created_at, d.created_at
FROM decision d
WHERE EXISTS (SELECT 1 FROM page p WHERE p.id = d.id);

-- ── Daily 3 has to point at pages, not at the retired task table ─────────────

CREATE TABLE daily_focus_slot_v8 (
  id      TEXT PRIMARY KEY,
  date    TEXT NOT NULL REFERENCES daily_focus_day(date),
  slot    INTEGER NOT NULL,
  page_id TEXT NOT NULL REFERENCES page(id),
  status  TEXT NOT NULL DEFAULT 'planned'
);
INSERT INTO daily_focus_slot_v8 (id, date, slot, page_id, status)
SELECT s.id, s.date, s.slot, s.task_id, s.status
FROM daily_focus_slot s WHERE EXISTS (SELECT 1 FROM page p WHERE p.id = s.task_id);

DROP TABLE daily_focus_slot;
ALTER TABLE daily_focus_slot_v8 RENAME TO daily_focus_slot;
CREATE INDEX idx_daily_focus_slot_date ON daily_focus_slot(date);

-- ── Place each collection into its page's body ──────────────────────────────
-- A collection is owned by a page (collection.parent_page_id) but *positioned*
-- by a block, exactly as Notion embeds a database inline. Without this the body
-- and its collections would be two lists with no defined order between them.

INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, version, is_ai, created_at, updated_at)
SELECT 'blk_' || lower(hex(randomblob(16))), c.parent_page_id, NULL, 'collection',
       json_object('collection_id', c.id), 100 + c.position, 1, 0, c.created_at, c.updated_at
FROM collection c;

-- ── Relationship edges now point at pages ───────────────────────────────────
-- Ids were preserved, so only the type label needs rewriting for edges to keep
-- resolving.

UPDATE relationship SET source_type = 'page'
WHERE source_type IN ('workspace','objective','task','document','source','insight','decision');
UPDATE relationship SET target_type = 'page'
WHERE target_type IN ('workspace','objective','task','document','source','insight','decision');

-- ── Search: everything is a page now ────────────────────────────────────────

DELETE FROM search_fts;
INSERT INTO search_fts (entity_type, entity_id, title, body)
SELECT 'page', p.id, p.title,
       COALESCE((SELECT group_concat(json_extract(b.content_json, '$.text'), ' ')
                 FROM block b WHERE b.page_id = p.id), '')
FROM page p;

-- ── Retire the v7 tables (kept, not dropped — this stays reversible) ────────

ALTER TABLE workspace RENAME TO legacy_workspace;
ALTER TABLE objective RENAME TO legacy_objective;
ALTER TABLE task RENAME TO legacy_task;
ALTER TABLE document RENAME TO legacy_document;
ALTER TABLE source RENAME TO legacy_source;
ALTER TABLE insight RENAME TO legacy_insight;
ALTER TABLE decision RENAME TO legacy_decision;
ALTER TABLE overview_block RENAME TO legacy_overview_block;
