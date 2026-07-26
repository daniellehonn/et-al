// Tasks: execution units. May belong to an objective or float in the workspace.
import { z } from "zod";
import { createTaskInput, updateTaskInput } from "../schema";
import { Ctx, RuleError, all, first, ftsDelete, ftsUpsert, id, logEvent, now } from "./db";

export interface Task {
  id: string;
  workspace_id: string;
  objective_id: string | null;
  title: string;
  notes: string | null;
  status: string;
  priority: number;
  due_date: number | null;
  estimate_min: number | null;
  actor: string;
  position: number;
  created_at: number;
  completed_at: number | null;
}

export interface TaskFilter {
  status?: string;
  objective_id?: string;
}

export function listTasks(c: Ctx, workspaceId: string, filter: TaskFilter = {}): Promise<Task[]> {
  const clauses = ["workspace_id = ?"];
  const binds: unknown[] = [workspaceId];
  if (filter.status) { clauses.push("status = ?"); binds.push(filter.status); }
  if (filter.objective_id) { clauses.push("objective_id = ?"); binds.push(filter.objective_id); }
  return all<Task>(c, `SELECT * FROM task WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, position, created_at`, ...binds);
}

export function getTask(c: Ctx, tid: string): Promise<Task | null> {
  return first<Task>(c, `SELECT * FROM task WHERE id = ?`, tid);
}

export async function createTask(c: Ctx, input: z.infer<typeof createTaskInput>): Promise<Task> {
  const data = createTaskInput.parse(input);
  const tid = id("tsk");
  const t = now();
  await c.db
    .prepare(
      `INSERT INTO task (id, workspace_id, objective_id, title, notes, status, priority, due_date, estimate_min, actor, position, created_at)
       VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, 0, ?)`,
    )
    .bind(tid, data.workspace_id, data.objective_id ?? null, data.title, data.notes ?? null, data.priority, data.due_date ?? null, data.estimate_min ?? null, c.actor, t)
    .run();
  await ftsUpsert(c, "task", tid, data.title, data.notes ?? "");
  await logEvent(c, "create", "task", tid, { title: data.title });
  return (await getTask(c, tid))!;
}

export async function updateTask(c: Ctx, tid: string, input: z.infer<typeof updateTaskInput>): Promise<Task> {
  const data = updateTaskInput.parse(input);
  const existing = await getTask(c, tid);
  if (!existing) throw new RuleError(`task ${tid} not found`, 404);
  const status = data.status ?? existing.status;
  const completedAt = status === "done" ? existing.completed_at ?? now() : null;
  await c.db
    .prepare(
      `UPDATE task SET title = ?, notes = ?, status = ?, priority = ?, due_date = ?, estimate_min = ?, objective_id = ?, position = ?, completed_at = ? WHERE id = ?`,
    )
    .bind(
      data.title ?? existing.title,
      data.notes === undefined ? existing.notes : data.notes,
      status,
      data.priority ?? existing.priority,
      data.due_date === undefined ? existing.due_date : data.due_date,
      data.estimate_min === undefined ? existing.estimate_min : data.estimate_min,
      data.objective_id === undefined ? existing.objective_id : data.objective_id,
      data.position ?? existing.position,
      completedAt,
      tid,
    )
    .run();
  await ftsUpsert(c, "task", tid, data.title ?? existing.title, (data.notes === undefined ? existing.notes : data.notes) ?? "");
  await logEvent(c, status === "done" && existing.status !== "done" ? "complete" : "update", "task", tid, data);
  return (await getTask(c, tid))!;
}

export function completeTask(c: Ctx, tid: string): Promise<Task> {
  return updateTask(c, tid, { status: "done" });
}

export async function deleteTask(c: Ctx, tid: string): Promise<void> {
  const existing = await getTask(c, tid);
  if (!existing) throw new RuleError(`task ${tid} not found`, 404);
  await c.db.prepare(`DELETE FROM daily_focus_slot WHERE task_id = ?`).bind(tid).run();
  await c.db.prepare(`DELETE FROM task WHERE id = ?`).bind(tid).run();
  await ftsDelete(c, "task", tid);
  await logEvent(c, "delete", "task", tid, { title: existing.title });
}
