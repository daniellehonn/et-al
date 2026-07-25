// Sources: raw inputs. The captured `raw` payload is write-once. Inline kinds
// (note/idea) are complete on capture; the rest are queued for deterministic
// ingest (fetch/parse/embed) by the Worker — never interpreted here.
import { z } from "zod";
import { captureInput, INLINE_SOURCE_KINDS } from "../schema";
import { Ctx, RuleError, all, first, ftsUpsert, id, logEvent, now } from "./db";

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

/** Assign a capture to a workspace and/or move it out of the inbox. `raw` is
 *  never touched — only the routing fields are mutable. */
export async function updateSource(
  c: Ctx,
  sid: string,
  patch: { workspace_id?: string | null; status?: string },
): Promise<Source> {
  const existing = await getSource(c, sid);
  if (!existing) throw new RuleError(`source ${sid} not found`, 404);
  await c.db
    .prepare(`UPDATE source SET workspace_id = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(
      patch.workspace_id === undefined ? existing.workspace_id : patch.workspace_id,
      patch.status ?? existing.status,
      now(),
      sid,
    )
    .run();
  await logEvent(c, "update", "source", sid, patch);
  return (await getSource(c, sid))!;
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
  }
  return (await getSource(c, sid))!;
}
