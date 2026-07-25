// Search: FTS5 today across every searchable entity. Hybrid (FTS + vector)
// ranking is deferred; this is keyword-first.
import { Ctx, all } from "./db";
import type { EntityType } from "../schema";

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

export async function search(
  c: Ctx,
  query: string,
  opts: { types?: EntityType[]; limit?: number } = {},
): Promise<SearchHit[]> {
  const match = sanitize(query);
  if (!match) return [];
  const limit = opts.limit ?? 30;
  const rows = await all<Omit<SearchHit, "workspace_id">>(
    c,
    `SELECT entity_type, entity_id, title, snippet(search_fts, 3, '[', ']', '…', 12) AS snippet
       FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?`,
    match,
    limit,
  );
  const filtered = opts.types?.length
    ? rows.filter((r) => new Set<string>(opts.types!).has(r.entity_type))
    : rows;
  return withWorkspace(c, filtered);
}
