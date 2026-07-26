// Documents: living, block-editable artifacts.
//
// The write model: HUMANS (web app / REST) apply block ops directly via
// `writeBlocks`. AGENTS never touch blocks — they call `proposePatch`, which the
// human accepts or rejects. `applyPatch` runs the same op engine as a direct
// write, but only after acceptance. Prior block content is kept in
// block_revision so any change is reversible.
import { z } from "zod";
import { blockOp, createDocumentInput, type BlockOp } from "../schema";
import { Ctx, RuleError, all, first, ftsDelete, ftsUpsert, id, logEvent, now } from "./db";

export interface Document {
  id: string;
  workspace_id: string;
  title: string;
  type: string;
  status: string;
  icon: string | null;
  cover: string | null;
  created_at: number;
  updated_at: number;
}

export interface Block {
  id: string;
  document_id: string;
  type: string;
  content_json: string;
  position: number;
  version: number;
  is_ai: number;
  created_at: number;
  updated_at: number;
}

export interface DocumentPatch {
  id: string;
  document_id: string;
  ops_json: string;
  summary: string;
  status: string;
  actor: string;
  created_at: number;
  resolved_at: number | null;
}

export function getDocument(c: Ctx, did: string): Promise<Document | null> {
  return first<Document>(c, `SELECT * FROM document WHERE id = ?`, did);
}

export function listDocuments(c: Ctx, workspaceId: string): Promise<Document[]> {
  return all<Document>(c, `SELECT * FROM document WHERE workspace_id = ? ORDER BY updated_at DESC`, workspaceId);
}

export function getBlocks(c: Ctx, documentId: string): Promise<Block[]> {
  return all<Block>(c, `SELECT * FROM block WHERE document_id = ? ORDER BY position`, documentId);
}

export async function createDocument(c: Ctx, input: z.infer<typeof createDocumentInput>): Promise<Document> {
  const data = createDocumentInput.parse(input);
  const did = id("doc");
  const t = now();
  await c.db
    .prepare(`INSERT INTO document (id, workspace_id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)`)
    .bind(did, data.workspace_id, data.title, data.type, t, t)
    .run();
  await ftsUpsert(c, "document", did, data.title, "");
  await logEvent(c, "create", "document", did, { title: data.title });
  return (await getDocument(c, did))!;
}

export async function updateDocument(c: Ctx, did: string, patch: { title?: string; status?: string; icon?: string | null; cover?: string | null }): Promise<Document> {
  const existing = await getDocument(c, did);
  if (!existing) throw new RuleError(`document ${did} not found`, 404);
  await c.db
    .prepare(`UPDATE document SET title = ?, status = ?, icon = ?, cover = ?, updated_at = ? WHERE id = ?`)
    .bind(patch.title ?? existing.title, patch.status ?? existing.status,
      patch.icon === undefined ? existing.icon : patch.icon,
      patch.cover === undefined ? existing.cover : patch.cover, now(), did)
    .run();
  await ftsUpsert(c, "document", did, patch.title ?? existing.title, "");
  await logEvent(c, "update", "document", did, patch);
  return (await getDocument(c, did))!;
}

export async function deleteDocument(c: Ctx, did: string): Promise<void> {
  const existing = await getDocument(c, did);
  if (!existing) throw new RuleError(`document ${did} not found`, 404);
  await c.db.prepare(`DELETE FROM block_revision WHERE block_id IN (SELECT id FROM block WHERE document_id = ?)`).bind(did).run();
  await c.db.prepare(`DELETE FROM block WHERE document_id = ?`).bind(did).run();
  await c.db.prepare(`DELETE FROM document_patch WHERE document_id = ?`).bind(did).run();
  await c.db.prepare(`DELETE FROM document WHERE id = ?`).bind(did).run();
  await ftsDelete(c, "document", did);
  await logEvent(c, "delete", "document", did, { title: existing.title });
}

// ---- the op engine (shared by human writes and accepted patches) ------------

async function positionAfter(c: Ctx, documentId: string, afterId: string | null | undefined): Promise<number> {
  const blocks = await getBlocks(c, documentId);
  if (!afterId) return (blocks[0]?.position ?? 1) - 1; // prepend
  const idx = blocks.findIndex((b) => b.id === afterId);
  if (idx === -1) return (blocks[blocks.length - 1]?.position ?? 0) + 1; // append
  const next = blocks[idx + 1];
  return next ? (blocks[idx].position + next.position) / 2 : blocks[idx].position + 1;
}

// Parse markdown (or plain text) into blocks — enough for what agents write:
// headings, bullets, numbered items, todos, quotes, fenced code, dividers, and
// pipe tables. Each block carries its structured content object.
type ParsedBlock = { type: string; content: Record<string, unknown> };
const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
const isTableSep = (line: string): boolean => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);

function markdownToBlocks(md: string): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let code: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      if (inCode) { out.push({ type: "code", content: { text: code.join("\n") } }); code = []; inCode = false; }
      else inCode = true;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const s = line.trim();
    if (s === "") continue;

    // A table: header row of pipes, then a |---|---| separator, then rows.
    if (s.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const columns = cells(s);
      const rows: string[][] = [];
      i += 2; // skip header + separator
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(cells(lines[i]));
        i++;
      }
      i--; // the for-loop will i++ past the last consumed row
      out.push({ type: "table", content: { columns, rows } });
      continue;
    }

    if (/^#{1,6}\s+/.test(s)) out.push({ type: "heading", content: { text: s.replace(/^#{1,6}\s+/, "") } });
    else if (/^(-|\*|\+)\s+\[[ xX]\]\s+/.test(s)) out.push({ type: "todo", content: { text: s.replace(/^(-|\*|\+)\s+\[[ xX]\]\s+/, "") } });
    else if (/^(-|\*|\+)\s+/.test(s)) out.push({ type: "bullet", content: { text: s.replace(/^(-|\*|\+)\s+/, "") } });
    else if (/^\d+\.\s+/.test(s)) out.push({ type: "numbered", content: { text: s.replace(/^\d+\.\s+/, "") } });
    else if (/^>\s?/.test(s)) out.push({ type: "quote", content: { text: s.replace(/^>\s?/, "") } });
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) out.push({ type: "divider", content: { text: "" } });
    else out.push({ type: "paragraph", content: { text: s } });
  }
  if (inCode && code.length) out.push({ type: "code", content: { text: code.join("\n") } });
  return out;
}

async function applyOps(c: Ctx, documentId: string, ops: BlockOp[]): Promise<void> {
  const isAi = c.actor.startsWith("ai:") ? 1 : 0;
  const t = now();
  for (const op of ops) {
    if (op.op === "replace_content") {
      // Wipe the body and rebuild it from the markdown string.
      await c.db.prepare(`DELETE FROM block_revision WHERE block_id IN (SELECT id FROM block WHERE document_id = ?)`).bind(documentId).run();
      await c.db.prepare(`DELETE FROM block WHERE document_id = ?`).bind(documentId).run();
      let pos = 1;
      for (const b of markdownToBlocks(op.content)) {
        await c.db
          .prepare(`INSERT INTO block (id, document_id, type, content_json, position, version, is_ai, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
          .bind(id("blk"), documentId, b.type, JSON.stringify(b.content), pos++, isAi, t, t)
          .run();
      }
    } else if (op.op === "insert") {
      const pos = await positionAfter(c, documentId, op.after);
      await c.db
        .prepare(`INSERT INTO block (id, document_id, type, content_json, position, version, is_ai, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .bind(id("blk"), documentId, op.type, JSON.stringify(op.content), pos, isAi, t, t)
        .run();
    } else if (op.op === "update") {
      const existing = await first<Block>(c, `SELECT * FROM block WHERE id = ?`, op.id);
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
      await c.db.prepare(`DELETE FROM block WHERE id = ?`).bind(op.id).run();
    } else if (op.op === "move") {
      const pos = await positionAfter(c, documentId, op.after);
      await c.db.prepare(`UPDATE block SET position = ?, updated_at = ? WHERE id = ?`).bind(pos, t, op.id).run();
    }
  }
  await c.db.prepare(`UPDATE document SET updated_at = ? WHERE id = ?`).bind(t, documentId).run();
  const doc = await getDocument(c, documentId);
  if (doc) {
    const blocks = await getBlocks(c, documentId);
    const text = blocks.map((b) => {
      try {
        const c = JSON.parse(b.content_json);
        if (Array.isArray(c.columns)) return [c.columns, ...(c.rows ?? [])].flat().join(" ");
        return c.text ?? "";
      } catch { return ""; }
    }).join("\n");
    await ftsUpsert(c, "document", documentId, doc.title, text);
  }
}

/** Direct block write — for the HUMAN web app / REST only, never exposed to MCP. */
export async function writeBlocks(c: Ctx, documentId: string, ops: BlockOp[]): Promise<Block[]> {
  const doc = await getDocument(c, documentId);
  if (!doc) throw new RuleError(`document ${documentId} not found`, 404);
  await applyOps(c, documentId, ops);
  await logEvent(c, "update", "document", documentId, { blocks: ops.length });
  return getBlocks(c, documentId);
}

// Repair older documents: merge runs of paragraph blocks that form a markdown
// table (header, |---| separator, rows) into a single table block. Only touches
// table runs; every other block is preserved as-is.
export async function reparseDocumentTables(c: Ctx, documentId: string): Promise<{ changed: boolean; tables: number }> {
  const doc = await getDocument(c, documentId);
  if (!doc) throw new RuleError(`document ${documentId} not found`, 404);
  const blocks = await getBlocks(c, documentId);
  const textOf = (b: Block) => { try { return String(JSON.parse(b.content_json).text ?? ""); } catch { return ""; } };

  const seq: Array<{ type: string; content: Record<string, unknown> }> = [];
  let tables = 0, i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    const t = textOf(b).trim();
    if (b.type === "paragraph" && t.startsWith("|") && i + 1 < blocks.length && isTableSep(textOf(blocks[i + 1]))) {
      const columns = cells(t);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < blocks.length && blocks[j].type === "paragraph" && textOf(blocks[j]).trim().startsWith("|")) {
        rows.push(cells(textOf(blocks[j]))); j++;
      }
      seq.push({ type: "table", content: { columns, rows } });
      tables++; i = j;
    } else {
      seq.push({ type: b.type, content: (() => { try { return JSON.parse(b.content_json); } catch { return { text: "" }; } })() });
      i++;
    }
  }
  if (tables === 0) return { changed: false, tables: 0 };

  const t = now();
  await c.db.prepare(`DELETE FROM block_revision WHERE block_id IN (SELECT id FROM block WHERE document_id = ?)`).bind(documentId).run();
  await c.db.prepare(`DELETE FROM block WHERE document_id = ?`).bind(documentId).run();
  let pos = 1;
  for (const b of seq) {
    await c.db
      .prepare(`INSERT INTO block (id, document_id, type, content_json, position, version, is_ai, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`)
      .bind(id("blk"), documentId, b.type, JSON.stringify(b.content), pos++, t, t)
      .run();
  }
  await c.db.prepare(`UPDATE document SET updated_at = ? WHERE id = ?`).bind(t, documentId).run();
  await logEvent(c, "update", "document", documentId, { reparsed_tables: tables });
  return { changed: true, tables };
}

// ---- patches (the ONLY way an agent changes a document) ---------------------

export async function proposePatch(c: Ctx, documentId: string, ops: BlockOp[], summary: string): Promise<DocumentPatch> {
  const doc = await getDocument(c, documentId);
  if (!doc) throw new RuleError(`document ${documentId} not found`, 404);
  // Validate up front so a malformed patch is rejected here, not silently
  // ignored on accept. Supported ops: insert/update/delete/move/replace_content.
  const parsed = z.array(blockOp).safeParse(ops);
  if (!parsed.success) {
    throw new RuleError(`invalid document ops — supported ops are insert, update, delete, move, replace_content. ${parsed.error.issues[0]?.message ?? ""}`, 400);
  }
  ops = parsed.data;
  const pid = id("pat");
  await c.db
    .prepare(`INSERT INTO document_patch (id, document_id, ops_json, summary, status, actor, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(pid, documentId, JSON.stringify(ops), summary, c.actor, now())
    .run();
  await logEvent(c, "patch_proposed", "document", documentId, { patch_id: pid, summary });
  return (await getPatch(c, pid))!;
}

export function getPatch(c: Ctx, pid: string): Promise<DocumentPatch | null> {
  return first<DocumentPatch>(c, `SELECT * FROM document_patch WHERE id = ?`, pid);
}

export function listPatches(c: Ctx, documentId: string, status?: string): Promise<DocumentPatch[]> {
  if (status) {
    return all<DocumentPatch>(c, `SELECT * FROM document_patch WHERE document_id = ? AND status = ? ORDER BY created_at DESC`, documentId, status);
  }
  return all<DocumentPatch>(c, `SELECT * FROM document_patch WHERE document_id = ? ORDER BY created_at DESC`, documentId);
}

/** Human decision. Accepting runs the ops; rejecting just marks it. */
export async function resolvePatch(c: Ctx, pid: string, accept: boolean): Promise<DocumentPatch> {
  const patch = await getPatch(c, pid);
  if (!patch) throw new RuleError(`patch ${pid} not found`, 404);
  if (patch.status !== "pending") throw new RuleError(`patch ${pid} is already ${patch.status}`);
  if (accept) {
    const ops = JSON.parse(patch.ops_json) as BlockOp[];
    await applyOps(c, patch.document_id, ops);
  }
  await c.db
    .prepare(`UPDATE document_patch SET status = ?, resolved_at = ? WHERE id = ?`)
    .bind(accept ? "accepted" : "rejected", now(), pid)
    .run();
  await logEvent(c, accept ? "patch_accepted" : "patch_rejected", "document", patch.document_id, { patch_id: pid });
  return (await getPatch(c, pid))!;
}
