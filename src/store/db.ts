// Shared store infrastructure: bindings, the Drizzle handle, id/time helpers,
// validation, the audit trail, and FTS maintenance.
//
// v6 note: D1 is canonical now, so writes here are the real thing — there is no
// bucket to re-derive from. Multi-row writes that must not half-apply go through
// `env.DB.batch()` (D1 has no interactive transactions; batch is atomic).

import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import * as schema from "../schema.ts";
import { currentActor, currentAgent } from "./context.ts";
import { users } from "../schema.ts";

export interface Env {
  DB: D1Database;
  VAULT: R2Bucket;                 // assets + Markdown exports (no longer truth)
  JOBS?: Queue;                    // durable processing queue (Phase 2)
  VECTORIZE?: VectorizeIndex;      // semantic search index (Phase 5)
  AI?: Ai;                         // Workers AI — embeddings only, not an agent
  // No AI provider key: the AI lives OUTSIDE the platform (Claude via MCP).
  // See docs/v6-implementation-plan.md, Decision F.
  ET_AL_API_KEY?: string;
  SECOND_BRAIN_API_KEY?: string;
  APP_NAME?: string;
}

export type Db = DrizzleD1Database<typeof schema>;

export function getDb(env: Env): Db {
  return drizzle(env.DB, { schema });
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Single-user today, multi-tenant-shaped from day one: every row carries a
 * user_id so authorization boundaries never have to be retrofitted (spec §6.8).
 */
export const DEFAULT_USER_ID = "00000000-0000-4000-8000-000000000001";

export async function ensureUser(env: Env, id = DEFAULT_USER_ID): Promise<string> {
  const db = getDb(env);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  if (existing.length) return id;
  const ts = now();
  await db.insert(users).values({ id, email: null, name: "et al.", createdAt: ts, updatedAt: ts })
    .onConflictDoNothing();
  return id;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function now(): number { return Math.floor(Date.now() / 1000); }
export function newId(): string { return crypto.randomUUID(); }

/** Link-resolution key. Carried over from v5 so wikilink behaviour is unchanged. */
export function normalizeTitle(title: string): string {
  return String(title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function excerptOf(body: string): string {
  return body.replace(/[#>*_`\-\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ValidationError"; }
}
export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "NotFoundError"; }
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ValidationError(`Invalid ${field}: ${JSON.stringify(value)} (allowed: ${allowed.join(", ")})`);
}

export function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T | null {
  if (value === undefined || value === null || value === "") return null;
  return requireEnum(value, allowed, field);
}

export function requireText(value: unknown, field: string, fallback?: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new ValidationError(`Invalid ${field}: a non-empty string is required`);
}

export function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/** Accepts unix seconds or any Date.parse-able string. */
export function readTimestamp(value: unknown, field = "timestamp"): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  throw new ValidationError(`Invalid ${field}: ${JSON.stringify(value)}`);
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function boolInt(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  return value ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export interface AuditInput {
  userId: string;
  subjectType: string;
  subjectId: string;
  action: "created" | "updated" | "deleted" | "status-changed";
  actor?: "user" | "ai" | "system";
  bundleId?: string | null;
  changeId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Records who/what changed a record. Spec §3.2 requires that every AI-created or
 * AI-modified object stay traceable.
 *
 * The actor is taken from the request context rather than each call site, so a
 * write arriving over MCP is attributed to `ai` automatically — a store function
 * cannot forget to say who it was acting for.
 */
export async function audit(env: Env, input: AuditInput): Promise<void> {
  const agent = currentAgent();
  const detail = agent ? { ...(input.detail ?? {}), agent } : (input.detail ?? {});
  await env.DB.prepare(
    `INSERT INTO audit_events (user_id, subject_type, subject_id, action, actor, bundle_id, change_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.userId, input.subjectType, input.subjectId, input.action,
    input.actor ?? currentActor(), input.bundleId ?? null, input.changeId ?? null,
    JSON.stringify(detail), now(),
  ).run();
}

/** Everything an agent touched, newest first — the "what did Claude do" view. */
export async function listAgentActivity(
  env: Env, userId: string, limit = 50,
): Promise<Array<{ subject_type: string; subject_id: string; action: string; detail: string; created_at: number }>> {
  const result = await env.DB.prepare(
    `SELECT subject_type, subject_id, action, detail, created_at
     FROM audit_events WHERE user_id = ? AND actor = 'ai'
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(userId, Math.min(limit, 200)).all<{
    subject_type: string; subject_id: string; action: string; detail: string; created_at: number;
  }>();
  return result.results ?? [];
}

// ---------------------------------------------------------------------------
// Full-text index
// ---------------------------------------------------------------------------

/**
 * documents_fts is a virtual table, so it is maintained explicitly rather than
 * by triggers — bodies are assembled from block rows, not stored in one column.
 */
export async function indexFts(
  env: Env, subjectType: string, subjectId: string, title: string, body: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM documents_fts WHERE subject_id = ?").bind(subjectId),
    env.DB.prepare(
      "INSERT INTO documents_fts (subject_id, subject_type, title, body) VALUES (?, ?, ?, ?)",
    ).bind(subjectId, subjectType, title, body),
  ]);
}

export async function removeFts(env: Env, subjectId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM documents_fts WHERE subject_id = ?").bind(subjectId).run();
}

export { eq, and };
