// Search: hybrid. FTS5 finds notes, tasks and sources by keyword; Vectorize
// finds notes by meaning, so one phrased differently from the query still
// surfaces. The two ranked lists are fused with Reciprocal Rank Fusion. The
// vector arm is strictly additive: without the AI/Vectorize bindings, or on any
// failure in it, search degrades to keyword results rather than erroring.
//
// Proposals are never indexed, so nothing unreviewed can come back from here.
import { Ctx, all, marks } from "./db";
import type { EntityType } from "../schema";

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
// RRF damping. 60 is the value from the original RRF paper and the usual
// default: high enough that one arm's #1 hit cannot alone dominate the fusion.
const RRF_K = 60;

export interface SearchHit {
  entity_type: EntityType;
  entity_id: string;
  title: string;
  snippet: string;
}

// FTS5 treats several characters as operators; quote each term to search literally.
function sanitize(query: string): string {
  return (query.match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => `"${t}"`).join(" ");
}

/** Keyword hits. A note in the trash is still indexed (it can come back), so it
 *  is filtered here rather than dropped from the index. */
function keywordHits(c: Ctx, match: string, limit: number): Promise<SearchHit[]> {
  return all<SearchHit>(
    c,
    `SELECT search_fts.entity_type, search_fts.entity_id, search_fts.title,
            snippet(search_fts, 3, '[', ']', '…', 12) AS snippet
       FROM search_fts
       LEFT JOIN note n ON search_fts.entity_type = 'note' AND n.id = search_fts.entity_id
      WHERE search_fts MATCH ? AND n.trashed_at IS NULL
      ORDER BY rank LIMIT ?`,
    match, limit,
  );
}

/** Notes nearest the query by meaning. Returns [] whenever the bindings are
 *  absent or anything fails — this arm must never fail a search. */
async function vectorHits(c: Ctx, query: string, limit: number): Promise<SearchHit[]> {
  if (!c.env.AI || !c.env.VECTORIZE) return [];
  try {
    const out = (await c.env.AI.run(EMBEDDING_MODEL as never, { text: [query] } as never)) as unknown as { data: number[][] };
    const vector = out?.data?.[0];
    if (!vector) return [];
    const ids = ((await c.env.VECTORIZE.query(vector, { topK: limit }))?.matches ?? []).map((m) => m.id);
    if (!ids.length) return [];
    const rows = await all<{ id: string; title: string }>(
      c, `SELECT id, title FROM note WHERE id IN (${marks(ids.length)}) AND trashed_at IS NULL`, ...ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Restore Vectorize's ranking — SQL `IN` gives no order, and rank is the point.
    return ids.flatMap((nid) => {
      const row = byId.get(nid);
      return row ? [{ entity_type: "note" as const, entity_id: nid, title: row.title, snippet: "" }] : [];
    });
  } catch {
    return [];
  }
}

/** Reciprocal Rank Fusion: an entity's score is the sum of 1/(k + rank) over
 *  every arm that returned it. Rank-based on purpose — BM25 rank and cosine
 *  distance are not on a comparable scale, so blending the raw scores would
 *  just weight one arm arbitrarily. */
export function fuse(arms: SearchHit[][]): SearchHit[] {
  const scores = new Map<string, number>();
  const hits = new Map<string, SearchHit>();
  for (const arm of arms) {
    arm.forEach((hit, i) => {
      const key = `${hit.entity_type}:${hit.entity_id}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + i + 1));
      // The first arm to produce a hit owns its snippet: keyword runs first, and
      // its snippet highlights the terms that actually matched.
      if (!hits.has(key)) hits.set(key, hit);
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => hits.get(key)!);
}

export async function search(c: Ctx, query: string, opts: { types?: EntityType[]; limit?: number } = {}): Promise<SearchHit[]> {
  const match = sanitize(query);
  if (!match) return [];
  const limit = opts.limit ?? 30;
  const wanted = opts.types?.length ? new Set<string>(opts.types) : null;
  const [keyword, semantic] = await Promise.all([
    keywordHits(c, match, limit),
    // Skip the embedding round-trip when notes are filtered out.
    wanted && !wanted.has("note") ? Promise.resolve([]) : vectorHits(c, query, limit),
  ]);
  const fused = fuse([keyword, semantic]);
  return (wanted ? fused.filter((h) => wanted.has(h.entity_type)) : fused).slice(0, limit);
}
