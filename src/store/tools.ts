// Tools — the Test Later catalog.
//
// The whole point of this entity is to stop a saved link from being the end of
// the story. Two rules are enforced here rather than left to the UI, because
// they are what prevent the library becoming a graveyard (spec §3.6, §7.8):
//
//   1. **A written verdict is required** before a tool may reach tested,
//      adopted, or rejected. A star rating is not a verdict.
//   2. **An expected use is required** before shortlisting. If you cannot say
//      why it might be useful, it stays in `saved` where it belongs.

import { desc, eq, and } from "drizzle-orm";
import { tools, TOOL_STATUS, TOOL_VERDICT_REQUIRED, type ToolStatus } from "../schema.ts";
import {
  type Env, getDb, now, newId, requireText, optionalText, optionalEnum, requireEnum,
  clampInt, audit, NotFoundError, ValidationError, removeFts,
} from "./db.ts";

export interface ToolInput {
  name?: string;
  url?: string | null;
  status?: string;
  expected_use?: string | null;
  test_criteria?: string | null;
  verdict?: string | null;
  rating?: number | null;
  source_id?: string | null;
}

export interface ToolDoc {
  id: string;
  name: string;
  url: string | null;
  status: ToolStatus;
  expected_use: string | null;
  test_criteria: string | null;
  verdict: string | null;
  rating: number | null;
  source_id: string | null;
  tested_at: number | null;
  created_at: number;
  updated_at: number;
}

/** The prompt each transition should ask for (spec §3.6). */
export const TOOL_PROMPTS: Record<string, string[]> = {
  shortlisted: ["Why might this be useful?"],
  testing: ["What are you trying to accomplish?", "Which project could benefit?", "What defines success?"],
  tested: ["What worked?", "What failed?", "Would you use it again?", "What did you learn?"],
  adopted: ["Record a concise verdict and evidence."],
  rejected: ["Record a concise verdict and evidence."],
};

function view(row: typeof tools.$inferSelect): ToolDoc {
  return {
    id: row.id, name: row.name, url: row.url, status: row.status,
    expected_use: row.expectedUse, test_criteria: row.testCriteria,
    verdict: row.verdict, rating: row.rating, source_id: row.sourceId,
    tested_at: row.testedAt, created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

function assertTransition(status: ToolStatus, expectedUse: string | null, verdict: string | null): void {
  if (status === "shortlisted" && !expectedUse) {
    throw new ValidationError(
      "Shortlisting needs an expected_use: say why this might be useful before promoting it.",
    );
  }
  if (TOOL_VERDICT_REQUIRED.includes(status) && !verdict) {
    throw new ValidationError(
      `Status '${status}' requires a written verdict: what worked, what failed, would you use it again?`,
    );
  }
}

export interface ToolListOptions {
  status?: string | null;
  limit?: number;
}

export async function listTools(env: Env, userId: string, opts: ToolListOptions = {}): Promise<ToolDoc[]> {
  const filters = [eq(tools.userId, userId)];
  if (opts.status) filters.push(eq(tools.status, requireEnum(opts.status, TOOL_STATUS, "status")));
  const rows = await getDb(env).select().from(tools).where(and(...filters))
    .orderBy(desc(tools.updatedAt)).limit(Math.min(opts.limit ?? 100, 500));
  return rows.map(view);
}

export async function getTool(env: Env, userId: string, id: string): Promise<ToolDoc | null> {
  const rows = await getDb(env).select().from(tools)
    .where(and(eq(tools.id, id), eq(tools.userId, userId))).limit(1);
  return rows[0] ? view(rows[0]) : null;
}

export async function createTool(env: Env, userId: string, input: ToolInput): Promise<ToolDoc> {
  const status = (optionalEnum(input.status, TOOL_STATUS, "status") ?? "saved") as ToolStatus;
  const expectedUse = optionalText(input.expected_use);
  const verdict = optionalText(input.verdict);
  assertTransition(status, expectedUse, verdict);

  const ts = now();
  const row = {
    id: newId(), userId,
    name: requireText(input.name, "name"),
    url: optionalText(input.url),
    status, expectedUse,
    testCriteria: optionalText(input.test_criteria),
    verdict,
    rating: input.rating == null ? null : clampInt(input.rating, 1, 5, 3),
    sourceId: optionalText(input.source_id),
    testedAt: TOOL_VERDICT_REQUIRED.includes(status) ? ts : null,
    createdAt: ts, updatedAt: ts,
  };
  await getDb(env).insert(tools).values(row);
  await audit(env, { userId, subjectType: "tool", subjectId: row.id, action: "created" });
  return view(row as typeof tools.$inferSelect);
}

export async function updateTool(env: Env, userId: string, id: string, input: ToolInput): Promise<ToolDoc> {
  const current = await getTool(env, userId, id);
  if (!current) throw new NotFoundError(`Tool not found: ${id}`);

  const status = input.status !== undefined
    ? requireEnum(input.status, TOOL_STATUS, "status")
    : current.status;
  const expectedUse = input.expected_use !== undefined ? optionalText(input.expected_use) : current.expected_use;
  const verdict = input.verdict !== undefined ? optionalText(input.verdict) : current.verdict;
  assertTransition(status, expectedUse, verdict);

  const ts = now();
  const patch: Partial<typeof tools.$inferInsert> = { updatedAt: ts };
  if (input.name !== undefined) patch.name = requireText(input.name, "name");
  if (input.url !== undefined) patch.url = optionalText(input.url);
  if (input.expected_use !== undefined) patch.expectedUse = expectedUse;
  if (input.test_criteria !== undefined) patch.testCriteria = optionalText(input.test_criteria);
  if (input.verdict !== undefined) patch.verdict = verdict;
  if (input.rating !== undefined) patch.rating = input.rating == null ? null : clampInt(input.rating, 1, 5, 3);
  if (input.source_id !== undefined) patch.sourceId = optionalText(input.source_id);

  const statusChanged = status !== current.status;
  if (statusChanged) {
    patch.status = status;
    // Stamp the moment a verdict was reached; it drives review + content prompts.
    if (TOOL_VERDICT_REQUIRED.includes(status) && !current.tested_at) patch.testedAt = ts;
  }

  await getDb(env).update(tools).set(patch).where(and(eq(tools.id, id), eq(tools.userId, userId)));
  await audit(env, {
    userId, subjectType: "tool", subjectId: id,
    action: statusChanged ? "status-changed" : "updated",
    detail: statusChanged ? { from: current.status, to: status } : {},
  });
  return (await getTool(env, userId, id))!;
}

export async function deleteTool(env: Env, userId: string, id: string): Promise<boolean> {
  const current = await getTool(env, userId, id);
  if (!current) return false;
  await getDb(env).delete(tools).where(and(eq(tools.id, id), eq(tools.userId, userId)));
  await removeFts(env, id);
  await audit(env, { userId, subjectType: "tool", subjectId: id, action: "deleted" });
  return true;
}

/** Tools stuck mid-test — the Home "test queue" and a weekly-review step. */
export async function listTestQueue(env: Env, userId: string): Promise<ToolDoc[]> {
  const rows = await getDb(env).select().from(tools)
    .where(and(eq(tools.userId, userId), eq(tools.status, "testing")))
    .orderBy(desc(tools.updatedAt));
  return rows.map(view);
}
