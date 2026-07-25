// Search: FTS5 today across every searchable entity. Hybrid (FTS + vector)
// ranking is deferred; this is keyword-first.
import { Ctx, all } from "./db";
import type { EntityType } from "../schema";

export interface SearchHit {
  entity_type: string;
  entity_id: string;
  title: string;
  snippet: string;
}

// FTS5 treats several characters as operators; quote each term to search literally.
function sanitize(query: string): string {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.map((t) => `"${t}"`).join(" ");
}

export async function search(
  c: Ctx,
  query: string,
  opts: { types?: EntityType[]; limit?: number } = {},
): Promise<SearchHit[]> {
  const match = sanitize(query);
  if (!match) return [];
  const limit = opts.limit ?? 30;
  const rows = await all<SearchHit>(
    c,
    `SELECT entity_type, entity_id, title, snippet(search_fts, 3, '[', ']', '…', 12) AS snippet
       FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?`,
    match,
    limit,
  );
  if (opts.types?.length) {
    const set = new Set<string>(opts.types);
    return rows.filter((r) => set.has(r.entity_type));
  }
  return rows;
}
