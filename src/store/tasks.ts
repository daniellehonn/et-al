// Tasks: what you're doing. A title, a status, an optional due date, optional
// subtasks, and optionally the note it belongs to.
import { z } from "zod";
import { createTaskInput, updateTaskInput } from "../schema";
import { Ctx, RuleError, all, first, ftsDelete, ftsUpsert, id, logEvent, marks, now } from "./db";
import { requireNote } from "./notes";

export interface Task {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
  due_at: number | null;
  parent_id: string | null;
  note_id: string | null;
  position: number;
  actor: string;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TaskNode extends Task { subtasks: TaskNode[] }

export function getTask(c: Ctx, tid: string): Promise<Task | null> {
  return first<Task>(c, `SELECT * FROM task WHERE id = ?`, tid);
}

async function requireTask(c: Ctx, tid: string): Promise<Task> {
  const task = await getTask(c, tid);
  if (!task) throw new RuleError(`task ${tid} not found`, 404);
  return task;
}

/** Tasks, flat. `open` drops done ones; `note_id` scopes to one note. Ordered so
 *  the next thing to do comes first: in progress, then by due date, then by age. */
export function listTasks(c: Ctx, opts: { note_id?: string; open?: boolean } = {}): Promise<Task[]> {
  const where = [opts.note_id ? `note_id = ?` : null, opts.open ? `status <> 'done'` : null].filter(Boolean);
  return all<Task>(
    c,
    `SELECT * FROM task ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY status = 'done', status <> 'doing', due_at IS NULL, due_at, position, created_at`,
    ...(opts.note_id ? [opts.note_id] : []),
  );
}

/** Every task with its subtasks nested under it. */
export async function taskTree(c: Ctx): Promise<TaskNode[]> {
  const rows = await listTasks(c);
  const byId = new Map<string, TaskNode>(rows.map((r) => [r.id, { ...r, subtasks: [] }]));
  const roots: TaskNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.subtasks.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function createTask(c: Ctx, input: z.input<typeof createTaskInput>): Promise<Task> {
  const data = createTaskInput.parse(input);
  if (data.parent_id) await requireTask(c, data.parent_id);
  if (data.note_id) await requireNote(c, data.note_id);
  const tid = id("task");
  const t = now();
  const last = await first<{ m: number | null }>(c, `SELECT MAX(position) AS m FROM task WHERE parent_id IS ?`, data.parent_id ?? null);
  await c.db
    .prepare(`INSERT INTO task (id, title, status, due_at, parent_id, note_id, position, actor, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(tid, data.title, data.due_at ?? null, data.parent_id ?? null, data.note_id ?? null, (last?.m ?? -1) + 1, c.actor, t, t)
    .run();
  await ftsUpsert(c, "task", tid, data.title, "");
  await logEvent(c, "create", "task", tid, { title: data.title });
  return (await getTask(c, tid))!;
}

export async function updateTask(c: Ctx, tid: string, patch: z.input<typeof updateTaskInput>): Promise<Task> {
  const data = updateTaskInput.parse(patch);
  const task = await requireTask(c, tid);
  if (data.note_id) await requireNote(c, data.note_id);
  const status = data.status ?? task.status;
  // completed_at tracks the transition, so reopening a task clears it.
  const completedAt = status === "done" ? (task.completed_at ?? now()) : null;
  await c.db
    .prepare(`UPDATE task SET title = ?, status = ?, due_at = ?, note_id = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
    .bind(
      data.title ?? task.title, status,
      data.due_at === undefined ? task.due_at : data.due_at,
      data.note_id === undefined ? task.note_id : data.note_id,
      completedAt, now(), tid,
    )
    .run();
  if (data.title && data.title !== task.title) await ftsUpsert(c, "task", tid, data.title, "");
  await logEvent(c, status === "done" && task.status !== "done" ? "complete" : "update", "task", tid, data);
  return (await getTask(c, tid))!;
}

/** Delete a task and its subtasks. */
export async function deleteTask(c: Ctx, tid: string): Promise<void> {
  const task = await requireTask(c, tid);
  const ids = [tid];
  for (let i = 0; i < ids.length; i++) {
    for (const k of await all<{ id: string }>(c, `SELECT id FROM task WHERE parent_id = ?`, ids[i])) ids.push(k.id);
  }
  await c.db.batch([
    c.db.prepare(`UPDATE task SET parent_id = NULL WHERE id IN (${marks(ids.length)})`).bind(...ids),
    c.db.prepare(`DELETE FROM task WHERE id IN (${marks(ids.length)})`).bind(...ids),
  ]);
  for (const x of ids) await ftsDelete(c, "task", x);
  await logEvent(c, "delete", "task", tid, { title: task.title, tasks: ids.length });
}
