// Semantic search support.
//
// Decision F says no AI *agent* inside the platform — the intelligence is Claude,
// reached over MCP. An embedding model is a different thing: it is search
// infrastructure, closer to an FTS tokenizer than to an agent. It runs on
// Workers AI (a Cloudflare binding), so no external provider or API key enters
// the platform.
//
// Everything here degrades gracefully. If the AI or VECTORIZE bindings are
// absent, embedding is skipped and search silently falls back to keyword-only —
// which is exactly how it behaved before. Semantic relevance is an enhancement,
// never a dependency.

import { eq, and } from "drizzle-orm";
import { embeddings } from "../schema.ts";
import { type Env, getDb, now, newId } from "./db.ts";
import type { SubjectType } from "../schema.ts";

/** 768-dimension model; the index must be created with matching dimensions. */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;

export function semanticAvailable(env: Env): boolean {
  return Boolean(env.AI && env.VECTORIZE);
}

/** Cheap change-detection so unchanged content is not re-embedded. */
async function hashContent(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function embedText(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    const result = (await env.AI.run(EMBEDDING_MODEL, { text: [text.slice(0, 4000)] })) as {
      data?: number[][];
    };
    return result?.data?.[0] ?? null;
  } catch {
    return null; // never let an embedding failure break a write
  }
}

/**
 * Upserts one object's vector. Idempotent by content hash: calling it repeatedly
 * with unchanged text does no work, which matters because it is called on every
 * save.
 */
export async function indexEmbedding(
  env: Env, userId: string, subjectType: SubjectType, subjectId: string, title: string, body: string,
): Promise<{ indexed: boolean; reason?: string }> {
  if (!semanticAvailable(env)) return { indexed: false, reason: "bindings absent" };

  const text = `${title}\n\n${body}`.trim();
  if (!text) return { indexed: false, reason: "empty" };

  const hash = await hashContent(text);
  const db = getDb(env);
  const existing = await db.select().from(embeddings)
    .where(and(eq(embeddings.subjectType, subjectType), eq(embeddings.subjectId, subjectId)))
    .limit(1);
  if (existing[0]?.contentHash === hash) return { indexed: false, reason: "unchanged" };

  const vector = await embedText(env, text);
  if (!vector) return { indexed: false, reason: "embedding failed" };

  const vectorId = existing[0]?.vectorId ?? newId();
  await env.VECTORIZE!.upsert([{
    id: vectorId,
    values: vector,
    metadata: { user_id: userId, subject_type: subjectType, subject_id: subjectId, title },
  }]);

  if (existing[0]) {
    await db.update(embeddings).set({ contentHash: hash, model: EMBEDDING_MODEL })
      .where(eq(embeddings.id, existing[0].id));
  } else {
    await db.insert(embeddings).values({
      id: newId(), userId, subjectType, subjectId, vectorId,
      model: EMBEDDING_MODEL, contentHash: hash, createdAt: now(),
    });
  }
  return { indexed: true };
}

export interface SemanticHit {
  subject_id: string;
  subject_type: string;
  title: string;
  score: number;
}

/** Nearest neighbours, filtered to this user before ranking (spec §6.5). */
export async function semanticSearch(
  env: Env, userId: string, query: string, limit = 20,
): Promise<SemanticHit[]> {
  if (!semanticAvailable(env)) return [];
  const vector = await embedText(env, query);
  if (!vector) return [];
  try {
    const result = await env.VECTORIZE!.query(vector, {
      topK: Math.min(limit, 50),
      filter: { user_id: userId },
      returnMetadata: "all",
    });
    return (result.matches ?? []).map((m) => ({
      subject_id: String(m.metadata?.subject_id ?? ""),
      subject_type: String(m.metadata?.subject_type ?? ""),
      title: String(m.metadata?.title ?? ""),
      score: m.score,
    })).filter((h) => h.subject_id);
  } catch {
    return [];
  }
}

export async function removeEmbedding(
  env: Env, subjectType: SubjectType, subjectId: string,
): Promise<void> {
  const db = getDb(env);
  const rows = await db.select().from(embeddings)
    .where(and(eq(embeddings.subjectType, subjectType), eq(embeddings.subjectId, subjectId)))
    .limit(1);
  if (!rows[0]) return;
  if (env.VECTORIZE) {
    try { await env.VECTORIZE.deleteByIds([rows[0].vectorId]); } catch { /* best effort */ }
  }
  await db.delete(embeddings).where(eq(embeddings.id, rows[0].id));
}
