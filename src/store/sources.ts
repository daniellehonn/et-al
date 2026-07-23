// Sources — external material the user consumed.
//
// Deliberately distinct from the knowledge created from it (spec §2.9): the
// video is not the note. Keeping them separate is what lets several notes cite
// one source, and lets a source be reprocessed under a newer prompt/model
// without touching the understanding the user already wrote.

import { desc, eq, and } from "drizzle-orm";
import { sources, SOURCE_PLATFORM, type SourcePlatform } from "../schema.ts";
import {
  type Env, getDb, now, newId, requireText, optionalText, optionalEnum, requireEnum,
  readTimestamp, audit, NotFoundError, removeFts,
} from "./db.ts";

export interface SourceInput {
  title?: string;
  url?: string | null;
  platform?: string;
  author?: string | null;
  published_at?: number | string | null;
  transcript?: string | null;
  summary?: string | null;
  capture_id?: string | null;
  processing_version?: string | null;
}

export interface SourceDoc {
  id: string;
  title: string;
  url: string | null;
  platform: SourcePlatform;
  author: string | null;
  published_at: number | null;
  transcript: string | null;
  /** AI-generated. The UI must label it; it is never the user's own summary. */
  summary: string | null;
  capture_id: string | null;
  processing_version: string | null;
  created_at: number;
  updated_at: number;
}

/** Picks the ingestion pipeline: transcript fetch vs article parse. */
export function detectPlatform(url: string | null): SourcePlatform {
  if (!url) return "other";
  const u = url.toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return "youtube";
  if (/tiktok\.com/.test(u)) return "tiktok";
  if (/instagram\.com/.test(u)) return "instagram";
  if (/arxiv\.org|\.pdf($|\?)/.test(u)) return "paper";
  return "article";
}

function view(row: typeof sources.$inferSelect): SourceDoc {
  return {
    id: row.id, title: row.title, url: row.url, platform: row.platform, author: row.author,
    published_at: row.publishedAt, transcript: row.transcript, summary: row.summary,
    capture_id: row.captureId, processing_version: row.processingVersion,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

export interface SourceListOptions {
  platform?: string | null;
  limit?: number;
}

export async function listSources(env: Env, userId: string, opts: SourceListOptions = {}): Promise<SourceDoc[]> {
  const filters = [eq(sources.userId, userId)];
  if (opts.platform) filters.push(eq(sources.platform, requireEnum(opts.platform, SOURCE_PLATFORM, "platform")));
  const rows = await getDb(env).select().from(sources).where(and(...filters))
    .orderBy(desc(sources.updatedAt)).limit(Math.min(opts.limit ?? 100, 500));
  return rows.map(view);
}

export async function getSource(env: Env, userId: string, id: string): Promise<SourceDoc | null> {
  const rows = await getDb(env).select().from(sources)
    .where(and(eq(sources.id, id), eq(sources.userId, userId))).limit(1);
  return rows[0] ? view(rows[0]) : null;
}

export async function createSource(env: Env, userId: string, input: SourceInput): Promise<SourceDoc> {
  const url = optionalText(input.url);
  const ts = now();
  const row = {
    id: newId(), userId,
    title: requireText(input.title, "title"),
    url,
    platform: (optionalEnum(input.platform, SOURCE_PLATFORM, "platform") ?? detectPlatform(url)) as SourcePlatform,
    author: optionalText(input.author),
    publishedAt: readTimestamp(input.published_at, "published_at"),
    transcript: optionalText(input.transcript),
    summary: optionalText(input.summary),
    captureId: optionalText(input.capture_id),
    processingVersion: optionalText(input.processing_version),
    createdAt: ts, updatedAt: ts,
  };
  await getDb(env).insert(sources).values(row);
  await audit(env, { userId, subjectType: "source", subjectId: row.id, action: "created" });
  return view(row as typeof sources.$inferSelect);
}

export async function updateSource(env: Env, userId: string, id: string, input: SourceInput): Promise<SourceDoc> {
  const current = await getSource(env, userId, id);
  if (!current) throw new NotFoundError(`Source not found: ${id}`);

  const patch: Partial<typeof sources.$inferInsert> = { updatedAt: now() };
  if (input.title !== undefined) patch.title = requireText(input.title, "title");
  if (input.url !== undefined) patch.url = optionalText(input.url);
  if (input.platform !== undefined) patch.platform = requireEnum(input.platform, SOURCE_PLATFORM, "platform");
  if (input.author !== undefined) patch.author = optionalText(input.author);
  if (input.published_at !== undefined) patch.publishedAt = readTimestamp(input.published_at, "published_at");
  if (input.transcript !== undefined) patch.transcript = optionalText(input.transcript);
  if (input.summary !== undefined) patch.summary = optionalText(input.summary);
  if (input.processing_version !== undefined) patch.processingVersion = optionalText(input.processing_version);

  await getDb(env).update(sources).set(patch).where(and(eq(sources.id, id), eq(sources.userId, userId)));
  await audit(env, { userId, subjectType: "source", subjectId: id, action: "updated" });
  return (await getSource(env, userId, id))!;
}

export async function deleteSource(env: Env, userId: string, id: string): Promise<boolean> {
  const current = await getSource(env, userId, id);
  if (!current) return false;
  await getDb(env).delete(sources).where(and(eq(sources.id, id), eq(sources.userId, userId)));
  await removeFts(env, id);
  await audit(env, { userId, subjectType: "source", subjectId: id, action: "deleted" });
  return true;
}

/**
 * Deleting only the transcript, keeping the record and any notes made from it.
 * Spec §6.8 requires transcript deletion to be supported independently.
 */
export async function deleteTranscript(env: Env, userId: string, id: string): Promise<SourceDoc> {
  return updateSource(env, userId, id, { transcript: null });
}
