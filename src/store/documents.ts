// Documents and ordered blocks — the writing surface.
//
// Split from typed metadata on purpose (spec §2.12): a project's status, dates,
// and relations are columns; its prose is blocks. Blocks are rows rather than
// one JSON blob so they can be queried and converted — a `learning` block can
// become a Knowledge Note, a `content-seed` block can become a Content Item,
// without re-parsing a document.
//
// The block vocabulary is ported from the v5 editor in src/ui.ts (Decision G),
// extended with the product-specific types in schema.ts BLOCK_TYPE.

import { asc, eq } from "drizzle-orm";
import { documents, documentBlocks, type BlockType, type SubjectType, BLOCK_TYPE } from "../schema.ts";
import {
  type Env, getDb, now, newId, requireEnum, boolInt, NotFoundError, indexFts,
} from "./db.ts";

export interface BlockInput {
  id?: string;
  type?: string;
  text?: string;
  data?: Record<string, unknown>;
  is_ai?: boolean;
}

export interface BlockDoc {
  id: string;
  type: BlockType;
  text: string;
  data: Record<string, unknown>;
  is_ai: boolean;
}

export interface DocumentDoc {
  id: string;
  owner_type: SubjectType;
  owner_id: string | null;
  blocks: BlockDoc[];
  created_at: number;
  updated_at: number;
}

function parseData(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** Flattened text of a document, used for FTS and list excerpts. */
export function flattenBlocks(blocks: Array<{ text: string }>): string {
  return blocks.map((b) => b.text).filter(Boolean).join("\n");
}

export async function createDocument(
  env: Env, userId: string, ownerType: SubjectType, ownerId: string | null, blocks: BlockInput[] = [],
): Promise<DocumentDoc> {
  const db = getDb(env);
  const ts = now();
  const id = newId();
  await db.insert(documents).values({
    id, userId, ownerType, ownerId, createdAt: ts, updatedAt: ts,
  });
  if (blocks.length) await replaceBlocks(env, id, blocks);
  return (await getDocument(env, id))!;
}

export async function getDocument(env: Env, id: string): Promise<DocumentDoc | null> {
  const db = getDb(env);
  const rows = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  const doc = rows[0];
  if (!doc) return null;
  const blockRows = await db.select().from(documentBlocks)
    .where(eq(documentBlocks.documentId, id)).orderBy(asc(documentBlocks.position));
  return {
    id: doc.id,
    owner_type: doc.ownerType,
    owner_id: doc.ownerId,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
    blocks: blockRows.map((b) => ({
      id: b.id, type: b.type, text: b.text, data: parseData(b.data), is_ai: !!b.isAi,
    })),
  };
}

/**
 * Replaces a document's blocks wholesale. Position is dense and rewritten on
 * every save, which keeps ordering trivial — documents are small enough that a
 * full rewrite beats maintaining sparse fractional indices.
 *
 * Atomic: the delete and all inserts go in one D1 batch, so a document is never
 * left half-written.
 */
export async function replaceBlocks(env: Env, documentId: string, blocks: BlockInput[]): Promise<void> {
  const ts = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM document_blocks WHERE document_id = ?").bind(documentId),
  ];
  blocks.forEach((block, position) => {
    const type = requireEnum(block.type ?? "paragraph", BLOCK_TYPE, "block.type");
    statements.push(
      env.DB.prepare(
        `INSERT INTO document_blocks (id, document_id, position, type, text, data, is_ai, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        block.id ?? newId(), documentId, position, type,
        String(block.text ?? ""), JSON.stringify(block.data ?? {}),
        boolInt(block.is_ai), ts, ts,
      ),
    );
  });
  statements.push(
    env.DB.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").bind(ts, documentId),
  );
  await env.DB.batch(statements);
}

/**
 * Saves blocks and refreshes the owner's FTS row in one call — every caller that
 * edits a body needs both, and forgetting the second silently breaks search.
 */
export async function saveBody(
  env: Env, documentId: string, blocks: BlockInput[], subjectType: SubjectType, subjectId: string, title: string,
): Promise<void> {
  await replaceBlocks(env, documentId, blocks);
  await indexFts(env, subjectType, subjectId, title, flattenBlocks(blocks.map((b) => ({ text: String(b.text ?? "") }))));
}

export async function deleteDocument(env: Env, id: string): Promise<void> {
  // document_blocks cascade via FK.
  await getDb(env).delete(documents).where(eq(documents.id, id));
}

/** Ensures a record has a body document, creating one on first write. */
export async function ensureDocument(
  env: Env, userId: string, existingId: string | null, ownerType: SubjectType, ownerId: string,
): Promise<string> {
  if (existingId) {
    const found = await getDocument(env, existingId);
    if (found) return existingId;
  }
  const created = await createDocument(env, userId, ownerType, ownerId);
  return created.id;
}

export async function requireDocument(env: Env, id: string): Promise<DocumentDoc> {
  const doc = await getDocument(env, id);
  if (!doc) throw new NotFoundError(`Document not found: ${id}`);
  return doc;
}
