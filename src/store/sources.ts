// Sources: raw inputs. The captured `raw` payload is write-once. Inline kinds
// (note/idea) are complete on capture; the rest are queued for deterministic
// ingest (fetch/parse/embed) by the Worker — never interpreted here.
import { z } from "zod";
import { captureInput, INLINE_SOURCE_KINDS } from "../schema";
import { Ctx, RuleError, all, first, ftsDelete, ftsUpsert, id, logEvent, now } from "./db";

export interface Source {
  id: string;
  workspace_id: string | null;
  kind: string;
  title: string | null;
  url: string | null;
  r2_key: string | null;
  raw: string | null;
  metadata_json: string | null;
  status: string;
  actor: string;
  created_at: number;
  updated_at: number;
}

export function getSource(c: Ctx, sid: string): Promise<Source | null> {
  return first<Source>(c, `SELECT * FROM source WHERE id = ?`, sid);
}

export function listInbox(c: Ctx): Promise<Source[]> {
  return all<Source>(c, `SELECT * FROM source WHERE status = 'inbox' ORDER BY created_at DESC`);
}

/** Sources across every workspace, newest first, optionally filtered by title
 *  or URL. Backs the @-mention picker, which needs to reach anything saved
 *  anywhere — not just the current workspace's shelf or the inbox. LIKE rather
 *  than FTS on purpose: the picker filters as you type, including on partial
 *  words that FTS would not match until they were complete. */
export function listSources(c: Ctx, q?: string, limit = 20): Promise<Source[]> {
  const term = q?.trim();
  if (!term) return all<Source>(c, `SELECT * FROM source ORDER BY created_at DESC LIMIT ?`, limit);
  const like = `%${term.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
  return all<Source>(
    c,
    `SELECT * FROM source WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`,
    like, like, limit,
  );
}

/** Everything filed into a workspace — the saved-material shelf. Deliberately
 *  not filtered by status: a capture belongs to its workspace from the moment
 *  it is filed, whatever the ingest pipeline later does to it. */
export function listWorkspaceSources(c: Ctx, workspaceId: string): Promise<Source[]> {
  return all<Source>(c, `SELECT * FROM source WHERE workspace_id = ? ORDER BY created_at DESC`, workspaceId);
}

/** Assign a capture to a workspace, move it out of the inbox, or relabel it.
 *  `raw` is still never touched — the captured payload is write-once. `title` is
 *  a label rather than payload, and has to be editable: plenty of sites (any
 *  login-walled feed, for one) hand back nothing usable to enrich with, so
 *  naming a saved link yourself is the only way it stays findable. */
export async function updateSource(
  c: Ctx,
  sid: string,
  patch: { workspace_id?: string | null; status?: string; title?: string },
): Promise<Source> {
  const existing = await getSource(c, sid);
  if (!existing) throw new RuleError(`source ${sid} not found`, 404);
  const title = patch.title?.trim() ? patch.title.trim() : existing.title;
  await c.db
    .prepare(`UPDATE source SET workspace_id = ?, status = ?, title = ?, updated_at = ? WHERE id = ?`)
    .bind(
      patch.workspace_id === undefined ? existing.workspace_id : patch.workspace_id,
      patch.status ?? existing.status,
      title,
      now(),
      sid,
    )
    .run();
  if (title !== existing.title) await ftsUpsert(c, "source", sid, title ?? existing.url ?? existing.kind, existing.raw ?? "");
  await logEvent(c, "update", "source", sid, patch);
  return (await getSource(c, sid))!;
}

export async function deleteSource(c: Ctx, sid: string): Promise<void> {
  const existing = await getSource(c, sid);
  if (!existing) throw new RuleError(`source ${sid} not found`, 404);
  await c.db.prepare(`DELETE FROM source WHERE id = ?`).bind(sid).run();
  await ftsDelete(c, "source", sid);
  await logEvent(c, "delete", "source", sid, { kind: existing.kind });
}

/** Save a raw input immediately. Never blocks on a fetch; queues async ingest. */
export async function capture(c: Ctx, input: z.infer<typeof captureInput>): Promise<Source> {
  const data = captureInput.parse(input);
  const inline = (INLINE_SOURCE_KINDS as readonly string[]).includes(data.kind);
  const sid = id("src");
  const t = now();
  await c.db
    .prepare(
      `INSERT INTO source (id, workspace_id, kind, title, url, raw, status, actor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(sid, data.workspace_id ?? null, data.kind, data.title ?? null, data.url ?? null, data.raw ?? null, "inbox", c.actor, t, t)
    .run();
  await ftsUpsert(c, "source", sid, data.title ?? data.url ?? data.kind, data.raw ?? "");
  await logEvent(c, "create", "source", sid, { kind: data.kind });

  // Inline kinds are done. Others need fetch/parse/embed — enqueue if available.
  if (!inline && c.env.JOBS) {
    await c.env.JOBS.send({ type: "ingest_source", source_id: sid });
  } else if (inline && data.url && c.env.JOBS) {
    // A pasted or shared link arrives as an inline `note` so it stays in the
    // inbox (see /api/share). It still deserves a title and a description, so
    // enqueue enrichment — which decorates the row without advancing `status`.
    await c.env.JOBS.send({ type: "enrich_source", source_id: sid });
  }
  return (await getSource(c, sid))!;
}
