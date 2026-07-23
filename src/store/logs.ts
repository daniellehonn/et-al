// Project log entries — the engineer's logbook.
//
// These are separate records rather than blocks inside the project page (spec
// §2.5) precisely so they can be filtered, searched, related, and converted into
// content. A decision recorded here is interview-ready evidence later; an
// experiment is comparable against the next one.
//
// Writing a log also bumps the parent project's `last_activity_at`, which is
// what stale-detection reads — logging work is the signal that a project is alive.

import { desc, eq, and } from "drizzle-orm";
import { projectLogs, projects, LOG_ENTRY_TYPE, CONTENT_SEED_STATUS, type LogEntryType } from "../schema.ts";
import {
  type Env, getDb, now, newId, optionalText, optionalEnum, requireEnum,
  audit, NotFoundError, ValidationError, removeFts,
} from "./db.ts";
import { deleteDocument } from "./documents.ts";
import { track } from "../analytics.ts";

export interface LogInput {
  project_id?: string;
  entry_type?: string;
  title?: string | null;
  content_seed_status?: string;
}

export interface LogDoc {
  id: string;
  project_id: string;
  entry_type: LogEntryType;
  title: string | null;
  body_document_id: string | null;
  content_seed_status: string;
  created_at: number;
  updated_at: number;
}

function view(row: typeof projectLogs.$inferSelect): LogDoc {
  return {
    id: row.id, project_id: row.projectId, entry_type: row.entryType, title: row.title,
    body_document_id: row.bodyDocumentId, content_seed_status: row.contentSeedStatus,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

/**
 * Templates that shape each entry type (spec Appendix B). The API returns these
 * so the client and the MCP tools prompt for the same fields rather than each
 * inventing their own.
 */
export const LOG_TEMPLATES: Record<LogEntryType, string[]> = {
  progress: ["What moved", "What is next"],
  decision: ["Decision", "Rationale", "Alternatives considered"],
  experiment: ["Hypothesis", "Method", "Result", "Interpretation", "Next test"],
  problem: ["Problem", "What I tried", "Current state"],
  learning: ["Lesson", "My explanation", "Where this applies"],
  reflection: ["What worked", "What did not", "What I would change"],
};

async function assertProject(env: Env, userId: string, projectId: string): Promise<void> {
  const rows = await getDb(env).select({ id: projects.id }).from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
  if (!rows.length) throw new ValidationError(`Invalid project_id: no project ${projectId}`);
}

/** Logging is the heartbeat of a project — it keeps it out of the stale list. */
async function touchProject(env: Env, projectId: string): Promise<void> {
  const ts = now();
  await getDb(env).update(projects).set({ lastActivityAt: ts, updatedAt: ts })
    .where(eq(projects.id, projectId));
}

export interface LogListOptions {
  project_id?: string | null;
  entry_type?: string | null;
  content_seed_status?: string | null;
  limit?: number;
}

export async function listLogs(env: Env, userId: string, opts: LogListOptions = {}): Promise<LogDoc[]> {
  const filters = [eq(projectLogs.userId, userId)];
  if (opts.project_id) filters.push(eq(projectLogs.projectId, opts.project_id));
  if (opts.entry_type) filters.push(eq(projectLogs.entryType, requireEnum(opts.entry_type, LOG_ENTRY_TYPE, "entry_type")));
  if (opts.content_seed_status) {
    filters.push(eq(projectLogs.contentSeedStatus, requireEnum(opts.content_seed_status, CONTENT_SEED_STATUS, "content_seed_status")));
  }
  // Reverse chronological: the newest entry is the one you want to see first.
  const rows = await getDb(env).select().from(projectLogs).where(and(...filters))
    .orderBy(desc(projectLogs.createdAt)).limit(Math.min(opts.limit ?? 100, 500));
  return rows.map(view);
}

export async function getLog(env: Env, userId: string, id: string): Promise<LogDoc | null> {
  const rows = await getDb(env).select().from(projectLogs)
    .where(and(eq(projectLogs.id, id), eq(projectLogs.userId, userId))).limit(1);
  return rows[0] ? view(rows[0]) : null;
}

export async function createLog(env: Env, userId: string, input: LogInput): Promise<LogDoc> {
  const projectId = input.project_id;
  if (!projectId) throw new ValidationError("Invalid project_id: a log entry belongs to a project");
  await assertProject(env, userId, projectId);

  const ts = now();
  const row = {
    id: newId(), userId, projectId,
    entryType: (optionalEnum(input.entry_type, LOG_ENTRY_TYPE, "entry_type") ?? "progress") as LogEntryType,
    title: optionalText(input.title),
    bodyDocumentId: null as string | null,
    contentSeedStatus: (optionalEnum(input.content_seed_status, CONTENT_SEED_STATUS, "content_seed_status") ?? "none") as "none",
    createdAt: ts, updatedAt: ts,
  };
  await getDb(env).insert(projectLogs).values(row);
  await touchProject(env, projectId);
  await audit(env, { userId, subjectType: "project_log", subjectId: row.id, action: "created" });
  await track(env, userId, "project_log_created", { entry_type: row.entryType });
  return view(row as typeof projectLogs.$inferSelect);
}

export async function updateLog(env: Env, userId: string, id: string, input: LogInput): Promise<LogDoc> {
  const current = await getLog(env, userId, id);
  if (!current) throw new NotFoundError(`Log entry not found: ${id}`);

  const patch: Partial<typeof projectLogs.$inferInsert> = { updatedAt: now() };
  if (input.entry_type !== undefined) patch.entryType = requireEnum(input.entry_type, LOG_ENTRY_TYPE, "entry_type");
  if (input.title !== undefined) patch.title = optionalText(input.title);
  if (input.content_seed_status !== undefined) {
    patch.contentSeedStatus = requireEnum(input.content_seed_status, CONTENT_SEED_STATUS, "content_seed_status");
  }
  await getDb(env).update(projectLogs).set(patch)
    .where(and(eq(projectLogs.id, id), eq(projectLogs.userId, userId)));
  await touchProject(env, current.project_id);
  await audit(env, { userId, subjectType: "project_log", subjectId: id, action: "updated" });
  return (await getLog(env, userId, id))!;
}

export async function setLogDocument(env: Env, userId: string, id: string, documentId: string): Promise<void> {
  await getDb(env).update(projectLogs).set({ bodyDocumentId: documentId, updatedAt: now() })
    .where(and(eq(projectLogs.id, id), eq(projectLogs.userId, userId)));
}

export async function deleteLog(env: Env, userId: string, id: string): Promise<boolean> {
  const current = await getLog(env, userId, id);
  if (!current) return false;
  if (current.body_document_id) await deleteDocument(env, current.body_document_id);
  await getDb(env).delete(projectLogs).where(and(eq(projectLogs.id, id), eq(projectLogs.userId, userId)));
  await removeFts(env, id);
  await audit(env, { userId, subjectType: "project_log", subjectId: id, action: "deleted" });
  return true;
}
