// Content Items — the work-to-content pipeline.
//
// The distinction that matters (spec §2.10): an *idea* is not a *publication*.
// The status ladder makes that explicit, and provenance back to the work that
// produced it is kept as `created-from` relations rather than copy-paste — which
// is what stops generated drafts from feeling generic (spec §7.8).

import { desc, eq, and } from "drizzle-orm";
import {
  contentItems, CONTENT_STATUS, CONTENT_FORMAT, CONTENT_CHANNEL, type ContentStatus,
} from "../schema.ts";
import {
  type Env, getDb, now, newId, requireText, optionalText, optionalEnum, requireEnum,
  readTimestamp, audit, NotFoundError, ValidationError, removeFts,
} from "./db.ts";
import { deleteDocument } from "./documents.ts";
import { createRelation } from "./relations.ts";
import type { SubjectType } from "../schema.ts";

export interface ContentInput {
  title?: string;
  status?: string;
  format?: string | null;
  channel?: string | null;
  hook?: string | null;
  audience?: string | null;
  published_url?: string | null;
  published_at?: number | string | null;
  scheduled_for?: number | string | null;
}

export interface ContentDoc {
  id: string;
  title: string;
  status: ContentStatus;
  format: string | null;
  channel: string | null;
  hook: string | null;
  audience: string | null;
  body_document_id: string | null;
  published_url: string | null;
  published_at: number | null;
  scheduled_for: number | null;
  created_at: number;
  updated_at: number;
}

function view(row: typeof contentItems.$inferSelect): ContentDoc {
  return {
    id: row.id, title: row.title, status: row.status,
    format: row.format ?? null, channel: row.channel ?? null,
    hook: row.hook, audience: row.audience, body_document_id: row.bodyDocumentId,
    published_url: row.publishedUrl, published_at: row.publishedAt, scheduled_for: row.scheduledFor,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

export interface ContentListOptions {
  status?: string | null;
  limit?: number;
}

export async function listContent(env: Env, userId: string, opts: ContentListOptions = {}): Promise<ContentDoc[]> {
  const filters = [eq(contentItems.userId, userId)];
  if (opts.status) filters.push(eq(contentItems.status, requireEnum(opts.status, CONTENT_STATUS, "status")));
  const rows = await getDb(env).select().from(contentItems).where(and(...filters))
    .orderBy(desc(contentItems.updatedAt)).limit(Math.min(opts.limit ?? 100, 500));
  return rows.map(view);
}

export async function getContent(env: Env, userId: string, id: string): Promise<ContentDoc | null> {
  const rows = await getDb(env).select().from(contentItems)
    .where(and(eq(contentItems.id, id), eq(contentItems.userId, userId))).limit(1);
  return rows[0] ? view(rows[0]) : null;
}

export async function createContent(env: Env, userId: string, input: ContentInput): Promise<ContentDoc> {
  const ts = now();
  const row = {
    id: newId(), userId,
    title: requireText(input.title, "title"),
    status: (optionalEnum(input.status, CONTENT_STATUS, "status") ?? "idea") as ContentStatus,
    format: optionalEnum(input.format, CONTENT_FORMAT, "format"),
    channel: optionalEnum(input.channel, CONTENT_CHANNEL, "channel"),
    hook: optionalText(input.hook),
    audience: optionalText(input.audience),
    bodyDocumentId: null as string | null,
    publishedUrl: optionalText(input.published_url),
    publishedAt: readTimestamp(input.published_at, "published_at"),
    scheduledFor: readTimestamp(input.scheduled_for, "scheduled_for"),
    createdAt: ts, updatedAt: ts,
  };
  await getDb(env).insert(contentItems).values(row);
  await audit(env, { userId, subjectType: "content_item", subjectId: row.id, action: "created" });
  return view(row as typeof contentItems.$inferSelect);
}

/**
 * Creates a seed *from* real work and records the provenance edge in one step.
 * This is the product's core content move — a tested tool, a project log, or a
 * note becoming a draft starting point instead of a blank page (spec §3.7).
 */
export async function createSeedFrom(
  env: Env, userId: string,
  origin: { type: SubjectType; id: string },
  input: ContentInput,
): Promise<ContentDoc> {
  const item = await createContent(env, userId, { ...input, status: input.status ?? "idea" });
  await createRelation(env, userId, {
    source_type: "content_item",
    source_id: item.id,
    target_type: origin.type,
    target_id: origin.id,
    relation_type: "created-from",
    context: `seeded from ${origin.type}`,
  });
  return item;
}

export async function updateContent(env: Env, userId: string, id: string, input: ContentInput): Promise<ContentDoc> {
  const current = await getContent(env, userId, id);
  if (!current) throw new NotFoundError(`Content item not found: ${id}`);

  const status = input.status !== undefined
    ? requireEnum(input.status, CONTENT_STATUS, "status")
    : current.status;
  const publishedUrl = input.published_url !== undefined ? optionalText(input.published_url) : current.published_url;

  // Publishing is a claim about the outside world; it needs the evidence.
  if (status === "published" && !publishedUrl) {
    throw new ValidationError("Marking content published requires a published_url.");
  }

  const ts = now();
  const patch: Partial<typeof contentItems.$inferInsert> = { updatedAt: ts };
  if (input.title !== undefined) patch.title = requireText(input.title, "title");
  if (input.format !== undefined) patch.format = optionalEnum(input.format, CONTENT_FORMAT, "format");
  if (input.channel !== undefined) patch.channel = optionalEnum(input.channel, CONTENT_CHANNEL, "channel");
  if (input.hook !== undefined) patch.hook = optionalText(input.hook);
  if (input.audience !== undefined) patch.audience = optionalText(input.audience);
  if (input.published_url !== undefined) patch.publishedUrl = publishedUrl;
  if (input.scheduled_for !== undefined) patch.scheduledFor = readTimestamp(input.scheduled_for, "scheduled_for");
  if (input.published_at !== undefined) patch.publishedAt = readTimestamp(input.published_at, "published_at");

  const statusChanged = status !== current.status;
  if (statusChanged) {
    patch.status = status;
    if (status === "published" && !current.published_at && input.published_at === undefined) patch.publishedAt = ts;
  }

  await getDb(env).update(contentItems).set(patch)
    .where(and(eq(contentItems.id, id), eq(contentItems.userId, userId)));
  await audit(env, {
    userId, subjectType: "content_item", subjectId: id,
    action: statusChanged ? "status-changed" : "updated",
    detail: statusChanged ? { from: current.status, to: status } : {},
  });
  return (await getContent(env, userId, id))!;
}

export async function setContentDocument(env: Env, userId: string, id: string, documentId: string): Promise<void> {
  await getDb(env).update(contentItems).set({ bodyDocumentId: documentId, updatedAt: now() })
    .where(and(eq(contentItems.id, id), eq(contentItems.userId, userId)));
}

export async function deleteContent(env: Env, userId: string, id: string): Promise<boolean> {
  const current = await getContent(env, userId, id);
  if (!current) return false;
  if (current.body_document_id) await deleteDocument(env, current.body_document_id);
  await getDb(env).delete(contentItems).where(and(eq(contentItems.id, id), eq(contentItems.userId, userId)));
  await removeFts(env, id);
  await audit(env, { userId, subjectType: "content_item", subjectId: id, action: "deleted" });
  return true;
}
