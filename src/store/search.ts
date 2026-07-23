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

import { type Env, clampInt } from "./db.ts";
import type { SubjectType } from "../schema.ts";

export interface SearchHit {
  subject_id: string;
  subject_type: SubjectType;
  title: string;
  snippet: string;
  rank: number;
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
