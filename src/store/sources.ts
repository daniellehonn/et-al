// Sources: what you saved. A link, a thought, a snippet — captured first and
// sorted later. A source with a URL is fetched in the background (ingest.ts),
// which decorates it and may propose insights from it.
import { z } from "zod";
import { captureInput, fileSourceInput } from "../schema";
import { Ctx, RuleError, all, first, ftsDelete, ftsUpsert, id, logEvent, now } from "./db";
import { requireNote } from "./notes";

export interface Source {
  id: string;
  title: string;
  url: string | null;
  text: string | null;
  status: "inbox" | "done";
  note_id: string | null;
  fetch_status: "pending" | "fetched" | "failed" | null;
  fetch_error: string | null;
  site: string | null;
  description: string | null;
  image: string | null;
  capture_key: string | null;
  actor: string;
  created_at: number;
  updated_at: number;
}

/** A capture, and whether it was already there. */
export type Captured = Source & { already_captured?: true };

export function getSource(c: Ctx, sid: string): Promise<Source | null> {
  return first<Source>(c, `SELECT * FROM source WHERE id = ?`, sid);
}

export async function requireSource(c: Ctx, sid: string): Promise<Source> {
  const src = await getSource(c, sid);
  if (!src) throw new RuleError(`source ${sid} not found`, 404);
  return src;
}

/** Index a source by everything a person would search it by. */
export async function reindexSource(c: Ctx, sid: string, fetched = ""): Promise<void> {
  const s = await getSource(c, sid);
  if (s) await ftsUpsert(c, "source", sid, s.title || s.url || "", [s.text, s.description, s.url, fetched].filter(Boolean).join("\n"));
}

/** Save something immediately. Organising it is a separate, later step.
 *
 *  Capturing is idempotent two ways. A caller that passes a `key` (the
 *  Idempotency-Key header over REST) gets the same source back however many
 *  times it retries. And saving a link that is already waiting in the inbox
 *  returns the one already there: the second save is almost always the first
 *  one repeated, and two copies of a link is a mess to triage. */
export async function capture(c: Ctx, input: z.input<typeof captureInput>, key?: string | null): Promise<Captured> {
  const data = captureInput.parse(input);
  if (key) {
    const prior = await first<Source>(c, `SELECT * FROM source WHERE capture_key = ?`, key);
    if (prior) return { ...prior, already_captured: true };
  }
  if (data.url) {
    const waiting = await first<Source>(c, `SELECT * FROM source WHERE url = ? AND status = 'inbox' ORDER BY created_at DESC LIMIT 1`, data.url);
    if (waiting) return { ...waiting, already_captured: true };
  }
  if (data.note_id) await requireNote(c, data.note_id);
  const sid = id("src");
  const t = now();
  const title = data.title?.trim() || data.url || data.text!.trim().slice(0, 80);
  try {
    await c.db
      .prepare(`INSERT INTO source (id, title, url, text, status, note_id, fetch_status, capture_key, actor, created_at, updated_at) VALUES (?, ?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?)`)
      .bind(sid, title, data.url ?? null, data.text?.trim() || null, data.note_id ?? null, data.url ? "pending" : null, key ?? null, c.actor, t, t)
      .run();
  } catch (e) {
    // Two requests with the same key raced past the check above; the unique
    // index let exactly one in. The loser returns the winner's source.
    const winner = key ? await first<Source>(c, `SELECT * FROM source WHERE capture_key = ?`, key) : null;
    if (winner) return { ...winner, already_captured: true };
    throw e;
  }
  await reindexSource(c, sid);
  await logEvent(c, "capture", "source", sid, { title, url: data.url ?? null });
  if (data.url && c.env.JOBS) await c.env.JOBS.send({ type: "ingest_source", source_id: sid });
  return (await getSource(c, sid))!;
}

/** Fetch a link again after a failure. */
export async function retryFetch(c: Ctx, sid: string): Promise<Source> {
  const src = await requireSource(c, sid);
  if (!src.url) throw new RuleError("this source has no link to fetch", 400);
  if (src.fetch_status === "pending") return src;
  await c.db.prepare(`UPDATE source SET fetch_status = 'pending', fetch_error = NULL, updated_at = ? WHERE id = ?`).bind(now(), sid).run();
  if (c.env.JOBS) await c.env.JOBS.send({ type: "ingest_source", source_id: sid });
  await logEvent(c, "retry_fetch", "source", sid);
  return (await getSource(c, sid))!;
}

/** Record that a fetch failed, and why, so the inbox can say so and offer a retry. */
export async function markFetchFailed(c: Ctx, sid: string, reason: string): Promise<void> {
  await c.db.prepare(`UPDATE source SET fetch_status = 'failed', fetch_error = ?, updated_at = ? WHERE id = ?`).bind(reason, now(), sid).run();
}

/** Everything not yet dealt with, newest first. */
export function listInbox(c: Ctx): Promise<Source[]> {
  return all<Source>(c, `SELECT * FROM source WHERE status = 'inbox' ORDER BY created_at DESC`);
}

/** What has been filed into a note. */
export function listNoteSources(c: Ctx, noteId: string): Promise<Source[]> {
  return all<Source>(c, `SELECT * FROM source WHERE note_id = ? ORDER BY created_at DESC`, noteId);
}

/** File a source into a note, retitle it, or mark it done. Filing it into a note
 *  is dealing with it, so that also takes it out of the inbox. */
export async function fileSource(c: Ctx, sid: string, patch: z.input<typeof fileSourceInput>): Promise<Source> {
  const data = fileSourceInput.parse(patch);
  const src = await requireSource(c, sid);
  if (data.note_id) await requireNote(c, data.note_id);
  const noteId = data.note_id === undefined ? src.note_id : data.note_id;
  const status = data.status ?? (data.note_id ? "done" : src.status);
  await c.db
    .prepare(`UPDATE source SET title = ?, note_id = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(data.title ?? src.title, noteId, status, now(), sid)
    .run();
  if (data.title !== undefined) await reindexSource(c, sid);
  await logEvent(c, "file", "source", sid, data);
  return (await getSource(c, sid))!;
}

/** Delete a source. Pending insights from it go with it; insights already
 *  accepted are notes now, and keep living without it. */
export async function deleteSource(c: Ctx, sid: string): Promise<void> {
  const src = await requireSource(c, sid);
  await c.db.batch([
    c.db.prepare(`DELETE FROM proposal WHERE source_id = ? AND status = 'pending'`).bind(sid),
    c.db.prepare(`UPDATE proposal SET source_id = NULL WHERE source_id = ?`).bind(sid),
    c.db.prepare(`DELETE FROM source WHERE id = ?`).bind(sid),
  ]);
  await ftsDelete(c, "source", sid);
  await logEvent(c, "delete", "source", sid, { title: src.title });
}
