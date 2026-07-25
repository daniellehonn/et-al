// Relationships: the universal typed edge. Backlinks are a reverse query.
import { z } from "zod";
import { relateInput } from "../schema";
import { Ctx, all, id, logEvent, now } from "./db";

export interface Relationship {
  id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  type: string;
  actor: string;
  created_at: number;
}

export async function relate(c: Ctx, input: z.infer<typeof relateInput>): Promise<Relationship> {
  const data = relateInput.parse(input);
  const rid = id("rel");
  await c.db
    .prepare(`INSERT INTO relationship (id, source_type, source_id, target_type, target_id, type, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(rid, data.source_type, data.source_id, data.target_type, data.target_id, data.type, c.actor, now())
    .run();
  await logEvent(c, "create", "relationship", rid, data);
  return (await all<Relationship>(c, `SELECT * FROM relationship WHERE id = ?`, rid))[0];
}

/** Everything referencing this object (edges pointing at it). */
export function getBacklinks(c: Ctx, entityType: string, entityId: string): Promise<Relationship[]> {
  return all<Relationship>(c, `SELECT * FROM relationship WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC`, entityType, entityId);
}

/** Every edge touching this object, in either direction. */
export function listRelationships(c: Ctx, entityType: string, entityId: string): Promise<Relationship[]> {
  return all<Relationship>(
    c,
    `SELECT * FROM relationship WHERE (source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?) ORDER BY created_at DESC`,
    entityType, entityId, entityType, entityId,
  );
}
