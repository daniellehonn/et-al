// Goals — measurable direction inside an Area. They answer *why* a project
// matters (spec §2.3). A goal has exactly one primary Area; a project may serve
// several goals, which is what keeps one activity able to advance several
// identities at once.

import { desc, eq, and } from "drizzle-orm";
import { goals, areas, GOAL_TYPE, GOAL_TIMEFRAME, GOAL_STATUS, type GoalType, type GoalStatus } from "../schema.ts";
import {
  type Env, getDb, now, newId, requireText, optionalEnum, optionalText,
  audit, NotFoundError, ValidationError,
} from "./db.ts";

export interface GoalInput {
  title?: string;
  type?: string;
  timeframe?: string | null;
  metric_name?: string | null;
  target_value?: number | null;
  current_value?: number | null;
  status?: string;
  area_id?: string | null;
}

export interface GoalDoc {
  id: string;
  title: string;
  type: GoalType;
  timeframe: string | null;
  metric_name: string | null;
  target_value: number | null;
  current_value: number | null;
  status: GoalStatus;
  area_id: string | null;
  created_at: number;
  updated_at: number;
}

function view(row: typeof goals.$inferSelect): GoalDoc {
  return {
    id: row.id, title: row.title, type: row.type, timeframe: row.timeframe ?? null,
    metric_name: row.metricName, target_value: row.targetValue, current_value: row.currentValue,
    status: row.status, area_id: row.areaId,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

async function assertAreaExists(env: Env, userId: string, areaId: string | null): Promise<string | null> {
  if (!areaId) return null;
  const rows = await getDb(env).select({ id: areas.id }).from(areas)
    .where(and(eq(areas.id, areaId), eq(areas.userId, userId))).limit(1);
  if (!rows.length) throw new ValidationError(`Invalid area_id: no area ${areaId}`);
  return areaId;
}

export interface GoalListOptions {
  area_id?: string | null;
  status?: string | null;
}

export async function listGoals(env: Env, userId: string, opts: GoalListOptions = {}): Promise<GoalDoc[]> {
  const filters = [eq(goals.userId, userId)];
  if (opts.area_id) filters.push(eq(goals.areaId, opts.area_id));
  if (opts.status) filters.push(eq(goals.status, optionalEnum(opts.status, GOAL_STATUS, "status")!));
  const rows = await getDb(env).select().from(goals).where(and(...filters)).orderBy(desc(goals.updatedAt));
  return rows.map(view);
}

export async function getGoal(env: Env, userId: string, id: string): Promise<GoalDoc | null> {
  const rows = await getDb(env).select().from(goals)
    .where(and(eq(goals.id, id), eq(goals.userId, userId))).limit(1);
  return rows[0] ? view(rows[0]) : null;
}

export async function createGoal(env: Env, userId: string, input: GoalInput): Promise<GoalDoc> {
  const ts = now();
  const row = {
    id: newId(), userId,
    title: requireText(input.title, "title"),
    type: (optionalEnum(input.type, GOAL_TYPE, "type") ?? "outcome") as GoalType,
    timeframe: optionalEnum(input.timeframe, GOAL_TIMEFRAME, "timeframe"),
    metricName: optionalText(input.metric_name),
    targetValue: input.target_value ?? null,
    currentValue: input.current_value ?? null,
    status: (optionalEnum(input.status, GOAL_STATUS, "status") ?? "active") as GoalStatus,
    areaId: await assertAreaExists(env, userId, input.area_id ?? null),
    createdAt: ts, updatedAt: ts,
  };
  await getDb(env).insert(goals).values(row);
  await audit(env, { userId, subjectType: "goal", subjectId: row.id, action: "created" });
  return view(row as typeof goals.$inferSelect);
}

export async function updateGoal(env: Env, userId: string, id: string, input: GoalInput): Promise<GoalDoc> {
  const current = await getGoal(env, userId, id);
  if (!current) throw new NotFoundError(`Goal not found: ${id}`);

  const patch: Partial<typeof goals.$inferInsert> = { updatedAt: now() };
  if (input.title !== undefined) patch.title = requireText(input.title, "title");
  if (input.type !== undefined) patch.type = optionalEnum(input.type, GOAL_TYPE, "type") ?? current.type;
  if (input.timeframe !== undefined) patch.timeframe = optionalEnum(input.timeframe, GOAL_TIMEFRAME, "timeframe");
  if (input.metric_name !== undefined) patch.metricName = optionalText(input.metric_name);
  if (input.target_value !== undefined) patch.targetValue = input.target_value;
  if (input.current_value !== undefined) patch.currentValue = input.current_value;
  if (input.area_id !== undefined) patch.areaId = await assertAreaExists(env, userId, input.area_id);

  const statusChanged = input.status !== undefined && input.status !== current.status;
  if (input.status !== undefined) patch.status = optionalEnum(input.status, GOAL_STATUS, "status") ?? current.status;

  await getDb(env).update(goals).set(patch).where(and(eq(goals.id, id), eq(goals.userId, userId)));
  await audit(env, {
    userId, subjectType: "goal", subjectId: id,
    action: statusChanged ? "status-changed" : "updated",
    detail: statusChanged ? { from: current.status, to: patch.status } : {},
  });
  return (await getGoal(env, userId, id))!;
}

export async function deleteGoal(env: Env, userId: string, id: string): Promise<boolean> {
  const current = await getGoal(env, userId, id);
  if (!current) return false;
  await getDb(env).delete(goals).where(and(eq(goals.id, id), eq(goals.userId, userId)));
  await audit(env, { userId, subjectType: "goal", subjectId: id, action: "deleted" });
  return true;
}
