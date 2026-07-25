// Insights: atomic knowledge nodes — the vertices of the knowledge graph.
import { z } from "zod";
import { createInsightInput } from "../schema";
import { Ctx, all, first, ftsUpsert, id, logEvent, now } from "./db";

export interface Insight {
  id: string;
  workspace_id: string | null;
  title: string;
  body: string;
  source_id: string | null;
  embedding_id: string | null;
  is_ai: number;
  actor: string;
  created_at: number;
  updated_at: number;
}

export function getInsight(c: Ctx, iid: string): Promise<Insight | null> {
  return first<Insight>(c, `SELECT * FROM insight WHERE id = ?`, iid);
}

export function listInsights(c: Ctx, workspaceId?: string): Promise<Insight[]> {
  if (workspaceId) {
    return all<Insight>(c, `SELECT * FROM insight WHERE workspace_id = ? ORDER BY created_at DESC`, workspaceId);
  }
  return all<Insight>(c, `SELECT * FROM insight ORDER BY created_at DESC LIMIT 200`);
}

export async function createInsight(c: Ctx, input: z.infer<typeof createInsightInput>): Promise<Insight> {
  const data = createInsightInput.parse(input);
  const iid = id("ins");
  const t = now();
  const isAi = c.actor.startsWith("ai:") ? 1 : 0;
  await c.db
    .prepare(
      `INSERT INTO insight (id, workspace_id, title, body, source_id, is_ai, actor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(iid, data.workspace_id ?? null, data.title, data.body, data.source_id ?? null, isAi, c.actor, t, t)
    .run();
  await ftsUpsert(c, "insight", iid, data.title, data.body);
  await logEvent(c, "create", "insight", iid, { title: data.title, source_id: data.source_id ?? null });
  // Embedding is best-effort and deterministic (Workers AI), when configured.
  if (c.env.JOBS) await c.env.JOBS.send({ type: "embed_insight", insight_id: iid });
  return (await getInsight(c, iid))!;
}
