// Notes: what you write. A note has a title, a body of blocks, and child notes.
import { z } from "zod";
import { createNoteInput, moveNoteInput, updateNoteInput } from "../schema";
import { Ctx, RuleError, all, first, ftsDelete, id, logEvent, marks, now } from "./db";
import { applyOps, reindexNote } from "./blocks";

export interface Note {
  id: string;
  parent_id: string | null;
  title: string;
  position: number;
  source_id: string | null;
  actor: string;
  trashed_at: number | null;
  trash_root: number;
  created_at: number;
  updated_at: number;
}

export interface NoteNode extends Note { children: NoteNode[] }

export function getNote(c: Ctx, nid: string): Promise<Note | null> {
  return first<Note>(c, `SELECT * FROM note WHERE id = ?`, nid);
}

/** A note that exists and is not in the trash, or a 404. */
export async function requireNote(c: Ctx, nid: string): Promise<Note> {
  const note = await getNote(c, nid);
  if (!note || note.trashed_at) throw new RuleError(`note ${nid} not found`, 404);
  return note;
}

/** The whole tree in one query, assembled in memory: a personal knowledge base
 *  is small enough that one scan beats a recursive CTE or a query per level. */
export async function getNoteTree(c: Ctx): Promise<NoteNode[]> {
  const rows = await all<Note>(c, `SELECT * FROM note WHERE trashed_at IS NULL ORDER BY position, created_at`);
  const byId = new Map<string, NoteNode>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: NoteNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function listChildren(c: Ctx, nid: string): Promise<Note[]> {
  return all<Note>(c, `SELECT * FROM note WHERE parent_id = ? AND trashed_at IS NULL ORDER BY position, created_at`, nid);
}

/** Every ancestor, root first: the breadcrumb, and a note's inherited context. */
export async function getAncestors(c: Ctx, nid: string): Promise<Note[]> {
  const chain: Note[] = [];
  const seen = new Set<string>([nid]);
  let cur = await getNote(c, nid);
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    cur = await getNote(c, cur.parent_id);
    if (cur) chain.unshift(cur);
  }
  return chain;
}

async function nextPosition(c: Ctx, parentId: string | null): Promise<number> {
  const row = parentId === null
    ? await first<{ m: number | null }>(c, `SELECT MAX(position) AS m FROM note WHERE parent_id IS NULL`)
    : await first<{ m: number | null }>(c, `SELECT MAX(position) AS m FROM note WHERE parent_id = ?`, parentId);
  return (row?.m ?? -1) + 1;
}

export async function createNote(
  c: Ctx,
  input: z.input<typeof createNoteInput> & { source_id?: string | null },
): Promise<Note> {
  const data = createNoteInput.parse(input);
  const parent = data.parent_id ?? null;
  if (parent) await requireNote(c, parent);
  const nid = id("note");
  const t = now();
  await c.db
    .prepare(`INSERT INTO note (id, parent_id, title, position, source_id, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(nid, parent, data.title, await nextPosition(c, parent), input.source_id ?? null, c.actor, t, t)
    .run();
  if (data.body?.trim()) await applyOps(c, nid, [{ op: "replace_content", content: data.body }], c.actor);
  else await reindexNote(c, nid);
  await logEvent(c, "create", "note", nid, { title: data.title });
  return (await getNote(c, nid))!;
}

export async function updateNote(c: Ctx, nid: string, patch: z.input<typeof updateNoteInput>): Promise<Note> {
  const data = updateNoteInput.parse(patch);
  await requireNote(c, nid);
  await c.db.prepare(`UPDATE note SET title = ?, updated_at = ? WHERE id = ?`).bind(data.title, now(), nid).run();
  await reindexNote(c, nid);
  await logEvent(c, "update", "note", nid, data);
  return (await getNote(c, nid))!;
}

/** Re-parent a note. Cycle-checked: a note cannot become its own ancestor, which
 *  would detach the subtree from the root and make it unreachable. */
export async function moveNote(c: Ctx, nid: string, input: z.input<typeof moveNoteInput>): Promise<Note> {
  const data = moveNoteInput.parse(input);
  await requireNote(c, nid);
  const target = data.parent_id ?? null;
  if (target === nid) throw new RuleError("a note cannot be its own parent", 400);
  if (target) {
    await requireNote(c, target);
    if ((await getAncestors(c, target)).some((a) => a.id === nid)) throw new RuleError("that move would create a cycle", 400);
  }
  await c.db
    .prepare(`UPDATE note SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?`)
    .bind(target, data.position ?? (await nextPosition(c, target)), now(), nid)
    .run();
  await logEvent(c, "move", "note", nid, { parent_id: target });
  return (await getNote(c, nid))!;
}

/** A note and every note under it. */
export async function subtreeIds(c: Ctx, nid: string): Promise<string[]> {
  const out = [nid];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i++) {
    for (const k of await all<{ id: string }>(c, `SELECT id FROM note WHERE parent_id = ?`, out[i])) {
      if (!seen.has(k.id)) { seen.add(k.id); out.push(k.id); }
    }
  }
  return out;
}

/** Move a note and its subtree to the trash. Reversible on purpose: an accidental
 *  delete would take everything under the note with it. */
export async function trashNote(c: Ctx, nid: string): Promise<void> {
  const note = await requireNote(c, nid);
  const ids = await subtreeIds(c, nid);
  const t = now();
  await c.db.prepare(`UPDATE note SET trashed_at = ?, updated_at = ? WHERE id IN (${marks(ids.length)})`).bind(t, t, ...ids).run();
  await c.db.prepare(`UPDATE note SET trash_root = 1 WHERE id = ?`).bind(nid).run();
  await logEvent(c, "trash", "note", nid, { title: note.title, notes: ids.length });
}

/** What is in the trash: only the notes that were trashed directly, newest first. */
export function listTrash(c: Ctx): Promise<Note[]> {
  return all<Note>(c, `SELECT * FROM note WHERE trash_root = 1 ORDER BY trashed_at DESC`);
}

/** Bring a note back. If its parent is still trashed, it returns to the root
 *  rather than into something invisible. */
export async function restoreNote(c: Ctx, nid: string): Promise<Note> {
  const note = await getNote(c, nid);
  if (!note?.trash_root) throw new RuleError(`note ${nid} is not in the trash`, 404);
  const ids = await subtreeIds(c, nid);
  await c.db.prepare(`UPDATE note SET trashed_at = NULL, updated_at = ? WHERE id IN (${marks(ids.length)})`).bind(now(), ...ids).run();
  const parent = note.parent_id ? await getNote(c, note.parent_id) : null;
  await c.db.prepare(`UPDATE note SET trash_root = 0, parent_id = ? WHERE id = ?`).bind(parent && !parent.trashed_at ? parent.id : null, nid).run();
  await logEvent(c, "restore", "note", nid, { title: note.title });
  return (await getNote(c, nid))!;
}

/** Permanently delete a trashed note and everything under it. Tasks and sources
 *  that pointed at it survive, unlinked: they are not part of the note. */
export async function deleteNote(c: Ctx, nid: string): Promise<void> {
  const note = await getNote(c, nid);
  if (!note?.trash_root) throw new RuleError(`only a note in the trash can be deleted permanently`, 400);
  const ids = await subtreeIds(c, nid);
  const m = marks(ids.length);
  await c.db.batch([
    c.db.prepare(`DELETE FROM block_revision WHERE block_id IN (SELECT id FROM block WHERE note_id IN (${m}))`).bind(...ids),
    c.db.prepare(`DELETE FROM proposal WHERE note_id IN (${m})`).bind(...ids),
    c.db.prepare(`UPDATE task SET note_id = NULL WHERE note_id IN (${m})`).bind(...ids),
    c.db.prepare(`UPDATE source SET note_id = NULL WHERE note_id IN (${m})`).bind(...ids),
    // Children before parents: block and note both reference themselves.
    c.db.prepare(`UPDATE block SET parent_block_id = NULL WHERE note_id IN (${m})`).bind(...ids),
    c.db.prepare(`DELETE FROM block WHERE note_id IN (${m})`).bind(...ids),
    c.db.prepare(`UPDATE note SET parent_id = NULL WHERE id IN (${m})`).bind(...ids),
    c.db.prepare(`DELETE FROM note WHERE id IN (${m})`).bind(...ids),
  ]);
  for (const x of ids) await ftsDelete(c, "note", x);
  await logEvent(c, "delete", "note", nid, { title: note.title, notes: ids.length });
}

// ---- history ----------------------------------------------------------------

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

/** Every retained block revision on a note, newest first: what an edit replaced,
 *  and who wrote the version that was replaced. */
export function noteHistory(c: Ctx, nid: string, limit = 100): Promise<HistoryEntry[]> {
  return all<HistoryEntry>(
    c,
    `SELECT r.*, b.type AS block_type, b.content_json AS current_content
       FROM block_revision r JOIN block b ON r.block_id = b.id
      WHERE b.note_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`,
    nid, limit,
  );
}

/** Put one block back to a retained revision. Restoring is itself an edit, so the
 *  version it replaces is kept too — otherwise it would be the one action you
 *  could not undo. */
export async function restoreRevision(c: Ctx, revisionId: string): Promise<void> {
  const rev = await first<{ block_id: string; content_json: string }>(c, `SELECT block_id, content_json FROM block_revision WHERE id = ?`, revisionId);
  if (!rev) throw new RuleError(`revision ${revisionId} not found`, 404);
  const block = await first<{ id: string; content_json: string; version: number; note_id: string; actor: string }>(
    c, `SELECT id, content_json, version, note_id, actor FROM block WHERE id = ?`, rev.block_id,
  );
  if (!block) throw new RuleError("that block no longer exists", 404);
  const t = now();
  await c.db.batch([
    c.db.prepare(`INSERT INTO block_revision (id, block_id, content_json, version, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id("brev"), block.id, block.content_json, block.version, block.actor, t),
    c.db.prepare(`UPDATE block SET content_json = ?, version = version + 1, actor = ?, updated_at = ? WHERE id = ?`)
      .bind(rev.content_json, c.actor, t, block.id),
  ]);
  await reindexNote(c, block.note_id);
  await logEvent(c, "restore_revision", "note", block.note_id, { block_id: block.id });
}
