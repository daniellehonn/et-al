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
}

export function getAgentActivity(c: Ctx, limit = 50): Promise<RecentEvent[]> {
  return all<RecentEvent>(c, `SELECT id, actor, action, entity_type, entity_id, created_at FROM event WHERE actor LIKE 'ai:%' ORDER BY created_at DESC LIMIT ?`, limit);
}
