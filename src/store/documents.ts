// Documents: living, block-editable artifacts.
//
// The write model: HUMANS (web app / REST) apply block ops directly via
// `writeBlocks`. AGENTS never touch blocks — they call `proposePatch`, which the
// human accepts or rejects. `applyPatch` runs the same op engine as a direct
// write, but only after acceptance. Prior block content is kept in
// block_revision so any change is reversible.
import { z } from "zod";
import { createDocumentInput, type BlockOp } from "../schema";
import { Ctx, RuleError, all, first, ftsUpsert, id, logEvent, now } from "./db";

export interface Document {
  id: string;
  workspace_id: string;
  title: string;
  type: string;
  status: string;
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

// ---- the op engine (shared by human writes and accepted patches) ------------

async function positionAfter(c: Ctx, documentId: string, afterId: string | null | undefined): Promise<number> {
  const blocks = await getBlocks(c, documentId);
  if (!afterId) return (blocks[0]?.position ?? 1) - 1; // prepend
  const idx = blocks.findIndex((b) => b.id === afterId);
  if (idx === -1) return (blocks[blocks.length - 1]?.position ?? 0) + 1; // append
  const next = blocks[idx + 1];
  return next ? (blocks[idx].position + next.position) / 2 : blocks[idx].position + 1;
}

async function applyOps(c: Ctx, documentId: string, ops: BlockOp[]): Promise<void> {
  const isAi = c.actor.startsWith("ai:") ? 1 : 0;
  const t = now();
  for (const op of ops) {
    if (op.op === "insert") {
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
    const text = blocks.map((b) => { try { return JSON.parse(b.content_json).text ?? ""; } catch { return ""; } }).join("\n");
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

// ---- patches (the ONLY way an agent changes a document) ---------------------

export async function proposePatch(c: Ctx, documentId: string, ops: BlockOp[], summary: string): Promise<DocumentPatch> {
  const doc = await getDocument(c, documentId);
  if (!doc) throw new RuleError(`document ${documentId} not found`, 404);
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
