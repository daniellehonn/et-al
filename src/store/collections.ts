// Collections: a set of pages with typed properties and saved views — Notion's
// database, and the thing v7 was faking with one hard-coded table per entity.
//
// `role` is the load-bearing idea. A collection tagged 'tasks' promises that its
// pages carry the task property keys, which is what lets list_tasks, the Daily 3
// and the health scores keep working now that there is no task table. A
// collection without a role is one the user invented, and it works identically —
// it just means nothing in particular to an agent.
import { z } from "zod";
import {
  CollectionRole, PropertyDef, ROLE_PROPERTY_KEYS,
  createCollectionInput, createViewInput, updateCollectionInput, updateViewInput,
} from "../schema";
import { Ctx, RuleError, all, first, id, logEvent, now } from "./db";
import { Page, properties } from "./pages";

export interface Collection {
  id: string;
  parent_page_id: string | null;
  title: string;
  icon: string | null;
  role: string | null;
  schema_json: string;
  inline: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface CollectionView {
  id: string;
  collection_id: string;
  name: string;
  type: string;
  filter_json: string;
  sort_json: string;
  group_by: string | null;
  position: number;
  created_at: number;
  widths_json: string;
}

export function collectionSchema(col: Collection): PropertyDef[] {
  try { return JSON.parse(col.schema_json) as PropertyDef[]; } catch { return []; }
}

export function getCollection(c: Ctx, cid: string): Promise<Collection | null> {
  return first<Collection>(c, `SELECT * FROM collection WHERE id = ?`, cid);
}

export function listCollections(c: Ctx, pageId: string): Promise<Collection[]> {
  return all<Collection>(c, `SELECT * FROM collection WHERE parent_page_id = ? ORDER BY position`, pageId);
}

export function listViews(c: Ctx, cid: string): Promise<CollectionView[]> {
  return all<CollectionView>(c, `SELECT * FROM collection_view WHERE collection_id = ? ORDER BY position`, cid);
}

/** Starting sections. Editable per collection like any other select property —
 *  these are a first guess, not a fixed vocabulary. */
export const RECURRENCES = ["daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"] as const;

export const DEFAULT_SECTIONS = ["school", "clubs", "projects", "career", "personal"] as const;

/** The default property schema for a role collection. Created on demand so that
 *  `create_task` against a page with no Tasks collection just works instead of
 *  making the caller set up the collection first. */
export function defaultSchemaFor(role: CollectionRole): PropertyDef[] {
  switch (role) {
    case "tasks":
      return [
        { key: "status", name: "Status", type: "select", options: ["todo", "doing", "blocked", "done"] },
        // Section is a cut across the whole workspace, deliberately independent
        // of where a task's page sits in the tree: school work can live under a
        // course page or a club page, and grouping by ancestry would scatter it.
        { key: "section", name: "Section", type: "select", options: [...DEFAULT_SECTIONS] },
        { key: "priority", name: "Priority", type: "number" },
        { key: "due_date", name: "Due", type: "date" },
        { key: "recurrence", name: "Repeats", type: "select", options: [...RECURRENCES] },
        { key: "objective", name: "Objective", type: "select" },
        { key: "notes", name: "Notes", type: "text" },
      ];
    case "sources":
      return [
        { key: "kind", name: "Kind", type: "select" },
        { key: "url", name: "URL", type: "url" },
        { key: "status", name: "Status", type: "select", options: ["inbox", "processing", "processed"] },
        { key: "captured", name: "Captured", type: "date" },
      ];
    case "insights":
      return [
        { key: "source_id", name: "From source", type: "text" },
        { key: "is_ai", name: "AI", type: "checkbox" },
      ];
  }
}

const ROLE_TITLES: Record<CollectionRole, { title: string; icon: string }> = {
  tasks: { title: "Tasks", icon: "✅" },
  sources: { title: "Sources", icon: "🔗" },
  insights: { title: "Knowledge", icon: "💡" },
};

export async function createCollection(c: Ctx, input: z.input<typeof createCollectionInput>): Promise<Collection> {
  const data = createCollectionInput.parse(input);
  const cid = id("col");
  const t = now();
  const max = await first<{ m: number | null }>(c, `SELECT MAX(position) AS m FROM collection WHERE parent_page_id = ?`, data.parent_page_id);
  const position = data.position ?? (max?.m ?? -1) + 1;
  const schema = data.schema.length ? data.schema : data.role ? defaultSchemaFor(data.role) : [];
  await c.db
    .prepare(
      `INSERT INTO collection (id, parent_page_id, title, icon, role, schema_json, inline, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(cid, data.parent_page_id, data.title, data.icon ?? null, data.role ?? null, JSON.stringify(schema), position, t, t)
    .run();

  // A collection with no view cannot be rendered, so it always gets a table.
  await createView(c, { collection_id: cid, name: "Table", type: "table", filter: [], sort: [] });
  if (data.role === "tasks") {
    await createView(c, { collection_id: cid, name: "Board", type: "board", group_by: "status", filter: [], sort: [] });
  }

  // Place it in the page body, so it has a position among the blocks.
  const bmax = await first<{ m: number | null }>(c, `SELECT MAX(position) AS m FROM block WHERE page_id = ? AND parent_block_id IS NULL`, data.parent_page_id);
  await c.db
    .prepare(
      `INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, version, is_ai, created_at, updated_at)
       VALUES (?, ?, NULL, 'collection', ?, ?, 1, 0, ?, ?)`,
    )
    .bind(id("blk"), data.parent_page_id, JSON.stringify({ collection_id: cid }), (bmax?.m ?? -1) + 1, t, t)
    .run();

  await logEvent(c, "create", "collection", cid, { title: data.title, role: data.role ?? null });
  return (await getCollection(c, cid))!;
}

export async function updateCollection(c: Ctx, cid: string, patch: z.input<typeof updateCollectionInput>): Promise<Collection> {
  const data = updateCollectionInput.parse(patch);
  const existing = await getCollection(c, cid);
  if (!existing) throw new RuleError(`collection ${cid} not found`, 404);
  await c.db
    .prepare(`UPDATE collection SET title = ?, icon = ?, schema_json = ?, updated_at = ? WHERE id = ?`)
    .bind(
      data.title ?? existing.title,
      data.icon === undefined ? existing.icon : data.icon,
      data.schema ? JSON.stringify(data.schema) : existing.schema_json,
      now(),
      cid,
    )
    .run();
  await logEvent(c, "update", "collection", cid, data);
  return (await getCollection(c, cid))!;
}

/** Delete a collection, its views, its placement block, and its rows. */
export async function deleteCollection(c: Ctx, cid: string): Promise<void> {
  const existing = await getCollection(c, cid);
  if (!existing) throw new RuleError(`collection ${cid} not found`, 404);
  const rows = await all<{ id: string }>(c, `SELECT id FROM page WHERE collection_id = ?`, cid);
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    await c.db.prepare(`DELETE FROM block_revision WHERE block_id IN (SELECT id FROM block WHERE page_id IN (${marks}))`).bind(...ids).run();
    await c.db.prepare(`DELETE FROM daily_focus_slot WHERE page_id IN (${marks})`).bind(...ids).run();
    await c.db.prepare(`DELETE FROM block WHERE page_id IN (${marks})`).bind(...ids).run();
    await c.db.prepare(`DELETE FROM search_fts WHERE entity_type = 'page' AND entity_id IN (${marks})`).bind(...ids).run();
    await c.db.prepare(`DELETE FROM page WHERE collection_id = ?`).bind(cid).run();
  }
  await c.db.prepare(`DELETE FROM collection_view WHERE collection_id = ?`).bind(cid).run();
  await c.db.prepare(`DELETE FROM block WHERE type = 'collection' AND json_extract(content_json, '$.collection_id') = ?`).bind(cid).run();
  await c.db.prepare(`DELETE FROM collection WHERE id = ?`).bind(cid).run();
  await logEvent(c, "delete", "collection", cid, { title: existing.title, rows_removed: rows.length });
}

/** Add, rename or remove a property. Renaming a *key* rewrites the stored value
 *  on every row — a property whose key changed without migrating its data would
 *  silently blank the column. Removing one drops its values for the same reason:
 *  leaving orphaned keys in the JSON means a re-added property resurrects old
 *  data the user thought they had deleted. */
export async function setProperties(c: Ctx, cid: string, next: PropertyDef[]): Promise<Collection> {
  const existing = await getCollection(c, cid);
  if (!existing) throw new RuleError(`collection ${cid} not found`, 404);
  const before = collectionSchema(existing);
  const removed = before.filter((p) => !next.some((n) => n.key === p.key));

  for (const p of removed) {
    await c.db
      .prepare(`UPDATE page SET properties_json = json_remove(properties_json, '$.' || ?), updated_at = ? WHERE collection_id = ?`)
      .bind(p.key, now(), cid)
      .run();
  }
  await c.db
    .prepare(`UPDATE collection SET schema_json = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(next), now(), cid)
    .run();
  await logEvent(c, "update", "collection", cid, { properties: next.length, removed: removed.length });
  return (await getCollection(c, cid))!;
}

/** Add an option to a select property — how a new section gets created.
 *
 *  Options live on the property definition, so adding one is a schema edit
 *  rather than a migration, and it is idempotent: the same section name added
 *  twice is one section. */
export async function addSelectOption(c: Ctx, cid: string, key: string, option: string): Promise<Collection> {
  const col = await getCollection(c, cid);
  if (!col) throw new RuleError(`collection ${cid} not found`, 404);
  const value = option.trim();
  if (!value) throw new RuleError("a section needs a name", 400);
  const schema = collectionSchema(col);
  const next = schema.map((p) => {
    if (p.key !== key) return p;
    const options = p.options ?? [];
    return options.includes(value) ? p : { ...p, options: [...options, value] };
  });
  await c.db
    .prepare(`UPDATE collection SET schema_json = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(next), now(), cid)
    .run();
  return (await getCollection(c, cid))!;
}

/** Remove a select option, and clear it from any row still using it, so a
 *  deleted section cannot leave rows pointing at something that is gone. */
export async function removeSelectOption(c: Ctx, cid: string, key: string, option: string): Promise<Collection> {
  const col = await getCollection(c, cid);
  if (!col) throw new RuleError(`collection ${cid} not found`, 404);
  const next = collectionSchema(col).map((p) =>
    p.key === key ? { ...p, options: (p.options ?? []).filter((o) => o !== option) } : p,
  );
  await c.db
    .prepare(`UPDATE page SET properties_json = json_set(properties_json, '$.' || ?, NULL), updated_at = ? WHERE collection_id = ? AND json_extract(properties_json, '$.' || ?) = ?`)
    .bind(key, now(), cid, key, option)
    .run();
  await c.db
    .prepare(`UPDATE collection SET schema_json = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(next), now(), cid)
    .run();
  return (await getCollection(c, cid))!;
}

export async function createView(c: Ctx, input: z.input<typeof createViewInput>): Promise<CollectionView> {
  const data = createViewInput.parse(input);
  const vid = id("cvw");
  const max = await first<{ m: number | null }>(c, `SELECT MAX(position) AS m FROM collection_view WHERE collection_id = ?`, data.collection_id);
  await c.db
    .prepare(
      `INSERT INTO collection_view (id, collection_id, name, type, filter_json, sort_json, group_by, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(vid, data.collection_id, data.name, data.type, JSON.stringify(data.filter), JSON.stringify(data.sort), data.group_by ?? null, data.position ?? (max?.m ?? -1) + 1, now())
    .run();
  return (await first<CollectionView>(c, `SELECT * FROM collection_view WHERE id = ?`, vid))!;
}

export async function updateView(c: Ctx, vid: string, patch: z.input<typeof updateViewInput>): Promise<CollectionView> {
  const data = updateViewInput.parse(patch);
  const existing = await first<CollectionView>(c, `SELECT * FROM collection_view WHERE id = ?`, vid);
  if (!existing) throw new RuleError(`view ${vid} not found`, 404);
  await c.db
    .prepare(`UPDATE collection_view SET name = ?, type = ?, filter_json = ?, sort_json = ?, group_by = ?, position = ?, widths_json = ? WHERE id = ?`)
    .bind(
      data.name ?? existing.name,
      data.type ?? existing.type,
      data.filter ? JSON.stringify(data.filter) : existing.filter_json,
      data.sort ? JSON.stringify(data.sort) : existing.sort_json,
      data.group_by === undefined ? existing.group_by : data.group_by,
      data.position ?? existing.position,
      data.widths ? JSON.stringify(data.widths) : existing.widths_json,
      vid,
    )
    .run();
  return (await first<CollectionView>(c, `SELECT * FROM collection_view WHERE id = ?`, vid))!;
}

export async function deleteView(c: Ctx, vid: string): Promise<void> {
  await c.db.prepare(`DELETE FROM collection_view WHERE id = ?`).bind(vid).run();
}

// ---- Querying ---------------------------------------------------------------

export interface Filter { key: string; op: string; value: unknown }
export interface Sort { key: string; dir: "asc" | "desc" }

/** Rows of a collection. Filtering and sorting happen in JS rather than SQL:
 *  properties live in a JSON blob whose types are user-editable, so pushing this
 *  into SQL would mean generating json_extract predicates with the collation and
 *  null-ordering rules varying per property type. The row counts here are small. */
export async function queryCollection(
  c: Ctx,
  cid: string,
  opts: { filter?: Filter[]; sort?: Sort[]; limit?: number } = {},
): Promise<Page[]> {
  const rows = await all<Page>(
    c, `SELECT * FROM page WHERE collection_id = ? AND trashed_at IS NULL ORDER BY position, created_at`, cid,
  );
  let out = rows;
  for (const f of opts.filter ?? []) out = out.filter((r) => matches(properties(r)[f.key], f.op, f.value));
  for (const s of [...(opts.sort ?? [])].reverse()) {
    out = [...out].sort((a, b) => compare(properties(a)[s.key], properties(b)[s.key]) * (s.dir === "desc" ? -1 : 1));
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

function matches(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case "is": return actual === expected;
    case "is_not": return actual !== expected;
    case "is_empty": return actual === null || actual === undefined || actual === "";
    case "is_not_empty": return !(actual === null || actual === undefined || actual === "");
    case "contains": return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "gt": return Number(actual) > Number(expected);
    case "lt": return Number(actual) < Number(expected);
    case "in": return Array.isArray(expected) && (expected as unknown[]).includes(actual);
    default: return true;
  }
}

// Empty properties sort last in ascending order — an unset due date is not
// "earliest", and putting those rows first would bury everything that has one.
function compare(a: unknown, b: unknown): number {
  const ae = a === null || a === undefined || a === "";
  const be = b === null || b === undefined || b === "";
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

// ---- Role lookup ------------------------------------------------------------

/** Every collection carrying a role, anywhere. */
export function collectionsByRole(c: Ctx, role: CollectionRole): Promise<Collection[]> {
  return all<Collection>(c, `SELECT * FROM collection WHERE role = ? ORDER BY created_at`, role);
}

/** The role collection belonging to a page, created on demand. This is what lets
 *  an agent call create_task against any page without knowing whether that page
 *  has been set up with a Tasks collection yet. */
export async function ensureRoleCollection(c: Ctx, pageId: string, role: CollectionRole): Promise<Collection> {
  const existing = await first<Collection>(
    c, `SELECT * FROM collection WHERE parent_page_id = ? AND role = ? LIMIT 1`, pageId, role,
  );
  if (existing) return existing;
  const { title, icon } = ROLE_TITLES[role];
  return createCollection(c, { parent_page_id: pageId, title, icon, role, schema: defaultSchemaFor(role) });
}

/** All pages carrying a role, across every collection with that role — the
 *  replacement for "SELECT * FROM task". Returns the owning page id too, since
 *  callers almost always need to know which project a task belongs to. */
export async function pagesWithRole(
  c: Ctx,
  role: CollectionRole,
  opts: { pageId?: string } = {},
): Promise<(Page & { owner_page_id: string | null })[]> {
  const cols = await collectionsByRole(c, role);
  const scoped = opts.pageId ? cols.filter((x) => x.parent_page_id === opts.pageId) : cols;
  if (!scoped.length) return [];
  const marks = scoped.map(() => "?").join(",");
  const rows = await all<Page>(
    c,
    `SELECT * FROM page WHERE collection_id IN (${marks}) AND trashed_at IS NULL ORDER BY position, created_at`,
    ...scoped.map((x) => x.id),
  );
  const owner = new Map(scoped.map((x) => [x.id, x.parent_page_id]));
  return rows.map((r) => ({ ...r, owner_page_id: owner.get(r.collection_id!) ?? null }));
}

export { ROLE_PROPERTY_KEYS };
