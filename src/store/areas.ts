// Life Areas — long-term identities and responsibilities with no completion date.
//
// The successor to v5's folder/`spaces` model, with one deliberate change: an
// Area is a filter and a context, never a top-level workspace. Giving each
// identity its own silo would recreate exactly the fragmentation the product
// exists to fix (spec §4.1), so navigation stays flat and Areas tag the work.

import { asc, eq, and } from "drizzle-orm";
import { areas, AREA_STATUS, type AreaStatus } from "../schema.ts";
import {
  type Env, getDb, now, newId, requireText, optionalText, optionalEnum,
  audit, NotFoundError, ValidationError,
} from "./db.ts";

export interface AreaInput {
  name?: string;
  description?: string | null;
  icon?: string | null;
  accent?: string | null;
  status?: string;
  sort?: number | null;
}

export interface AreaDoc {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  accent: string | null;
  status: AreaStatus;
  sort: number | null;
  created_at: number;
  updated_at: number;
}

/** Sensible starting identities; the user renames or adds freely (spec §2.2). */
export const SEED_AREAS = [
  { name: "Personal Brand", icon: "◈" },
  { name: "Content", icon: "✎" },
  { name: "Software Development", icon: "⌘" },
  { name: "Student", icon: "◇" },
  { name: "Social", icon: "◎" },
  { name: "Personal", icon: "○" },
] as const;

function view(row: typeof areas.$inferSelect): AreaDoc {
  return {
    id: row.id, name: row.name, description: row.description, icon: row.icon,
    accent: row.accent, status: row.status, sort: row.sort,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

export async function listAreas(env: Env, userId: string, includeInactive = true): Promise<AreaDoc[]> {
  const db = getDb(env);
  const where = includeInactive
    ? eq(areas.userId, userId)
    : and(eq(areas.userId, userId), eq(areas.status, "active"));
  const rows = await db.select().from(areas).where(where).orderBy(asc(areas.sort), asc(areas.name));
  return rows.map(view);
}

export async function getArea(env: Env, userId: string, id: string): Promise<AreaDoc | null> {
  const rows = await getDb(env).select().from(areas)
    .where(and(eq(areas.id, id), eq(areas.userId, userId))).limit(1);
  return rows[0] ? view(rows[0]) : null;
}

export async function createArea(env: Env, userId: string, input: AreaInput): Promise<AreaDoc> {
  const name = requireText(input.name, "name");
  const existing = await getDb(env).select({ id: areas.id }).from(areas)
    .where(and(eq(areas.userId, userId), eq(areas.name, name))).limit(1);
  if (existing.length) throw new ValidationError(`An area named "${name}" already exists`);

  const ts = now();
  const row = {
    id: newId(), userId, name,
    description: optionalText(input.description),
    icon: optionalText(input.icon),
    accent: optionalText(input.accent),
    status: (optionalEnum(input.status, AREA_STATUS, "status") ?? "active") as AreaStatus,
    sort: input.sort ?? null,
    createdAt: ts, updatedAt: ts,
  };
  await getDb(env).insert(areas).values(row);
  await audit(env, { userId, subjectType: "area", subjectId: row.id, action: "created" });
  return view(row as typeof areas.$inferSelect);
}

export async function updateArea(env: Env, userId: string, id: string, input: AreaInput): Promise<AreaDoc> {
  const current = await getArea(env, userId, id);
  if (!current) throw new NotFoundError(`Area not found: ${id}`);

  const patch: Partial<typeof areas.$inferInsert> = { updatedAt: now() };
  if (input.name !== undefined) patch.name = requireText(input.name, "name");
  if (input.description !== undefined) patch.description = optionalText(input.description);
  if (input.icon !== undefined) patch.icon = optionalText(input.icon);
  if (input.accent !== undefined) patch.accent = optionalText(input.accent);
  if (input.status !== undefined) patch.status = optionalEnum(input.status, AREA_STATUS, "status") ?? current.status;
  if (input.sort !== undefined) patch.sort = input.sort;

  await getDb(env).update(areas).set(patch).where(and(eq(areas.id, id), eq(areas.userId, userId)));
  await audit(env, { userId, subjectType: "area", subjectId: id, action: "updated" });
  return (await getArea(env, userId, id))!;
}

/**
 * Areas are referenced by projects and goals through joins that cascade, so a
 * delete quietly unfiles work. Deactivating is almost always what is meant —
 * deletion is allowed but callers should prefer `status: 'inactive'`.
 */
export async function deleteArea(env: Env, userId: string, id: string): Promise<boolean> {
  const current = await getArea(env, userId, id);
  if (!current) return false;
  await getDb(env).delete(areas).where(and(eq(areas.id, id), eq(areas.userId, userId)));
  await audit(env, { userId, subjectType: "area", subjectId: id, action: "deleted" });
  return true;
}

/** Idempotent: only seeds when the user has no areas at all. */
export async function seedAreas(env: Env, userId: string): Promise<AreaDoc[]> {
  const existing = await listAreas(env, userId);
  if (existing.length) return existing;
  const created: AreaDoc[] = [];
  for (const [i, seed] of SEED_AREAS.entries()) {
    created.push(await createArea(env, userId, { name: seed.name, icon: seed.icon, sort: i }));
  }
  return created;
}
