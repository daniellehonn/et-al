// Decisions: immutable "we chose X because Y" events. Write-once.
import { z } from "zod";
import { recordDecisionInput } from "../schema";
import { Ctx, all, first, ftsUpsert, id, logEvent, now } from "./db";

export interface Decision {
  id: string;
  workspace_id: string;
  title: string;
  rationale: string;
  alternatives_json: string | null;
  impact: string | null;
  decided_on: number;
  actor: string;
  created_at: number;
}

export function listDecisions(c: Ctx, workspaceId: string): Promise<Decision[]> {
  return all<Decision>(c, `SELECT * FROM decision WHERE workspace_id = ? ORDER BY decided_on DESC`, workspaceId);
}

export function getDecision(c: Ctx, did: string): Promise<Decision | null> {
  return first<Decision>(c, `SELECT * FROM decision WHERE id = ?`, did);
}

export async function recordDecision(c: Ctx, input: z.infer<typeof recordDecisionInput>): Promise<Decision> {
  const data = recordDecisionInput.parse(input);
  const did = id("dec");
  const t = now();
  await c.db
    .prepare(
      `INSERT INTO decision (id, workspace_id, title, rationale, alternatives_json, impact, decided_on, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(did, data.workspace_id, data.title, data.rationale, data.alternatives ? JSON.stringify(data.alternatives) : null, data.impact ?? null, data.decided_on ?? t, c.actor, t)
    .run();
  await ftsUpsert(c, "decision", did, data.title, data.rationale);
  await logEvent(c, "create", "decision", did, { title: data.title });
  return (await getDecision(c, did))!;
}
