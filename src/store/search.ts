// Search: hybrid. FTS5 covers every searchable entity by keyword; a vector arm
// covers insights by meaning, so a note phrased differently from the query still
// surfaces. The two ranked lists are fused with Reciprocal Rank Fusion. The
// vector arm is strictly additive — no AI/Vectorize binding, or any failure in
// it, and search degrades to the keyword results rather than erroring.
import { Ctx, all } from "./db";
import type { EntityType } from "../schema";

// Vectors are only ever written for insights (see embedInsight in the Worker).
const VECTOR_TYPE = "insight";
// RRF damping. 60 is the value from the original RRF paper and the usual
// default: high enough that one arm's #1 hit cannot alone dominate the fusion.
const RRF_K = 60;
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export interface SearchHit {
  entity_type: string;
  entity_id: string;
  title: string;
  snippet: string;
  workspace_id: string | null; // for deep-linking; null when unfiled/unknown
}

// Which table carries each searchable entity's workspace_id.
const WS_TABLE: Record<string, string> = {
  document: "document", task: "task", insight: "insight", source: "source", decision: "decision",
};

async function withWorkspace(c: Ctx, hits: Omit<SearchHit, "workspace_id">[]): Promise<SearchHit[]> {
  return Promise.all(hits.map(async (h) => {
    if (h.entity_type === "workspace") return { ...h, workspace_id: h.entity_id };
    const table = WS_TABLE[h.entity_type];
    if (!table) return { ...h, workspace_id: null };
    const row = await c.db.prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`).bind(h.entity_id).first<{ workspace_id: string | null }>();
    return { ...h, workspace_id: row?.workspace_id ?? null };
  }));
}

// FTS5 treats several characters as operators; quote each term to search literally.
function sanitize(query: string): string {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.map((t) => `"${t}"`).join(" ");
}

/** Semantically nearest insights, as a ranked list. Returns [] whenever the
 *  bindings are absent or anything goes wrong — the caller treats this arm as
 *  optional and must never fail a search because embedding was unavailable. */
async function vectorHits(c: Ctx, query: string, limit: number): Promise<Omit<SearchHit, "workspace_id">[]> {
  if (!c.env.AI || !c.env.VECTORIZE) return [];
  try {
    const out = (await c.env.AI.run(EMBEDDING_MODEL as never, { text: [query] } as never)) as unknown as { data: number[][] };
    const vector = out?.data?.[0];
    if (!vector) return [];
    const res = await c.env.VECTORIZE.query(vector, { topK: limit });
    const ids = (res?.matches ?? []).map((m) => m.id);
    if (!ids.length) return [];
    // One round-trip for the bodies, then restored to Vectorize's ranking —
    // SQL `IN` gives no ordering guarantee, and the rank is the whole point.
    const rows = await all<{ id: string; title: string; body: string }>(
      c,
      `SELECT id, title, body FROM insight WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return []; // embedded once, deleted since
      return [{ entity_type: VECTOR_TYPE, entity_id: id, title: row.title, snippet: row.body.slice(0, 160) }];
    });
  } catch {
    return [];
  }
}

/** Reciprocal Rank Fusion: an entity's score is the sum of 1/(k + rank) over
 *  every arm that returned it. Rank-based rather than score-based on purpose —
 *  BM25 rank and cosine distance are not on a comparable scale, so any attempt
 *  to blend the raw numbers would just weight one arm arbitrarily. */
function fuse(arms: Omit<SearchHit, "workspace_id">[][]): Omit<SearchHit, "workspace_id">[] {
  const scores = new Map<string, number>();
  const hits = new Map<string, Omit<SearchHit, "workspace_id">>();
  for (const arm of arms) {
    arm.forEach((hit, i) => {
      const key = `${hit.entity_type}:${hit.entity_id}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + i + 1));
      // First arm to produce a hit owns its snippet: FTS runs first and its
      // snippet highlights the actual matched terms, which is more useful.
      if (!hits.has(key)) hits.set(key, hit);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => hits.get(key)!);
}

export async function search(
  c: Ctx,
  query: string,
  opts: { types?: EntityType[]; limit?: number } = {},
): Promise<SearchHit[]> {
  const match = sanitize(query);
  if (!match) return [];
  const limit = opts.limit ?? 30;
  const wanted = opts.types?.length ? new Set<string>(opts.types) : null;

  const keyword = all<Omit<SearchHit, "workspace_id">>(
    c,
    `SELECT entity_type, entity_id, title, snippet(search_fts, 3, '[', ']', '…', 12) AS snippet
       FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?`,
    match,
    limit,
  );
  // Skip the embedding round-trip entirely when insights are filtered out.
  const semantic = wanted && !wanted.has(VECTOR_TYPE) ? Promise.resolve([]) : vectorHits(c, query, limit);
  const [fts, vec] = await Promise.all([keyword, semantic]);

  const fused = fuse([fts, vec]);
  const filtered = wanted ? fused.filter((r) => wanted.has(r.entity_type)) : fused;
  return withWorkspace(c, filtered.slice(0, limit));
}
