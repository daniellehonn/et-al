// The store context, id/time helpers, the audit trail, and FTS maintenance.
// Every store function takes a Ctx so `actor` is threaded through automatically —
// the MCP handler builds a Ctx with actor='ai:<name>' so a write can't forget to
// attribute itself.
import type { Env, EntityType } from "../schema";

export interface Ctx {
  db: D1Database;
  env: Env;
  actor: string; // 'human' | 'ai:<name>'
}

export function ctx(env: Env, actor = "human"): Ctx {
  return { db: env.DB, env, actor };
}

export const now = () => Date.now();

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Rejected writes throw this; the router maps it to a 4xx. */
export class RuleError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "RuleError";
    this.status = status;
  }
}

export async function logEvent(
  c: Ctx,
  action: string,
  entityType: string,
  entityId: string,
  detail?: unknown,
): Promise<void> {
  await c.db
    .prepare(
      `INSERT INTO event (id, actor, action, entity_type, entity_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id("evt"), c.actor, action, entityType, entityId, detail ? JSON.stringify(detail) : null, now())
    .run();
}

// ---- FTS maintenance --------------------------------------------------------

export async function ftsUpsert(
  c: Ctx,
  entityType: EntityType,
  entityId: string,
  title: string,
  body: string,
): Promise<void> {
  await c.db
    .prepare(`DELETE FROM search_fts WHERE entity_type = ? AND entity_id = ?`)
    .bind(entityType, entityId)
    .run();
  await c.db
    .prepare(`INSERT INTO search_fts (entity_type, entity_id, title, body) VALUES (?, ?, ?, ?)`)
    .bind(entityType, entityId, title ?? "", body ?? "")
    .run();
}

export async function ftsDelete(c: Ctx, entityType: EntityType, entityId: string): Promise<void> {
  await c.db
    .prepare(`DELETE FROM search_fts WHERE entity_type = ? AND entity_id = ?`)
    .bind(entityType, entityId)
    .run();
}

// ---- small query helpers ----------------------------------------------------

export async function first<T = Record<string, unknown>>(
  c: Ctx,
  sql: string,
  ...binds: unknown[]
): Promise<T | null> {
  return (await c.db.prepare(sql).bind(...binds).first<T>()) ?? null;
}

export async function all<T = Record<string, unknown>>(
  c: Ctx,
  sql: string,
  ...binds: unknown[]
): Promise<T[]> {
  const res = await c.db.prepare(sql).bind(...binds).all<T>();
  return res.results ?? [];
}
