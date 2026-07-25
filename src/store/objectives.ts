// Objectives: the planning layer between a workspace and its tasks.
import { z } from "zod";
import { createObjectiveInput, updateObjectiveInput } from "../schema";
import { Ctx, RuleError, all, first, id, logEvent, now } from "./db";

export interface Objective {
  id: string;
  workspace_id: string;
  parent_objective_id: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export function listObjectives(c: Ctx, workspaceId: string): Promise<Objective[]> {
  return all<Objective>(c, `SELECT * FROM objective WHERE workspace_id = ? ORDER BY priority DESC, position`, workspaceId);
}

export function getObjective(c: Ctx, oid: string): Promise<Objective | null> {
  return first<Objective>(c, `SELECT * FROM objective WHERE id = ?`, oid);
}

export async function createObjective(c: Ctx, input: z.infer<typeof createObjectiveInput>): Promise<Objective> {
  const data = createObjectiveInput.parse(input);
  const oid = id("obj");
  const t = now();
  await c.db
    .prepare(
      `INSERT INTO objective (id, workspace_id, parent_objective_id, title, description, status, priority, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?)`,
    )
    .bind(oid, data.workspace_id, data.parent_objective_id ?? null, data.title, data.description ?? null, data.priority, t, t)
    .run();
  await logEvent(c, "create", "objective", oid, { title: data.title });
  return (await getObjective(c, oid))!;
}

export async function updateObjective(c: Ctx, oid: string, input: z.infer<typeof updateObjectiveInput>): Promise<Objective> {
  const data = updateObjectiveInput.parse(input);
  const existing = await getObjective(c, oid);
  if (!existing) throw new RuleError(`objective ${oid} not found`, 404);
  await c.db
    .prepare(`UPDATE objective SET title = ?, description = ?, status = ?, priority = ?, position = ?, updated_at = ? WHERE id = ?`)
    .bind(
      data.title ?? existing.title,
      data.description === undefined ? existing.description : data.description,
      data.status ?? existing.status,
      data.priority ?? existing.priority,
      data.position ?? existing.position,
      now(),
      oid,
    )
    .run();
  await logEvent(c, "update", "objective", oid, data);
  return (await getObjective(c, oid))!;
}
