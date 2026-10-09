// Blocks: a note's body.
//
// Two ways to write one, and the split is the product. The HUMAN surface (the
// web app, over REST) writes blocks directly: `writeBlocks` for op lists and
// `setBlocks` for the editor's whole tree. AGENTS never do: they propose a
// patch (proposals.ts), and its ops only run here once a human accepts it —
// under the agent's name, so the body records who actually wrote each block.
import type { z } from "zod";
import { blockOp, blockTree, type BlockOp } from "../schema";
import { Ctx, all, first, ftsUpsert, id, logEvent, marks, now } from "./db";
import { requireNote } from "./notes";
import { applyOpsToBody, bodyLines, diffLines, type BodyNode, type DiffLine } from "./body";

export interface Block {
  id: string;
  note_id: string;
  parent_block_id: string | null;
  type: string;
  content_json: string;
  position: number;
  version: number;
  actor: string;
  created_at: number;
  updated_at: number;
}

/** A note's blocks, flat but depth-first, so a client can render them in
 *  document order without building the tree first. */
export async function getBlocks(c: Ctx, noteId: string): Promise<Block[]> {
  const rows = await all<Block>(c, `SELECT * FROM block WHERE note_id = ? ORDER BY position`, noteId);
  const byParent = new Map<string | null, Block[]>();
  for (const b of rows) {
    if (!byParent.has(b.parent_block_id)) byParent.set(b.parent_block_id, []);
    byParent.get(b.parent_block_id)!.push(b);
  }
  const out: Block[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null) => {
    for (const b of byParent.get(parent) ?? []) {
      if (seen.has(b.id)) continue; // a cycle would otherwise hang the request
      seen.add(b.id);
      out.push(b);
      walk(b.id);
    }
  };
  walk(null);
  // Anything orphaned by a missing parent still appears: misplaced beats invisible.
  for (const b of rows) if (!seen.has(b.id)) out.push(b);
  return out;
}

export function getBlock(c: Ctx, bid: string): Promise<Block | null> {
  return first<Block>(c, `SELECT * FROM block WHERE id = ?`, bid);
}

/** A note's body as plain text, in document order. */
export async function noteText(c: Ctx, noteId: string): Promise<string> {
  return (await getBlocks(c, noteId)).map(blockText).filter(Boolean).join("\n");
}

function blockText(b: Block): string {
  try {
    const content = JSON.parse(b.content_json);
    if (Array.isArray(content.columns)) return [content.columns, ...(content.rows ?? [])].flat().join(" ");
    return typeof content.text === "string" ? content.text : "";
  } catch { return ""; }
}

/** Refresh a note's keyword index entry from its title and body. */
export async function reindexNote(c: Ctx, noteId: string): Promise<void> {
  const note = await first<{ title: string }>(c, `SELECT title FROM note WHERE id = ?`, noteId);
  if (note) await ftsUpsert(c, "note", noteId, note.title, await noteText(c, noteId));
}

/** Stored blocks as a plain body. */
export function toBody(blocks: Block[]): BodyNode[] {
  return blocks.map((b) => ({
    id: b.id, parent_block_id: b.parent_block_id, type: b.type, position: b.position,
    content: (() => { try { return JSON.parse(b.content_json) as Record<string, unknown>; } catch { return {}; } })(),
  }));
}

/** Remove blocks and their kept revisions, children before parents. */
async function deleteBlocks(c: Ctx, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const m = marks(ids.length);
  await c.db.batch([
    c.db.prepare(`DELETE FROM block_revision WHERE block_id IN (${m})`).bind(...ids),
    c.db.prepare(`UPDATE block SET parent_block_id = NULL WHERE id IN (${m})`).bind(...ids),
    c.db.prepare(`DELETE FROM block WHERE id IN (${m})`).bind(...ids),
  ]);
}

/** Make a note's stored blocks match `next`, written as `actor`.
 *
 *  Reconciling by id rather than replacing wholesale keeps block identity —
 *  and with it each block's history and author. An untouched block is not
 *  written at all, so editing one paragraph does not bump every version; a
 *  moved block keeps its author, because moving is not writing. */
async function reconcile(c: Ctx, noteId: string, existing: Block[], next: BodyNode[], actor: string): Promise<{ removed: number }> {
  const byId = new Map(existing.map((b) => [b.id, b]));
  const t = now();
  // Parents before children, so the self-reference is never violated.
  const ordered = [...next].sort((a, b) => (a.parent_block_id ? 1 : 0) - (b.parent_block_id ? 1 : 0));
  const writes: D1PreparedStatement[] = [];
  for (const node of ordered) {
    const prev = byId.get(node.id);
    const json = JSON.stringify(node.content);
    if (!prev) {
      writes.push(c.db
        .prepare(`INSERT INTO block (id, note_id, parent_block_id, type, content_json, position, version, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .bind(node.id, noteId, node.parent_block_id, node.type, json, node.position, actor, t, t));
      continue;
    }
    const contentChanged = prev.content_json !== json || prev.type !== node.type;
    if (!contentChanged && prev.parent_block_id === node.parent_block_id && prev.position === node.position) continue;
    if (contentChanged) {
      // Keep the version being replaced, attributed to whoever wrote it.
      writes.push(c.db
        .prepare(`INSERT INTO block_revision (id, block_id, content_json, version, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id("brev"), prev.id, prev.content_json, prev.version, prev.actor, t));
    }
    writes.push(c.db
      .prepare(`UPDATE block SET parent_block_id = ?, type = ?, content_json = ?, position = ?, version = version + ?, actor = ?, updated_at = ? WHERE id = ?`)
      .bind(node.parent_block_id, node.type, json, node.position, contentChanged ? 1 : 0, contentChanged ? actor : prev.actor, t, node.id));
  }
  if (writes.length) await c.db.batch(writes);

  const keep = new Set(next.map((n) => n.id));
  const gone = existing.filter((b) => !keep.has(b.id)).map((b) => b.id);
  await deleteBlocks(c, gone);
  await c.db.prepare(`UPDATE note SET updated_at = ? WHERE id = ?`).bind(t, noteId).run();
  await reindexNote(c, noteId);
  return { removed: gone.length };
}

/** What a list of ops would do to a note, without writing anything. Throws if
 *  any op is invalid against the note as it is now. */
export async function previewOps(c: Ctx, noteId: string, ops: BlockOp[]): Promise<{ before: string[]; after: string[]; diff: DiffLine[] }> {
  const before = toBody(await getBlocks(c, noteId));
  const after = applyOpsToBody(before, ops, () => id("blk"));
  const [a, b] = [bodyLines(before), bodyLines(after)];
  return { before: a, after: b, diff: diffLines(a, b) };
}

/** Apply ops to a note as `actor`: compute the new body, then write it. All of
 *  the ops apply or none do. The only way ops change a body: a human's direct
 *  write, or an accepted agent patch. */
export async function applyOps(c: Ctx, noteId: string, ops: BlockOp[], actor: string): Promise<void> {
  const existing = await getBlocks(c, noteId);
  const next = applyOpsToBody(toBody(existing), ops, () => id("blk"));
  await reconcile(c, noteId, existing, next, actor);
}

/** Direct block write — the human surface only. Never exposed over MCP. */
export async function writeBlocks(c: Ctx, noteId: string, ops: unknown): Promise<Block[]> {
  await requireNote(c, noteId);
  const parsed = blockOp.array().parse(ops);
  await applyOps(c, noteId, parsed, c.actor);
  await logEvent(c, "update", "note", noteId, { blocks: parsed.length });
  return getBlocks(c, noteId);
}

/** The editor's whole tree, as the new body. The editor holds the document and
 *  hands it back on each change, so there is no "insert after X", only "this is
 *  the body now". Human-only, like writeBlocks. */
export async function setBlocks(c: Ctx, noteId: string, input: z.input<typeof blockTree>): Promise<Block[]> {
  await requireNote(c, noteId);
  const tree = blockTree.parse(input);
  const { removed } = await reconcile(c, noteId, await getBlocks(c, noteId), tree, c.actor);
  await logEvent(c, "update", "note", noteId, { blocks: tree.length, removed });
  return getBlocks(c, noteId);
}
