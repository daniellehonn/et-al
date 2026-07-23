// Relations — the semantic graph.
//
// Generalizes v5's `links` table to any pair of typed objects. The rule from the
// spec (§2.11): *everything can connect, but not everything is the same thing*.
// Strongly typed, high-volume membership (project↔area, project↔goal) lives in
// dedicated join tables; meaning-bearing edges live here.
//
// Two behaviours carry over from v5 and are worth keeping:
//   * **Unresolved links.** A [[wikilink]] to a page that does not exist yet is
//     stored with target_id NULL and target_norm set, then resolved when the
//     target is created. Click-to-create depends on this.
//   * **Backlinks are free.** Because every edge is a row, "what references this"
//     is a plain query rather than a scan.

import { desc, eq, and, isNull } from "drizzle-orm";
import { relations, RELATION_TYPE, SUBJECT_TYPE, type RelationType, type SubjectType } from "../schema.ts";
import {
  type Env, getDb, now, newId, requireEnum, normalizeTitle, audit, ValidationError,
} from "./db.ts";

export interface RelationInput {
  source_type?: string;
  source_id?: string;
  target_type?: string | null;
  target_id?: string | null;
  target_title?: string | null;   // for unresolved [[wikilink]] targets
  relation_type?: string;
  context?: string;
}

export interface RelationDoc {
  id: string;
  source_type: SubjectType;
  source_id: string;
  target_type: SubjectType | null;
  target_id: string | null;
  target_norm: string | null;
  relation_type: RelationType;
  context: string;
  created_at: number;
}

function view(row: typeof relations.$inferSelect): RelationDoc {
  return {
    id: row.id, source_type: row.sourceType, source_id: row.sourceId,
    target_type: row.targetType ?? null, target_id: row.targetId, target_norm: row.targetNorm,
    relation_type: row.relationType, context: row.context, created_at: row.createdAt,
  };
}

export async function createRelation(env: Env, userId: string, input: RelationInput): Promise<RelationDoc> {
  const sourceType = requireEnum(input.source_type, SUBJECT_TYPE, "source_type");
  const sourceId = input.source_id;
  if (!sourceId) throw new ValidationError("Invalid source_id: required");
  if (!input.target_id && !input.target_title) {
    throw new ValidationError("A relation needs either target_id or target_title");
  }

  const row = {
    id: newId(), userId,
    sourceType, sourceId,
    targetType: input.target_type ? requireEnum(input.target_type, SUBJECT_TYPE, "target_type") : null,
    targetId: input.target_id ?? null,
    targetNorm: input.target_title ? normalizeTitle(input.target_title) : null,
    relationType: requireEnum(input.relation_type ?? "mentions", RELATION_TYPE, "relation_type"),
    context: String(input.context ?? ""),
    createdAt: now(),
  };
  await getDb(env).insert(relations).values(row);
  return view(row as typeof relations.$inferSelect);
}

/** Replaces every outgoing edge from one object — used when a body is re-saved. */
export async function replaceOutgoing(
  env: Env, userId: string, sourceType: SubjectType, sourceId: string, edges: RelationInput[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM relations WHERE source_type = ? AND source_id = ? AND user_id = ?")
      .bind(sourceType, sourceId, userId),
  ];
  const ts = now();
  for (const edge of edges) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO relations (id, user_id, source_type, source_id, target_type, target_id, target_norm, relation_type, context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId(), userId, sourceType, sourceId,
        edge.target_type ? requireEnum(edge.target_type, SUBJECT_TYPE, "target_type") : null,
        edge.target_id ?? null,
        edge.target_title ? normalizeTitle(edge.target_title) : null,
        requireEnum(edge.relation_type ?? "mentions", RELATION_TYPE, "relation_type"),
        String(edge.context ?? ""), ts,
      ),
    );
  }
  await env.DB.batch(statements);
}

/** Outgoing edges: what this object points at. */
export async function getOutgoing(
  env: Env, userId: string, sourceType: SubjectType, sourceId: string,
): Promise<RelationDoc[]> {
  const rows = await getDb(env).select().from(relations)
    .where(and(
      eq(relations.userId, userId),
      eq(relations.sourceType, sourceType),
      eq(relations.sourceId, sourceId),
    ))
    .orderBy(desc(relations.createdAt));
  return rows.map(view);
}

/** Backlinks: everything that references this object. */
export async function getBacklinks(
  env: Env, userId: string, targetType: SubjectType, targetId: string,
): Promise<RelationDoc[]> {
  const rows = await getDb(env).select().from(relations)
    .where(and(
      eq(relations.userId, userId),
      eq(relations.targetType, targetType),
      eq(relations.targetId, targetId),
    ))
    .orderBy(desc(relations.createdAt));
  return rows.map(view);
}

/**
 * Points every dangling reference to `title` at a newly created object. Called
 * on create and on rename, so a link written before its target existed starts
 * working the moment the target appears.
 */
export async function resolveRelationsTo(
  env: Env, userId: string, title: string, targetType: SubjectType, targetId: string,
): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE relations SET target_id = ?, target_type = ?
     WHERE user_id = ? AND target_norm = ? AND target_id IS NULL`,
  ).bind(targetId, targetType, userId, normalizeTitle(title)).run();
  return result.meta?.changes ?? 0;
}

/** Link targets that do not exist yet — the click-to-create queue. */
export async function listUnresolved(env: Env, userId: string): Promise<Array<{ target_norm: string; refs: number; sample: string }>> {
  const result = await env.DB.prepare(
    `SELECT target_norm, COUNT(*) AS refs,
            (SELECT context FROM relations r2 WHERE r2.target_norm = r.target_norm LIMIT 1) AS sample
     FROM relations r
     WHERE user_id = ? AND target_id IS NULL AND target_norm IS NOT NULL
     GROUP BY target_norm ORDER BY refs DESC`,
  ).bind(userId).all<{ target_norm: string; refs: number; sample: string }>();
  return result.results ?? [];
}

export async function deleteRelation(env: Env, userId: string, id: string): Promise<boolean> {
  const rows = await getDb(env).select({ id: relations.id }).from(relations)
    .where(and(eq(relations.id, id), eq(relations.userId, userId))).limit(1);
  if (!rows.length) return false;
  await getDb(env).delete(relations).where(and(eq(relations.id, id), eq(relations.userId, userId)));
  return true;
}

/** Drops every edge touching an object; called when that object is deleted. */
export async function purgeRelationsFor(
  env: Env, userId: string, subjectType: SubjectType, subjectId: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM relations WHERE user_id = ? AND source_type = ? AND source_id = ?")
      .bind(userId, subjectType, subjectId),
    // Keep the edge but unresolve it, so a backlink from elsewhere degrades to
    // an unresolved link rather than vanishing silently.
    env.DB.prepare("UPDATE relations SET target_id = NULL WHERE user_id = ? AND target_type = ? AND target_id = ?")
      .bind(userId, subjectType, subjectId),
  ]);
}

export { isNull };
