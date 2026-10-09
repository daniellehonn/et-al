// Pages: the universal primitive. A project, a document, a task and a saved link
// are all pages — what differs is whether the page sits in the tree (it has a
// parent_page_id) or in a collection (it has a collection_id, and its properties
// mean something), and what its body says.
//
// A page can hold both: a task page still has children and a body, which is the
// whole point — in v7 a task was a row you could not open.
import { z } from "zod";
import { createPageInput, movePageInput, updatePageInput } from "../schema";
import { Ctx, RuleError, all, first, ftsDelete, ftsUpsert, id, logEvent, now } from "./db";
import type { Collection } from "./collections";

export interface Page {
  id: string;
  parent_page_id: string | null;
  collection_id: string | null;
  title: string;
  icon: string | null;
  cover: string | null;
  properties_json: string;
  position: number;
  status: string;
  trashed_at: number | null;
  favorite: number;
  is_ai: number;
  actor: string;
  created_at: number;
  updated_at: number;
}

export type Properties = Record<string, unknown>;

export function properties(p: Page): Properties {
  try { return JSON.parse(p.properties_json) as Properties; } catch { return {}; }
}

export function getPage(c: Ctx, pid: string): Promise<Page | null> {
  return first<Page>(c, `SELECT * FROM page WHERE id = ?`, pid);
}

/** The children of a page in the tree. Collection rows are excluded on purpose:
 *  they belong to their collection, not to the sidebar tree, or every task would
 *  show up as a nested page in the sidebar. */
// The task system's home is a page so it can own a collection, but it is not a
// note page and does not belong in the tree — the sidebar reaches it by its own
// link. Keeping it out is what makes "the page tree has no tasks" true.
const HIDDEN_ROOTS = "'pg_tasks_home'";

export function listChildren(c: Ctx, parentId: string | null): Promise<Page[]> {
  return parentId === null
    ? all<Page>(c, `SELECT * FROM page WHERE parent_page_id IS NULL AND collection_id IS NULL AND trashed_at IS NULL AND id NOT IN (${HIDDEN_ROOTS}) ORDER BY position, created_at`)
    : all<Page>(c, `SELECT * FROM page WHERE parent_page_id = ? AND collection_id IS NULL AND trashed_at IS NULL ORDER BY position, created_at`, parentId);
}

export interface PageNode extends Page { children: PageNode[] }

/** The whole sidebar tree in one query, assembled in memory. A personal
 *  workspace is small enough that one scan beats a recursive CTE or N queries. */
export async function getPageTree(c: Ctx): Promise<PageNode[]> {
  const rows = await all<Page>(
    c,
    `SELECT * FROM page WHERE collection_id IS NULL AND status = 'active' AND trashed_at IS NULL
       AND id NOT IN (${HIDDEN_ROOTS})
     ORDER BY position, created_at`,
  );
  const byId = new Map<string, PageNode>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: PageNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_page_id ? byId.get(node.parent_page_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node); // includes pages whose parent is archived — better orphaned than invisible
  }
  return roots;
}

/** Every ancestor, root first — the breadcrumb. */
export async function getAncestors(c: Ctx, pid: string): Promise<Page[]> {
  const chain: Page[] = [];
  const seen = new Set<string>([pid]);
  let cur = await getPage(c, pid);
  while (cur?.parent_page_id && !seen.has(cur.parent_page_id)) {
    seen.add(cur.parent_page_id);
    cur = await getPage(c, cur.parent_page_id);
    if (cur) chain.unshift(cur);
  }
  return chain;
}

async function nextPosition(c: Ctx, parentId: string | null, collectionId: string | null): Promise<number> {
  const row = collectionId
    ? await first<{ m: number | null }>(c, `SELECT MAX(position) AS m FROM page WHERE collection_id = ?`, collectionId)
    : parentId === null
      ? await first<{ m: number | null }>(c, `SELECT MAX(position) AS m FROM page WHERE parent_page_id IS NULL AND collection_id IS NULL`)
      : await first<{ m: number | null }>(c, `SELECT MAX(position) AS m FROM page WHERE parent_page_id = ?`, parentId);
  return (row?.m ?? -1) + 1;
}

export async function createPage(c: Ctx, input: z.input<typeof createPageInput>): Promise<Page> {
  const data = createPageInput.parse(input);
  if (data.parent_page_id && !(await getPage(c, data.parent_page_id))) {
    throw new RuleError(`parent page ${data.parent_page_id} not found`, 404);
  }
  const pid = id("pg");
  const t = now();
  const position = data.position ?? (await nextPosition(c, data.parent_page_id ?? null, data.collection_id ?? null));
  await c.db
    .prepare(
      `INSERT INTO page (id, parent_page_id, collection_id, title, icon, cover, properties_json, position, status, is_ai, actor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .bind(
      pid, data.parent_page_id ?? null, data.collection_id ?? null, data.title,
      data.icon ?? null, data.cover ?? null, JSON.stringify(data.properties),
      position, c.actor.startsWith("ai:") ? 1 : 0, c.actor, t, t,
    )
    .run();
  await ftsUpsert(c, "page", pid, data.title, "");
  await logEvent(c, "create", "page", pid, { title: data.title, collection_id: data.collection_id ?? null });
  return (await getPage(c, pid))!;
}

export async function updatePage(c: Ctx, pid: string, patch: z.input<typeof updatePageInput>): Promise<Page> {
  const data = updatePageInput.parse(patch);
  const existing = await getPage(c, pid);
  if (!existing) throw new RuleError(`page ${pid} not found`, 404);
  // Properties merge rather than replace: setting a status must not wipe a due
  // date. An explicit null clears one key, which is how a property is unset.
  const merged = data.properties ? { ...properties(existing), ...data.properties } : properties(existing);
  await c.db
    .prepare(
      `UPDATE page SET title = ?, icon = ?, cover = ?, status = ?, position = ?, properties_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      data.title ?? existing.title,
      data.icon === undefined ? existing.icon : data.icon,
      data.cover === undefined ? existing.cover : data.cover,
      data.status ?? existing.status,
      data.position ?? existing.position,
      JSON.stringify(merged),
      now(),
      pid,
    )
    .run();
  if (data.title !== undefined && data.title !== existing.title) {
    await ftsUpsert(c, "page", pid, data.title, await bodyText(c, pid));
  }
  await logEvent(c, "update", "page", pid, data);
  return (await getPage(c, pid))!;
}

/** Concatenated block text, for the FTS body column. */
export async function bodyText(c: Ctx, pid: string): Promise<string> {
  const rows = await all<{ t: string | null }>(c, `SELECT json_extract(content_json, '$.text') AS t FROM block WHERE page_id = ?`, pid);
  return rows.map((r) => r.t ?? "").filter(Boolean).join(" ");
}

/** Move a page in the tree, or in/out of a collection. Cycle-checked: a page
 *  cannot become its own ancestor, which would detach the subtree from the root
 *  and make it unreachable in the sidebar forever. */
export async function movePage(c: Ctx, pid: string, input: z.input<typeof movePageInput>): Promise<Page> {
  const data = movePageInput.parse(input);
  const existing = await getPage(c, pid);
  if (!existing) throw new RuleError(`page ${pid} not found`, 404);
  const target = data.new_parent_page_id ?? null;
  if (target === pid) throw new RuleError("a page cannot be its own parent", 400);
  if (target) {
    if (!(await getPage(c, target))) throw new RuleError(`page ${target} not found`, 404);
    const ancestors = await getAncestors(c, target);
    if (ancestors.some((a) => a.id === pid)) throw new RuleError("that move would create a cycle", 400);
  }
  const position = data.position ?? (await nextPosition(c, target, null));
  await c.db
    .prepare(`UPDATE page SET parent_page_id = ?, position = ?, updated_at = ? WHERE id = ?`)
    .bind(target, position, now(), pid)
    .run();
  await logEvent(c, "update", "page", pid, { moved_to: target });
  return (await getPage(c, pid))!;
}

/** Descendant ids, including the page itself — the delete/archive footprint. */
export async function subtreeIds(c: Ctx, pid: string): Promise<string[]> {
  const out: string[] = [pid];
  const seen = new Set<string>([pid]);
  for (let i = 0; i < out.length; i++) {
    const kids = await all<{ id: string }>(c, `SELECT id FROM page WHERE parent_page_id = ?`, out[i]);
    for (const k of kids) if (!seen.has(k.id)) { seen.add(k.id); out.push(k.id); }
  }
  return out;
}

/** Move a page and its subtree to the trash. This is what the UI calls: an
 *  accidental delete costs everything under the page, so the default has to be
 *  reversible. `deletePage` still exists for the permanent version. */
export async function trashPage(c: Ctx, pid: string): Promise<void> {
  const existing = await getPage(c, pid);
  if (!existing) throw new RuleError(`page ${pid} not found`, 404);
  const ids = await subtreeIds(c, pid);
  const marks = ids.map(() => "?").join(",");
  const t = now();
  // Only the top of the subtree is marked as the trash entry; descendants are
  // hidden with it and come back with it, rather than appearing as separate
  // rows in the trash that could be restored on their own into nothing.
  await c.db.prepare(`UPDATE page SET trashed_at = ?, updated_at = ? WHERE id IN (${marks})`).bind(t, t, ...ids).run();
  await c.db.prepare(`UPDATE page SET properties_json = json_set(properties_json, '$.trash_root', json('true')) WHERE id = ?`).bind(pid).run();
  await logEvent(c, "trash", "page", pid, { title: existing.title, pages: ids.length });
}

/** Everything currently in the trash — only the roots, newest first. */
export function listTrash(c: Ctx): Promise<Page[]> {
  return all<Page>(
    c,
    `SELECT * FROM page WHERE trashed_at IS NOT NULL
       AND json_extract(properties_json, '$.trash_root') = 1
     ORDER BY trashed_at DESC`,
  );
}

/** Put a trashed page back. If its parent was trashed too and not restored, it
 *  returns to the root rather than into something invisible. */
export async function restorePage(c: Ctx, pid: string): Promise<Page> {
  const existing = await getPage(c, pid);
  if (!existing) throw new RuleError(`page ${pid} not found`, 404);
  const ids = await subtreeIds(c, pid);
  const marks = ids.map(() => "?").join(",");
  await c.db.prepare(`UPDATE page SET trashed_at = NULL, updated_at = ? WHERE id IN (${marks})`).bind(now(), ...ids).run();
  await c.db.prepare(`UPDATE page SET properties_json = json_remove(properties_json, '$.trash_root') WHERE id = ?`).bind(pid).run();
  const parent = existing.parent_page_id ? await getPage(c, existing.parent_page_id) : null;
  if (existing.parent_page_id && (!parent || parent.trashed_at)) {
    await c.db.prepare(`UPDATE page SET parent_page_id = NULL WHERE id = ?`).bind(pid).run();
  }
  await logEvent(c, "restore", "page", pid, { title: existing.title });
  return (await getPage(c, pid))!;
}

/** Delete a page and everything under it: child pages, bodies, the collections
 *  it owns and their rows. Permanent — the UI routes through trashPage instead.
 *  Unlike v7's deleteWorkspace this does NOT promote children: a page tree is
 *  the user's own structure, and silently relocating its contents somewhere else
 *  is more surprising than deleting what was asked. */
export async function deletePage(c: Ctx, pid: string): Promise<void> {
  const existing = await getPage(c, pid);
  if (!existing) throw new RuleError(`page ${pid} not found`, 404);
  const ids = await subtreeIds(c, pid);
  const marks = ids.map(() => "?").join(",");

  // Collections owned anywhere in the subtree, plus the rows inside them.
  const cols = await all<{ id: string }>(c, `SELECT id FROM collection WHERE parent_page_id IN (${marks})`, ...ids);
  const colIds = cols.map((x) => x.id);
  if (colIds.length) {
    const cm = colIds.map(() => "?").join(",");
    const rows = await all<{ id: string }>(c, `SELECT id FROM page WHERE collection_id IN (${cm})`, ...colIds);
    for (const r of rows) if (!ids.includes(r.id)) ids.push(r.id);
    await c.db.prepare(`DELETE FROM collection_view WHERE collection_id IN (${cm})`).bind(...colIds).run();
  }

  const allMarks = ids.map(() => "?").join(",");
  await c.db.prepare(`DELETE FROM block_revision WHERE block_id IN (SELECT id FROM block WHERE page_id IN (${allMarks}))`).bind(...ids).run();
  await c.db.prepare(`DELETE FROM daily_focus_slot WHERE page_id IN (${allMarks})`).bind(...ids).run();
  await c.db.prepare(`DELETE FROM block WHERE page_id IN (${allMarks})`).bind(...ids).run();
  await c.db.prepare(`DELETE FROM page_patch WHERE page_id IN (${allMarks})`).bind(...ids).run();
  await c.db.prepare(`DELETE FROM relationship WHERE (source_type = 'page' AND source_id IN (${allMarks}))`).bind(...ids).run();
  await c.db.prepare(`DELETE FROM relationship WHERE (target_type = 'page' AND target_id IN (${allMarks}))`).bind(...ids).run();
  await c.db.prepare(`DELETE FROM search_fts WHERE entity_type = 'page' AND entity_id IN (${allMarks})`).bind(...ids).run();
  if (colIds.length) {
    await c.db.prepare(`DELETE FROM collection WHERE id IN (${colIds.map(() => "?").join(",")})`).bind(...colIds).run();
  }
  // Children before parents, so the self-referencing foreign key stays satisfied.
  await c.db.prepare(`DELETE FROM page WHERE id IN (${allMarks}) AND id <> ?`).bind(...ids, pid).run();
  await c.db.prepare(`DELETE FROM page WHERE id = ?`).bind(pid).run();
  await ftsDelete(c, "page", pid);
  await logEvent(c, "delete", "page", pid, { title: existing.title, pages_removed: ids.length });
}

/** Resolve a "Side Projects / et al." style path to a page. Titles are matched
 *  case-insensitively because nobody types their own page names exactly. */
export async function resolvePagePath(c: Ctx, path: string): Promise<Page | null> {
  const parts = path.split("/").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let parent: string | null = null;
  let found: Page | null = null;
  for (const part of parts) {
    const kids: Page[] = await listChildren(c, parent);
    found = kids.find((k) => k.title.toLowerCase() === part.toLowerCase()) ?? null;
    if (!found) return null;
    parent = found.id;
  }
  return found;
}

export interface HistoryEntry {
  id: string;
  block_id: string;
  content_json: string;
  version: number;
  actor: string;
  created_at: number;
  block_type: string | null;
  current_content: string | null;
}

/** A page's edit history: every retained block revision, newest first. The rows
 *  have been written since v7 and never had anywhere to surface. */
export function pageHistory(c: Ctx, pid: string, limit = 100): Promise<HistoryEntry[]> {
  return all<HistoryEntry>(
    c,
    `SELECT r.*, b.type AS block_type, b.content_json AS current_content
       FROM block_revision r JOIN block b ON r.block_id = b.id
      WHERE b.page_id = ? ORDER BY r.created_at DESC LIMIT ?`,
    pid, limit,
  );
}

/** Put a single block back to a retained revision. */
export async function restoreRevision(c: Ctx, revisionId: string): Promise<void> {
  const rev = await first<{ block_id: string; content_json: string }>(
    c, `SELECT block_id, content_json FROM block_revision WHERE id = ?`, revisionId,
  );
  if (!rev) throw new RuleError(`revision ${revisionId} not found`, 404);
  const block = await first<{ id: string; content_json: string; version: number; page_id: string }>(
    c, `SELECT id, content_json, version, page_id FROM block WHERE id = ?`, rev.block_id,
  );
  if (!block) throw new RuleError(`that block no longer exists`, 404);
  // Restoring is itself an edit, so the version being replaced is retained too —
  // otherwise restoring would be the one action you could not undo.
  await c.db
    .prepare(`INSERT INTO block_revision (id, block_id, content_json, version, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id("brev"), block.id, block.content_json, block.version, c.actor, now())
    .run();
  await c.db
    .prepare(`UPDATE block SET content_json = ?, version = version + 1, updated_at = ? WHERE id = ?`)
    .bind(rev.content_json, now(), block.id)
    .run();
  await logEvent(c, "restore_revision", "page", block.page_id, { block_id: block.id });
}
