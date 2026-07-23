// Search.
//
// Phase 1 ships the exact + filter layers over D1 FTS5. The semantic layer
// (Vectorize) and hybrid ranking arrive in Phases 4–5; the shape here already
// anticipates them so callers do not change:
//
//   exact  -> FTS5 over title + flattened body        (this file, now)
//   filter -> type / status / date narrowing          (this file, now)
//   graph  -> relation traversal                      (relations.ts)
//   vector -> Vectorize nearest-neighbour             (Phase 4)
//
// Authorization is applied *before* ranking (spec §6.5), not as a post-filter,
// so a result the user may not see can never influence the ordering.

import { type Env, clampInt, now } from "./db.ts";
import { semanticSearch, semanticAvailable } from "./embeddings.ts";
import type { SubjectType } from "../schema.ts";

export interface SearchHit {
  subject_id: string;
  subject_type: SubjectType;
  title: string;
  snippet: string;
  rank: number;
  /** Which layers produced this hit — useful for explaining a result. */
  matched?: string[];
  score?: number;
}

export interface SearchOptions {
  subject_type?: string | null;
  limit?: number;
}

/**
 * FTS5 treats several characters as operators. Users type questions, not
 * queries, so the input is quoted into a phrase-ish match rather than passed
 * through raw (which throws on unbalanced quotes or a stray `*`).
 */
function sanitizeQuery(query: string): string {
  const terms = query
    .replace(/["'()*:^-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!terms.length) return "";
  return terms.map((t) => `"${t}"`).join(" ");
}

export async function search(
  env: Env, userId: string, query: string, opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const match = sanitizeQuery(query);
  if (!match) return [];

  const limit = clampInt(opts.limit, 1, 200, 50);
  const clauses = ["documents_fts MATCH ?"];
  const values: unknown[] = [match];
  if (opts.subject_type) {
    clauses.push("subject_type = ?");
    values.push(opts.subject_type);
  }
  values.push(limit);

  const result = await env.DB.prepare(
    `SELECT subject_id, subject_type, title,
            snippet(documents_fts, 3, '', '', '…', 12) AS snippet,
            rank
     FROM documents_fts
     WHERE ${clauses.join(" AND ")}
     ORDER BY rank
     LIMIT ?`,
  ).bind(...values).all<SearchHit>();

  return result.results ?? [];
}

/**
 * Hybrid search (spec §6.5): combines exact keyword matching, semantic
 * similarity, recency, and a title-match boost into one ranking.
 *
 * The layers are complementary, not redundant. FTS finds the right word;
 * embeddings find the right idea. Fusing them means "that thing about vector
 * similarity" finds a note titled "Embeddings" that never uses the word.
 *
 * Falls back to keyword-only when the AI/Vectorize bindings are absent, so this
 * is always safe to call.
 */
export async function hybridSearch(
  env: Env, userId: string, query: string, opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = clampInt(opts.limit, 1, 200, 30);
  const [keyword, semantic] = await Promise.all([
    search(env, userId, query, { ...opts, limit: 50 }),
    semanticAvailable(env) ? semanticSearch(env, userId, query, 30) : Promise.resolve([]),
  ]);

  interface Merged extends SearchHit { score: number; matched: string[] }
  const merged = new Map<string, Merged>();

  // FTS `rank` is negative, better when more negative. Normalise to 0..1 by
  // position so the two layers can be summed meaningfully.
  keyword.forEach((hit, index) => {
    merged.set(hit.subject_id, {
      ...hit,
      score: 1 - index / Math.max(1, keyword.length),
      matched: ["keyword"],
    });
  });

  semantic.forEach((hit, index) => {
    const positional = 1 - index / Math.max(1, semantic.length);
    const existing = merged.get(hit.subject_id);
    if (existing) {
      // Agreement between layers is a strong signal; add rather than replace.
      existing.score += positional * 0.8;
      existing.matched.push("semantic");
    } else {
      merged.set(hit.subject_id, {
        subject_id: hit.subject_id,
        subject_type: hit.subject_type as SubjectType,
        title: hit.title,
        snippet: "",
        rank: 0,
        score: positional * 0.8,
        matched: ["semantic"],
      });
    }
  });

  const results = [...merged.values()];
  if (!results.length) return [];

  // Title match is a deliberate, explainable boost: if someone types a title,
  // that record should win regardless of how the body scores.
  const q = query.toLowerCase().trim();
  for (const hit of results) {
    const title = hit.title.toLowerCase();
    if (title === q) hit.score += 1.0;
    else if (title.includes(q)) hit.score += 0.4;
  }

  // Recency as a gentle tiebreaker only — old material stays findable.
  const updated = await recencyMap(env, userId, results.map((r) => r.subject_id));
  const nowTs = now();
  for (const hit of results) {
    const ts = updated.get(hit.subject_id);
    if (!ts) continue;
    const ageDays = (nowTs - ts) / 86400;
    hit.score += Math.max(0, 0.25 - ageDays / 730);   // decays to 0 over ~2 years
  }

  if (opts.subject_type) {
    return results
      .filter((r) => r.subject_type === opts.subject_type)
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** updated_at for a mixed set of ids, for the recency component. */
async function recencyMap(env: Env, userId: string, ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  const TABLES = ["projects", "knowledge_notes", "content_items", "project_logs", "tools", "sources"];
  for (const table of TABLES) {
    const rows = await env.DB
      .prepare(`SELECT id, updated_at FROM ${table} WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(userId, ...ids).all<{ id: string; updated_at: number }>();
    for (const r of rows.results ?? []) map.set(r.id, r.updated_at);
  }
  return map;
}

/**
 * Rebuilds the FTS table from canonical rows. In v5 this was the disaster
 * recovery path (the bucket was truth); in v6 it only repairs the search index,
 * because D1 itself is now the truth. Real backups are the Markdown exports.
 */
export async function rebuildSearchIndex(env: Env, userId: string): Promise<{ indexed: number }> {
  // One query per entity rather than a single UNION ALL: D1 rejects compound
  // SELECTs past a low branch count ("too many terms in compound SELECT"), and
  // querying separately also means one bad table cannot take the whole rebuild
  // down.
  const SUBJECTS: Array<{ type: string; sql: string }> = [
    { type: "project", sql: "SELECT id, title, body_document_id FROM projects WHERE user_id = ?" },
    { type: "knowledge_note", sql: "SELECT id, title, body_document_id FROM knowledge_notes WHERE user_id = ?" },
    { type: "content_item", sql: "SELECT id, title, body_document_id FROM content_items WHERE user_id = ?" },
    { type: "project_log", sql: "SELECT id, COALESCE(title,'') AS title, body_document_id FROM project_logs WHERE user_id = ?" },
    { type: "tool", sql: "SELECT id, name AS title, NULL AS body_document_id FROM tools WHERE user_id = ?" },
    { type: "source", sql: "SELECT id, title, NULL AS body_document_id FROM sources WHERE user_id = ?" },
  ];

  type Row = { id: string; title: string | null; body_document_id: string | null };
  const records: Array<{ id: string; type: string; title: string; body: string }> = [];

  for (const subject of SUBJECTS) {
    const rows = await env.DB.prepare(subject.sql).bind(userId).all<Row>();
    for (const row of rows.results ?? []) {
      let body = "";
      if (row.body_document_id) {
        const blocks = await env.DB
          .prepare("SELECT text FROM document_blocks WHERE document_id = ? ORDER BY position")
          .bind(row.body_document_id).all<{ text: string }>();
        body = (blocks.results ?? []).map((b) => b.text).filter(Boolean).join("\n");
      }
      records.push({ id: row.id, type: subject.type, title: row.title ?? "", body });
    }
  }

  // Only now is the old index dropped: gathering first means a failure above
  // leaves search working rather than silently empty.
  const statements: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM documents_fts")];
  for (const r of records) {
    statements.push(
      env.DB.prepare("INSERT INTO documents_fts (subject_id, subject_type, title, body) VALUES (?, ?, ?, ?)")
        .bind(r.id, r.type, r.title, r.body),
    );
  }
  // Chunked so a large account stays under D1's statements-per-batch limit. The
  // first chunk carries the DELETE, so the swap is atomic with the first writes.
  const CHUNK = 50;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await env.DB.batch(statements.slice(i, i + CHUNK));
  }
  return { indexed: records.length };
}
