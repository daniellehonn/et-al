// Blocks: the body of a page.
//
// The write model is unchanged from v7 and is deliberately the one thing this
// rewrite did not liberalise: HUMANS (web app / REST) apply block ops directly
// via `writeBlocks`; AGENTS never touch blocks — they call `proposePagePatch`,
// which the human accepts or rejects. That gate is the product.
//
// What is new is nesting. v7 blocks were a flat list, which is most of why its
// documents felt shallower than Notion's: a toggle could not contain anything
// and a bullet could not have sub-bullets. Blocks now carry parent_block_id.
import { z } from "zod";
import { blockOp, type BlockOp } from "../schema";
import { Ctx, RuleError, all, first, ftsUpsert, id, logEvent, now } from "./db";
import { getPage } from "./pages";

export interface Block {
  id: string;
  page_id: string;
  parent_block_id: string | null;
  type: string;
  content_json: string;
  position: number;
  version: number;
  is_ai: number;
  created_at: number;
  updated_at: number;
}

export interface PagePatch {
  id: string;
  page_id: string;
  ops_json: string;
  summary: string;
  status: string;
  actor: string;
  created_at: number;
  resolved_at: number | null;
}

/** A page's blocks, flat but ordered depth-first so a client can render them in
 *  document order without building the tree first. */
export async function getBlocks(c: Ctx, pageId: string): Promise<Block[]> {
  const rows = await all<Block>(c, `SELECT * FROM block WHERE page_id = ? ORDER BY position`, pageId);
  const byParent = new Map<string | null, Block[]>();
  for (const b of rows) {
    const k = b.parent_block_id;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(b);
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
  // Anything orphaned by a missing parent still has to appear, or edits could
  // make content silently invisible rather than merely misplaced.
  for (const b of rows) if (!seen.has(b.id)) out.push(b);
  return out;
}

export function getBlock(c: Ctx, bid: string): Promise<Block | null> {
  return first<Block>(c, `SELECT * FROM block WHERE id = ?`, bid);
}

// ---- the op engine (shared by human writes and accepted patches) ------------

async function positionAfter(c: Ctx, pageId: string, parent: string | null, afterId: string | null | undefined): Promise<number> {
  const siblings = parent === null
    ? await all<Block>(c, `SELECT * FROM block WHERE page_id = ? AND parent_block_id IS NULL ORDER BY position`, pageId)
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
async function insertParsed(c: Ctx, pageId: string, parsed: ParsedBlock[], isAi: number, t: number): Promise<void> {
  // stack[d] is the id of the most recent block at depth d — the parent for d+1.
  const stack: string[] = [];
  let pos = 1;
  for (const b of parsed) {
    const depth = Math.min(b.depth, stack.length); // never skip a level
    const parent = depth > 0 ? stack[depth - 1] : null;
    const bid = id("blk");
    await c.db
      .prepare(
        `INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, version, is_ai, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(bid, pageId, parent, b.type, JSON.stringify(b.content), pos++, isAi, t, t)
      .run();
    stack[depth] = bid;
    stack.length = depth + 1;
  }
}

/** Descendants of a block, so deleting a toggle takes its contents with it. */
async function blockSubtree(c: Ctx, bid: string): Promise<string[]> {
  const out = [bid];
  const seen = new Set([bid]);
  for (let i = 0; i < out.length; i++) {
    const kids = await all<{ id: string }>(c, `SELECT id FROM block WHERE parent_block_id = ?`, out[i]);
    for (const k of kids) if (!seen.has(k.id)) { seen.add(k.id); out.push(k.id); }
  }
  return out;
}

async function applyOps(c: Ctx, pageId: string, ops: BlockOp[]): Promise<void> {
  const isAi = c.actor.startsWith("ai:") ? 1 : 0;
  const t = now();
  for (const op of ops) {
    if (op.op === "replace_content") {
      // Wipe the body and rebuild from markdown. Collection blocks are spared:
      // they are placements of a real collection, and dropping one would strip a
      // database off the page as a side effect of rewriting its prose.
      await c.db.prepare(`DELETE FROM block_revision WHERE block_id IN (SELECT id FROM block WHERE page_id = ? AND type <> 'collection')`).bind(pageId).run();
      await c.db.prepare(`DELETE FROM block WHERE page_id = ? AND type <> 'collection'`).bind(pageId).run();
      await insertParsed(c, pageId, markdownToBlocks(op.content), isAi, t);
    } else if (op.op === "insert") {
      const parent = op.parent ?? null;
      const pos = await positionAfter(c, pageId, parent, op.after);
      await c.db
        .prepare(`INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, version, is_ai, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .bind(id("blk"), pageId, parent, op.type, JSON.stringify(op.content), pos, isAi, t, t)
        .run();
    } else if (op.op === "update") {
      const existing = await getBlock(c, op.id);
      if (!existing) continue;
      await c.db
        .prepare(`INSERT INTO block_revision (id, block_id, content_json, version, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id("brev"), existing.id, existing.content_json, existing.version, c.actor, t)
        .run();
      await c.db
        .prepare(`UPDATE block SET type = ?, content_json = ?, version = version + 1, is_ai = ?, updated_at = ? WHERE id = ?`)
        .bind(op.type ?? existing.type, JSON.stringify(op.content), isAi, t, op.id)
        .run();
    } else if (op.op === "delete") {
      const ids = await blockSubtree(c, op.id);
      const marks = ids.map(() => "?").join(",");
      await c.db.prepare(`DELETE FROM block_revision WHERE block_id IN (${marks})`).bind(...ids).run();
      // Children first: block.parent_block_id is a self-referencing foreign key.
      for (const bid of ids.slice(1).reverse()) await c.db.prepare(`DELETE FROM block WHERE id = ?`).bind(bid).run();
      await c.db.prepare(`DELETE FROM block WHERE id = ?`).bind(op.id).run();
    } else if (op.op === "move") {
      const parent = op.parent ?? null;
      // Moving a block under its own descendant would detach the subtree.
      if (parent && (await blockSubtree(c, op.id)).includes(parent)) continue;
      const pos = await positionAfter(c, pageId, parent, op.after);
      await c.db.prepare(`UPDATE block SET parent_block_id = ?, position = ?, updated_at = ? WHERE id = ?`).bind(parent, pos, t, op.id).run();
    }
  }
  await c.db.prepare(`UPDATE page SET updated_at = ? WHERE id = ?`).bind(t, pageId).run();
  const page = await getPage(c, pageId);
  if (page) {
    const blocks = await getBlocks(c, pageId);
    const text = blocks.map((b) => {
      try {
        const parsed = JSON.parse(b.content_json);
        if (Array.isArray(parsed.columns)) return [parsed.columns, ...(parsed.rows ?? [])].flat().join(" ");
        return parsed.text ?? "";
      } catch { return ""; }
    }).join("\n");
    await ftsUpsert(c, "page", pageId, page.title, text);
  }
}

/** Direct block write — for the HUMAN web app / REST only, never exposed to MCP. */
export async function writeBlocks(c: Ctx, pageId: string, ops: BlockOp[]): Promise<Block[]> {
  const page = await getPage(c, pageId);
  if (!page) throw new RuleError(`page ${pageId} not found`, 404);
  await applyOps(c, pageId, ops);
  await logEvent(c, "update", "page", pageId, { blocks: ops.length });
  return getBlocks(c, pageId);
}

/** Every career block across all pages — the raw material an agent recycles into
 *  a resume. Still a block-level concept: career capital is written in prose, in
 *  place, as you work, not filed into a separate collection. */
export interface CareerBlock {
  id: string; page_id: string; type: string; content_json: string;
  created_at: number; page_title: string;
}

export function listCareerBlocks(c: Ctx, pageId?: string): Promise<CareerBlock[]> {
  const base = `SELECT b.id, b.page_id, b.type, b.content_json, b.created_at, p.title AS page_title
                FROM block b JOIN page p ON b.page_id = p.id
                WHERE b.type IN ('accomplishment', 'resume_bullet', 'role', 'project')`;
  return pageId
    ? all<CareerBlock>(c, `${base} AND b.page_id = ? ORDER BY b.created_at DESC`, pageId)
    : all<CareerBlock>(c, `${base} ORDER BY b.created_at DESC`);
}

// ---- patches (the ONLY way an agent changes a page body) --------------------

export async function proposePagePatch(c: Ctx, pageId: string, ops: BlockOp[], summary: string): Promise<PagePatch> {
  const page = await getPage(c, pageId);
  if (!page) throw new RuleError(`page ${pageId} not found`, 404);
  // Validate up front so a malformed patch is rejected here, not silently
  // ignored on accept.
  const parsed = z.array(blockOp).safeParse(ops);
  if (!parsed.success) {
    throw new RuleError(`invalid page ops — supported ops are insert, update, delete, move, replace_content. ${parsed.error.issues[0]?.message ?? ""}`, 400);
  }
  const pid = id("pat");
  await c.db
    .prepare(`INSERT INTO page_patch (id, page_id, ops_json, summary, status, actor, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(pid, pageId, JSON.stringify(parsed.data), summary, c.actor, now())
    .run();
  await logEvent(c, "patch_proposed", "page", pageId, { patch_id: pid, summary });
  return (await getPatch(c, pid))!;
}

export function getPatch(c: Ctx, pid: string): Promise<PagePatch | null> {
  return first<PagePatch>(c, `SELECT * FROM page_patch WHERE id = ?`, pid);
}

export function listPatches(c: Ctx, pageId: string, status?: string): Promise<PagePatch[]> {
  return status
    ? all<PagePatch>(c, `SELECT * FROM page_patch WHERE page_id = ? AND status = ? ORDER BY created_at DESC`, pageId, status)
    : all<PagePatch>(c, `SELECT * FROM page_patch WHERE page_id = ? ORDER BY created_at DESC`, pageId);
}

/** Every pending patch across the workspace — the review queue. */
export function listPendingPatches(c: Ctx): Promise<(PagePatch & { page_title: string })[]> {
  return all<PagePatch & { page_title: string }>(
    c,
    `SELECT pp.*, p.title AS page_title FROM page_patch pp JOIN page p ON pp.page_id = p.id
     WHERE pp.status = 'pending' ORDER BY pp.created_at DESC`,
  );
}

/** Human decision. Accepting runs the ops; rejecting just marks it. */
export async function resolvePatch(c: Ctx, pid: string, accept: boolean): Promise<PagePatch> {
  const patch = await getPatch(c, pid);
  if (!patch) throw new RuleError(`patch ${pid} not found`, 404);
  if (patch.status !== "pending") throw new RuleError(`patch ${pid} is already ${patch.status}`);
  if (accept) await applyOps(c, patch.page_id, JSON.parse(patch.ops_json) as BlockOp[]);
  await c.db
    .prepare(`UPDATE page_patch SET status = ?, resolved_at = ? WHERE id = ?`)
    .bind(accept ? "accepted" : "rejected", now(), pid)
    .run();
  await logEvent(c, accept ? "patch_accepted" : "patch_rejected", "page", patch.page_id, { patch_id: pid });
  return (await getPatch(c, pid))!;
}
