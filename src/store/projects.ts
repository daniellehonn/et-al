// Projects — finite efforts intended to produce an outcome.
//
// The one rule this module enforces above all others: **an Active project must
// have a next action** (spec §3.3, §7.10). That single constraint is what keeps
// the system executable rather than a pretty archive of stalled intentions, so
// it lives in the store and not only in the UI — the MCP tools and API get it
// for free.
//
// Area/Goal membership is many-to-many by design: one activity can advance
// several identities at once, which is why a project is not filed into a folder.

import { desc, eq, and, inArray } from "drizzle-orm";
import {
  projects, projectAreas, projectGoals, areas, goals,
  PROJECT_STATUS, PRIORITY, type ProjectStatus, type Priority,
} from "../schema.ts";
import {
  type Env, getDb, now, newId, requireText, optionalText, optionalEnum, requireEnum,
  readTimestamp, boolInt, audit, NotFoundError, ValidationError, removeFts,
} from "./db.ts";
import { deleteDocument } from "./documents.ts";
import { track } from "../analytics.ts";

/** Statuses for which a next action is mandatory. */
const REQUIRES_NEXT_ACTION: readonly ProjectStatus[] = ["active"];

export interface ProjectInput {
  title?: string;
  summary?: string | null;
  status?: string;
  priority?: string | null;
  next_action?: string | null;
  start_date?: number | string | null;
  target_date?: number | string | null;
  repository_url?: string | null;
  live_url?: string | null;
  cover_asset_id?: string | null;
  portfolio_ready?: boolean;
  area_ids?: string[];
  goal_ids?: string[];
}

export interface ProjectDoc {
  id: string;
  title: string;
  summary: string | null;
  status: ProjectStatus;
  priority: Priority | null;
  next_action: string | null;
  start_date: number | null;
  target_date: number | null;
  repository_url: string | null;
  live_url: string | null;
  cover_asset_id: string | null;
  body_document_id: string | null;
  portfolio_ready: boolean;
  last_activity_at: number | null;
  completed_at: number | null;
  area_ids: string[];
  goal_ids: string[];
  created_at: number;
  updated_at: number;
}

function base(row: typeof projects.$inferSelect) {
  return {
    id: row.id, title: row.title, summary: row.summary, status: row.status,
    priority: row.priority ?? null, next_action: row.nextAction,
    start_date: row.startDate, target_date: row.targetDate,
    repository_url: row.repositoryUrl, live_url: row.liveUrl,
    cover_asset_id: row.coverAssetId, body_document_id: row.bodyDocumentId,
    portfolio_ready: !!row.portfolioReady,
    last_activity_at: row.lastActivityAt, completed_at: row.completedAt,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

async function membership(env: Env, projectIds: string[]) {
  const areaMap = new Map<string, string[]>();
  const goalMap = new Map<string, string[]>();
  if (!projectIds.length) return { areaMap, goalMap };
  const db = getDb(env);
  const [areaRows, goalRows] = await Promise.all([
    db.select().from(projectAreas).where(inArray(projectAreas.projectId, projectIds)),
    db.select().from(projectGoals).where(inArray(projectGoals.projectId, projectIds)),
  ]);
  for (const r of areaRows) areaMap.set(r.projectId, [...(areaMap.get(r.projectId) ?? []), r.areaId]);
  for (const r of goalRows) goalMap.set(r.projectId, [...(goalMap.get(r.projectId) ?? []), r.goalId]);
  return { areaMap, goalMap };
}

/**
 * Guards the activation rule. Called on every write that could leave a project
 * Active, including a plain body edit that happens to include a status change.
 */
function assertNextAction(status: ProjectStatus, nextAction: string | null): void {
  if (REQUIRES_NEXT_ACTION.includes(status) && !nextAction) {
    throw new ValidationError(
      "An active project requires a next action: set `next_action` to the next physical, visible step (or use status 'planned').",
    );
  }
}

async function assertOwned(
  env: Env, userId: string, ids: string[] | undefined, table: typeof areas | typeof goals, field: string,
): Promise<string[]> {
  if (!ids || !ids.length) return [];
  const unique = [...new Set(ids)];
  const rows = await getDb(env).select({ id: table.id }).from(table)
    .where(and(inArray(table.id, unique), eq(table.userId, userId)));
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) throw new ValidationError(`Invalid ${field}: ${missing.join(", ")}`);
  return unique;
}

async function setMembership(
  env: Env, projectId: string, areaIds: string[] | undefined, goalIds: string[] | undefined,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (areaIds) {
    statements.push(env.DB.prepare("DELETE FROM project_areas WHERE project_id = ?").bind(projectId));
    for (const areaId of areaIds) {
      statements.push(env.DB.prepare("INSERT INTO project_areas (project_id, area_id) VALUES (?, ?)").bind(projectId, areaId));
    }
  }
  if (goalIds) {
    statements.push(env.DB.prepare("DELETE FROM project_goals WHERE project_id = ?").bind(projectId));
    for (const goalId of goalIds) {
      statements.push(env.DB.prepare("INSERT INTO project_goals (project_id, goal_id) VALUES (?, ?)").bind(projectId, goalId));
    }
  }
  if (statements.length) await env.DB.batch(statements);
}

export interface ProjectListOptions {
  status?: string | null;
  area_id?: string | null;
  goal_id?: string | null;
  portfolio_ready?: boolean;
  limit?: number;
  offset?: number;
}

export async function listProjects(env: Env, userId: string, opts: ProjectListOptions = {}): Promise<ProjectDoc[]> {
  const db = getDb(env);
  const filters = [eq(projects.userId, userId)];
  if (opts.status) filters.push(eq(projects.status, requireEnum(opts.status, PROJECT_STATUS, "status")));
  if (opts.portfolio_ready) filters.push(eq(projects.portfolioReady, 1));

  // Area/goal filters are membership lookups, so resolve the id set first.
  let restrictTo: string[] | null = null;
  if (opts.area_id) {
    const rows = await db.select({ id: projectAreas.projectId }).from(projectAreas)
      .where(eq(projectAreas.areaId, opts.area_id));
    restrictTo = rows.map((r) => r.id);
  }
  if (opts.goal_id) {
    const rows = await db.select({ id: projectGoals.projectId }).from(projectGoals)
      .where(eq(projectGoals.goalId, opts.goal_id));
    const ids = rows.map((r) => r.id);
    restrictTo = restrictTo ? restrictTo.filter((id) => ids.includes(id)) : ids;
  }
  if (restrictTo !== null) {
    if (!restrictTo.length) return [];
    filters.push(inArray(projects.id, restrictTo));
  }

  const rows = await db.select().from(projects).where(and(...filters))
    .orderBy(desc(projects.updatedAt))
    .limit(Math.min(opts.limit ?? 100, 500)).offset(opts.offset ?? 0);

  const { areaMap, goalMap } = await membership(env, rows.map((r) => r.id));
  return rows.map((row) => ({
    ...base(row),
    area_ids: areaMap.get(row.id) ?? [],
    goal_ids: goalMap.get(row.id) ?? [],
  }));
}

export async function getProject(env: Env, userId: string, id: string): Promise<ProjectDoc | null> {
  const rows = await getDb(env).select().from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId))).limit(1);
  if (!rows[0]) return null;
  const { areaMap, goalMap } = await membership(env, [id]);
  return { ...base(rows[0]), area_ids: areaMap.get(id) ?? [], goal_ids: goalMap.get(id) ?? [] };
}

export async function createProject(env: Env, userId: string, input: ProjectInput): Promise<ProjectDoc> {
  const status = (optionalEnum(input.status, PROJECT_STATUS, "status") ?? "idea") as ProjectStatus;
  const nextAction = optionalText(input.next_action);
  assertNextAction(status, nextAction);

  const areaIds = await assertOwned(env, userId, input.area_ids, areas, "area_ids");
  const goalIds = await assertOwned(env, userId, input.goal_ids, goals, "goal_ids");

  const ts = now();
  const row = {
    id: newId(), userId,
    title: requireText(input.title, "title"),
    summary: optionalText(input.summary),
    status,
    priority: optionalEnum(input.priority, PRIORITY, "priority"),
    nextAction,
    startDate: readTimestamp(input.start_date, "start_date"),
    targetDate: readTimestamp(input.target_date, "target_date"),
    repositoryUrl: optionalText(input.repository_url),
    liveUrl: optionalText(input.live_url),
    coverAssetId: optionalText(input.cover_asset_id),
    bodyDocumentId: null as string | null,
    portfolioReady: boolInt(input.portfolio_ready),
    lastActivityAt: ts,
    completedAt: status === "completed" ? ts : null,
    createdAt: ts, updatedAt: ts,
  };
  await getDb(env).insert(projects).values(row);
  await setMembership(env, row.id, areaIds, goalIds);
  await audit(env, { userId, subjectType: "project", subjectId: row.id, action: "created" });
  return (await getProject(env, userId, row.id))!;
}

export async function updateProject(
  env: Env, userId: string, id: string, input: ProjectInput,
): Promise<ProjectDoc> {
  const current = await getProject(env, userId, id);
  if (!current) throw new NotFoundError(`Project not found: ${id}`);

  const status = input.status !== undefined
    ? requireEnum(input.status, PROJECT_STATUS, "status")
    : current.status;
  const nextAction = input.next_action !== undefined ? optionalText(input.next_action) : current.next_action;
  assertNextAction(status, nextAction);

  const ts = now();
  const patch: Partial<typeof projects.$inferInsert> = { updatedAt: ts, lastActivityAt: ts };
  if (input.title !== undefined) patch.title = requireText(input.title, "title");
  if (input.summary !== undefined) patch.summary = optionalText(input.summary);
  if (input.next_action !== undefined) patch.nextAction = nextAction;
  if (input.priority !== undefined) patch.priority = optionalEnum(input.priority, PRIORITY, "priority");
  if (input.start_date !== undefined) patch.startDate = readTimestamp(input.start_date, "start_date");
  if (input.target_date !== undefined) patch.targetDate = readTimestamp(input.target_date, "target_date");
  if (input.repository_url !== undefined) patch.repositoryUrl = optionalText(input.repository_url);
  if (input.live_url !== undefined) patch.liveUrl = optionalText(input.live_url);
  if (input.cover_asset_id !== undefined) patch.coverAssetId = optionalText(input.cover_asset_id);
  if (input.portfolio_ready !== undefined) patch.portfolioReady = boolInt(input.portfolio_ready);

  const statusChanged = status !== current.status;
  if (statusChanged) {
    patch.status = status;
    // Completion is a real moment: stamp it once, clear it if reopened.
    if (status === "completed") patch.completedAt = ts;
    else if (current.status === "completed") patch.completedAt = null;
  }

  await getDb(env).update(projects).set(patch).where(and(eq(projects.id, id), eq(projects.userId, userId)));

  const areaIds = input.area_ids ? await assertOwned(env, userId, input.area_ids, areas, "area_ids") : undefined;
  const goalIds = input.goal_ids ? await assertOwned(env, userId, input.goal_ids, goals, "goal_ids") : undefined;
  await setMembership(env, id, areaIds, goalIds);

  await audit(env, {
    userId, subjectType: "project", subjectId: id,
    action: statusChanged ? "status-changed" : "updated",
    detail: statusChanged ? { from: current.status, to: status } : {},
  });
  if (statusChanged && status === "active") {
    await track(env, userId, "project_activated", { has_next_action: Boolean(nextAction) });
  }
  if (statusChanged && status === "completed") await track(env, userId, "project_completed", {});
  return (await getProject(env, userId, id))!;
}

/** Sets the body document id once a document has been created for this project. */
export async function setProjectDocument(env: Env, userId: string, id: string, documentId: string): Promise<void> {
  await getDb(env).update(projects).set({ bodyDocumentId: documentId, updatedAt: now() })
    .where(and(eq(projects.id, id), eq(projects.userId, userId)));
}

export async function deleteProject(env: Env, userId: string, id: string): Promise<boolean> {
  const current = await getProject(env, userId, id);
  if (!current) return false;
  if (current.body_document_id) await deleteDocument(env, current.body_document_id);
  // project_areas / project_goals / project_logs cascade via FK.
  await getDb(env).delete(projects).where(and(eq(projects.id, id), eq(projects.userId, userId)));
  await removeFts(env, id);
  await audit(env, { userId, subjectType: "project", subjectId: id, action: "deleted" });
  return true;
}

/**
 * Active projects with no recent log entry or update — the "stale work" surface
 * on Home and in the weekly review (spec §3.3).
 */
export async function listStaleProjects(env: Env, userId: string, days = 14): Promise<ProjectDoc[]> {
  const cutoff = now() - days * 86400;
  const all = await listProjects(env, userId, { status: "active", limit: 500 });
  return all.filter((p) => (p.last_activity_at ?? p.updated_at) < cutoff);
}

/** Active projects that somehow lack a next action — a launch-readiness check. */
export async function listProjectsMissingNextAction(env: Env, userId: string): Promise<ProjectDoc[]> {
  const all = await listProjects(env, userId, { status: "active", limit: 500 });
  return all.filter((p) => !p.next_action);
}
