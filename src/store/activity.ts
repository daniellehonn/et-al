// The event log, read back: what agents have written. Every write is logged
// with its actor, so this is the audit trail made visible.
import { Ctx, all } from "./db";

export interface RecentEvent {
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  created_at: number;
  /** What the write recorded about itself: a title, a summary, a kind. */
  detail: Record<string, unknown> | null;
}

export async function getAgentActivity(c: Ctx, limit = 50): Promise<RecentEvent[]> {
  const rows = await all<Omit<RecentEvent, "detail"> & { detail_json: string | null }>(
    c,
    `SELECT id, actor, action, entity_type, entity_id, detail_json, created_at FROM event
      WHERE actor LIKE 'ai:%' OR actor = 'system' ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    limit,
  );
  return rows.map(({ detail_json, ...e }) => {
    let detail: Record<string, unknown> | null = null;
    try { detail = detail_json ? JSON.parse(detail_json) : null; } catch { /* leave null */ }
    return { ...e, detail };
  });
}
