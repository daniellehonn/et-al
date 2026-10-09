// Blocks: a note's body.
//
// Two ways to write one, and the split is the product. The HUMAN surface (the
// web app, over REST) writes blocks directly: `writeBlocks` for op lists and
// `setBlocks` for the editor's whole tree. AGENTS never do: they propose a
// patch (proposals.ts), and its ops only run here once a human accepts it —
// under the agent's name, so the body records who actually wrote each block.
import type { z } from "zod";
import { blockOp, blockTree, type BlockOp } from "../schema";
import { Ctx, RuleError, all, first, ftsUpsert, id, logEvent, marks, now } from "./db";
import { requireNote } from "./notes";

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

async function positionAfter(c: Ctx, noteId: string, parent: string | null, afterId: string | null | undefined): Promise<number> {
  const siblings = parent === null
    ? await all<Block>(c, `SELECT * FROM block WHERE note_id = ? AND parent_block_id IS NULL ORDER BY position`, noteId)
    : await all<Block>(c, `SELECT * FROM block WHERE parent_block_id = ? ORDER BY position`, parent);
  if (!afterId) return (siblings[0]?.position ?? 1) - 1; // prepend
  const idx = siblings.findIndex((b) => b.id === afterId);
  if (idx === -1) return (siblings[siblings.length - 1]?.position ?? 0) + 1; // append
  const next = siblings[idx + 1];
  return next ? (siblings[idx].position + next.position) / 2 : siblings[idx].position + 1;
}

// Parse markdown (or plain text) into blocks — enough for what agents write:
// headings, bullets, numbered items, todos, quotes, fenced code, dividers, and
// pipe tables. Indentation nests list items, which is what makes a pasted
// outline survive as an outline.
type ParsedBlock = { type: string; content: Record<string, unknown>; depth: number };
const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
const isTableSep = (line: string): boolean => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);

export function markdownToBlocks(md: string): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let code: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      if (inCode) { out.push({ type: "code", content: { text: code.join("\n") }, depth: 0 }); code = []; inCode = false; }
      else inCode = true;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const s = line.trim();
    if (s === "") continue;
    // Two spaces or one tab per level, which is what both editors and agents emit.
    const indent = line.match(/^[\t ]*/)?.[0] ?? "";
    const depth = Math.floor((indent.replace(/\t/g, "  ").length) / 2);

    if (s.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const columns = cells(s);
      const rows: string[][] = [];
      i += 2; // skip header + separator
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(cells(lines[i])); i++; }
      i--; // the for-loop will i++ past the last consumed row
      out.push({ type: "table", content: { columns, rows }, depth: 0 });
      continue;
    }

    // A standalone image line is an image block, not a paragraph that happens to
    // contain markdown — otherwise an imported screenshot renders as its own
    // source text.
    const img = s.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) { out.push({ type: "image", content: { url: img[2], caption: img[1] }, depth: 0 }); continue; }

    if (/^#{1,6}\s+/.test(s)) out.push({ type: "heading", content: { text: s.replace(/^#{1,6}\s+/, ""), level: (s.match(/^#+/)?.[0].length ?? 1) }, depth: 0 });
    else if (/^(-|\*|\+)\s+\[[ xX]\]\s+/.test(s)) out.push({ type: "todo", content: { text: s.replace(/^(-|\*|\+)\s+\[[ xX]\]\s+/, ""), checked: /\[[xX]\]/.test(s) }, depth });
    else if (/^(-|\*|\+)\s+/.test(s)) out.push({ type: "bullet", content: { text: s.replace(/^(-|\*|\+)\s+/, "") }, depth });
    else if (/^\d+\.\s+/.test(s)) out.push({ type: "numbered", content: { text: s.replace(/^\d+\.\s+/, "") }, depth });
    else if (/^>\s?/.test(s)) out.push({ type: "quote", content: { text: s.replace(/^>\s?/, "") }, depth: 0 });
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) out.push({ type: "divider", content: {}, depth: 0 });
    else out.push({ type: "paragraph", content: { text: s }, depth: 0 });
  }
  if (inCode && code.length) out.push({ type: "code", content: { text: code.join("\n") }, depth: 0 });
  return out;
}

/** Write parsed blocks, rebuilding the nesting implied by their depth. */
async function insertParsed(c: Ctx, noteId: string, parsed: ParsedBlock[], actor: string, t: number): Promise<void> {
  const stack: string[] = []; // stack[d] is the most recent block at depth d — the parent for d+1
  let pos = 1;
  for (const b of parsed) {
    const depth = Math.min(b.depth, stack.length); // never skip a level
    const bid = id("blk");
    await c.db
      .prepare(`INSERT INTO block (id, note_id, parent_block_id, type, content_json, position, version, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .bind(bid, noteId, depth > 0 ? stack[depth - 1] : null, b.type, JSON.stringify(b.content), pos++, actor, t, t)
      .run();
    stack[depth] = bid;
    stack.length = depth + 1;
  }
}

/** A block and everything nested under it. */
async function blockSubtree(c: Ctx, bid: string): Promise<string[]> {
  const out = [bid];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i++) {
    for (const k of await all<{ id: string }>(c, `SELECT id FROM block WHERE parent_block_id = ?`, out[i])) {
      if (!seen.has(k.id)) { seen.add(k.id); out.push(k.id); }
    }
  }
  return out;
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

/** Keep the version a write is about to replace, attributed to whoever wrote it. */
function keepRevision(c: Ctx, prev: Block, t: number) {
  return c.db
    .prepare(`INSERT INTO block_revision (id, block_id, content_json, version, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id("brev"), prev.id, prev.content_json, prev.version, prev.actor, t);
}

/** Every block an op list names must already be on this note. Checked before
 *  anything is written, so a bad op cannot leave a body half-applied. */
export async function assertOpsTarget(c: Ctx, noteId: string, ops: BlockOp[]): Promise<void> {
  const named = [...new Set(ops.flatMap((op) => [
    "id" in op ? op.id : null,
    "after" in op ? op.after : null,
    "parent" in op ? op.parent : null,
  ]).filter((x): x is string => !!x))];
  if (!named.length) return;
  const found = await all<{ id: string }>(c, `SELECT id FROM block WHERE note_id = ? AND id IN (${marks(named.length)})`, noteId, ...named);
  const missing = named.filter((x) => !found.some((f) => f.id === x));
  if (missing.length) throw new RuleError(`block ${missing[0]} is not on note ${noteId}`, 400);
}

/** Run block ops against a note, written as `actor`. The only path that changes
 *  a body from ops: a human's direct write, or an accepted agent patch. */
export async function applyOps(c: Ctx, noteId: string, ops: BlockOp[], actor: string): Promise<void> {
  await assertOpsTarget(c, noteId, ops);
  const t = now();
  for (const op of ops) {
    if (op.op === "replace_content") {
      // A rewrite replaces the blocks rather than editing them, so their history
      // goes with them; a granular update/delete patch keeps it.
      const existing = await all<{ id: string }>(c, `SELECT id FROM block WHERE note_id = ?`, noteId);
      await deleteBlocks(c, existing.map((b) => b.id));
      await insertParsed(c, noteId, markdownToBlocks(op.content), actor, t);
    } else if (op.op === "insert") {
      const parent = op.parent ?? null;
      await c.db
        .prepare(`INSERT INTO block (id, note_id, parent_block_id, type, content_json, position, version, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .bind(id("blk"), noteId, parent, op.type, JSON.stringify(op.content), await positionAfter(c, noteId, parent, op.after), actor, t, t)
        .run();
    } else if (op.op === "update") {
      const prev = (await getBlock(c, op.id))!;
      await c.db.batch([
        keepRevision(c, prev, t),
        c.db.prepare(`UPDATE block SET type = ?, content_json = ?, version = version + 1, actor = ?, updated_at = ? WHERE id = ?`)
          .bind(op.type ?? prev.type, JSON.stringify(op.content), actor, t, op.id),
      ]);
    } else if (op.op === "delete") {
      await deleteBlocks(c, await blockSubtree(c, op.id));
    } else if (op.op === "move") {
      const parent = op.parent ?? null;
      // Moving a block under its own descendant would detach the subtree.
      if (parent && (await blockSubtree(c, op.id)).includes(parent)) throw new RuleError("a block cannot move inside itself", 400);
      await c.db.prepare(`UPDATE block SET parent_block_id = ?, position = ?, updated_at = ? WHERE id = ? AND note_id = ?`)
        .bind(parent, await positionAfter(c, noteId, parent, op.after), t, op.id, noteId).run();
    }
  }
  await c.db.prepare(`UPDATE note SET updated_at = ? WHERE id = ?`).bind(t, noteId).run();
  await reindexNote(c, noteId);
}

/** Direct block write — the human surface only. Never exposed over MCP. */
export async function writeBlocks(c: Ctx, noteId: string, ops: unknown): Promise<Block[]> {
  await requireNote(c, noteId);
  const parsed = blockOp.array().parse(ops);
  await applyOps(c, noteId, parsed, c.actor);
  await logEvent(c, "update", "note", noteId, { blocks: parsed.length });
  return getBlocks(c, noteId);
}

/** Reconcile a note's body against the editor's whole tree.
 *
 *  The editor holds the document and hands back the full tree on each change,
 *  so there is no "insert after X", only "this is the body now". Reconciling by
 *  id rather than replacing wholesale keeps block identity — and with it each
 *  block's history and author. Human-only, like writeBlocks. */
export async function setBlocks(c: Ctx, noteId: string, input: z.input<typeof blockTree>): Promise<Block[]> {
  await requireNote(c, noteId);
  const tree = blockTree.parse(input);
  const existing = await all<Block>(c, `SELECT * FROM block WHERE note_id = ?`, noteId);
  const byId = new Map(existing.map((b) => [b.id, b]));
  const t = now();

  // Parents before children, so the self-reference is never violated.
  const ordered = [...tree].sort((a, b) => (a.parent_block_id ? 1 : 0) - (b.parent_block_id ? 1 : 0));
  const writes: D1PreparedStatement[] = [];
  for (const node of ordered) {
    const prev = byId.get(node.id);
    const json = JSON.stringify(node.content);
    if (!prev) {
      writes.push(c.db
        .prepare(`INSERT INTO block (id, note_id, parent_block_id, type, content_json, position, version, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .bind(node.id, noteId, node.parent_block_id, node.type, json, node.position, c.actor, t, t));
      continue;
    }
    const contentChanged = prev.content_json !== json || prev.type !== node.type;
    // An untouched block is skipped entirely: editing one paragraph must not bump
    // every other block's version, or history becomes noise.
    if (!contentChanged && prev.parent_block_id === node.parent_block_id && prev.position === node.position) continue;
    if (contentChanged) writes.push(keepRevision(c, prev, t));
    writes.push(c.db
      .prepare(`UPDATE block SET parent_block_id = ?, type = ?, content_json = ?, position = ?, version = version + ?, actor = ?, updated_at = ? WHERE id = ?`)
      // Moving a block is not writing it: only a content change takes authorship.
      .bind(node.parent_block_id, node.type, json, node.position, contentChanged ? 1 : 0, contentChanged ? c.actor : prev.actor, t, node.id));
  }
  if (writes.length) await c.db.batch(writes);

  const incoming = new Set(tree.map((n) => n.id));
  const gone = existing.filter((b) => !incoming.has(b.id)).map((b) => b.id);
  await deleteBlocks(c, gone);

  await c.db.prepare(`UPDATE note SET updated_at = ? WHERE id = ?`).bind(t, noteId).run();
  await reindexNote(c, noteId);
  await logEvent(c, "update", "note", noteId, { blocks: tree.length, removed: gone.length });
  return getBlocks(c, noteId);
}
