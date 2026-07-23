// Identity Studio (spec §3.10).
//
// Explicitly *not* a decorative profile page. It answers "what story is my work
// telling" only from evidence already in the system — completed projects, tested
// tools, applied knowledge, published output. Nothing here is authored; if a
// claim has no evidence behind it, the honest answer is that it is missing, and
// that gap is the useful output.
//
// The spec defers "automated personal-brand analysis" (§7.3), so this stays
// deliberately mechanical: counts, recurring tags, and evidence links. Any
// interpretation is the user's, or Claude's over MCP.

import { desc, eq, and, inArray } from "drizzle-orm";
import {
  projects, projectAreas, projectLogs, knowledgeNotes, tools, contentItems, areas, goals, relations,
} from "./schema.ts";
import { type Env, getDb, now } from "./store/index.ts";

export interface IdentityStudio {
  period_days: number;
  themes: Array<{ area: string; projects: number; notes_applied: number; outputs: number }>;
  evidence: {
    completed_projects: Array<{ id: string; title: string; completed_at: number | null; outputs: number }>;
    applied_knowledge: Array<{ id: string; title: string; used_in: number }>;
    adopted_tools: Array<{ id: string; name: string; verdict: string | null }>;
    published: Array<{ id: string; title: string; channel: string | null; url: string | null }>;
  };
  portfolio_queue: Array<{ id: string; title: string; reason: string }>;
  gaps: string[];
}

/**
 * Builds the studio from the last `days` of activity.
 *
 * "Themes" are Life Areas ranked by real output, not by how much was filed under
 * them — an Area with twenty captures and nothing finished is not a theme.
 */
export async function getIdentityStudio(
  env: Env, userId: string, days = 180,
): Promise<IdentityStudio> {
  const db = getDb(env);
  const since = now() - days * 86400;

  const [areaRows, projectRows, noteRows, toolRows, contentRows, goalRows] = await Promise.all([
    db.select().from(areas).where(eq(areas.userId, userId)),
    db.select().from(projects).where(eq(projects.userId, userId)),
    db.select().from(knowledgeNotes).where(eq(knowledgeNotes.userId, userId)),
    db.select().from(tools).where(eq(tools.userId, userId)),
    db.select().from(contentItems).where(eq(contentItems.userId, userId)),
    db.select().from(goals).where(eq(goals.userId, userId)),
  ]);

  const membership = await db.select().from(projectAreas);
  const allRelations = await db.select().from(relations).where(eq(relations.userId, userId));

  const completed = projectRows.filter((p) => p.status === "completed" && (p.completedAt ?? 0) >= since);
  const published = contentRows.filter((c) => c.status === "published");
  const applied = noteRows.filter((n) => n.mastery === "applied");
  const adopted = toolRows.filter((t) => t.status === "adopted");

  // How many outputs each project produced, via `created-from` provenance.
  const outputsByProject = new Map<string, number>();
  for (const r of allRelations) {
    if (r.relationType !== "created-from" || !r.targetId) continue;
    outputsByProject.set(r.targetId, (outputsByProject.get(r.targetId) ?? 0) + 1);
  }
  const usedInByNote = new Map<string, number>();
  for (const r of allRelations) {
    if (r.sourceType !== "knowledge_note" || r.relationType !== "used-in") continue;
    usedInByNote.set(r.sourceId, (usedInByNote.get(r.sourceId) ?? 0) + 1);
  }

  const themes = areaRows.map((area) => {
    const projectIds = membership.filter((m) => m.areaId === area.id).map((m) => m.projectId);
    return {
      area: area.name,
      projects: projectRows.filter((p) => projectIds.includes(p.id) && p.status === "completed").length,
      notes_applied: applied.length && projectIds.length ? countNotesUsedIn(allRelations, projectIds) : 0,
      outputs: projectIds.reduce((sum, id) => sum + (outputsByProject.get(id) ?? 0), 0),
    };
  }).sort((a, b) => (b.projects + b.outputs) - (a.projects + a.outputs));

  // Work that is finished but has produced nothing shareable — the highest-value
  // thing the user could do next, and the reason this screen exists.
  const portfolioQueue = completed
    .filter((p) => (outputsByProject.get(p.id) ?? 0) === 0)
    .map((p) => ({
      id: p.id, title: p.title,
      reason: p.portfolioReady
        ? "Marked portfolio-ready but has no write-up yet"
        : "Completed with no case study, demo, or content",
    }));

  const gaps: string[] = [];
  if (!completed.length) gaps.push(`No projects completed in the last ${days} days.`);
  if (!published.length) gaps.push("Nothing published — completed work is not reaching an audience.");
  if (!applied.length) gaps.push("No knowledge notes at 'applied' — learning is not yet evidenced in projects.");
  if (portfolioQueue.length) gaps.push(`${portfolioQueue.length} completed project(s) have produced no output.`);
  const inactiveAreas = themes.filter((t) => t.projects === 0 && t.outputs === 0).map((t) => t.area);
  if (inactiveAreas.length) gaps.push(`No completed work in: ${inactiveAreas.join(", ")}.`);
  const goalsWithoutProjects = goalRows.filter(
    (g) => g.status === "active" && !allRelations.some((r) => r.targetId === g.id),
  );
  if (goalsWithoutProjects.length) {
    gaps.push(`${goalsWithoutProjects.length} active goal(s) have no project advancing them.`);
  }

  return {
    period_days: days,
    themes,
    evidence: {
      completed_projects: completed.map((p) => ({
        id: p.id, title: p.title, completed_at: p.completedAt,
        outputs: outputsByProject.get(p.id) ?? 0,
      })),
      applied_knowledge: applied.map((n) => ({
        id: n.id, title: n.title, used_in: usedInByNote.get(n.id) ?? 0,
      })),
      adopted_tools: adopted.map((t) => ({ id: t.id, name: t.name, verdict: t.verdict })),
      published: published.map((c) => ({
        id: c.id, title: c.title, channel: c.channel ?? null, url: c.publishedUrl,
      })),
    },
    portfolio_queue: portfolioQueue,
    gaps,
  };
}

function countNotesUsedIn(
  allRelations: Array<{ sourceType: string; relationType: string; targetId: string | null }>,
  projectIds: string[],
): number {
  return allRelations.filter(
    (r) => r.sourceType === "knowledge_note" && r.relationType === "used-in" &&
      r.targetId && projectIds.includes(r.targetId),
  ).length;
}

/**
 * The completion flow (spec §4.6). Completing a project should not be a silent
 * status change — it is the moment work becomes evidence, so this returns the
 * checklist of what is still missing.
 */
export async function getCompletionChecklist(
  env: Env, userId: string, projectId: string,
): Promise<{
  project_id: string;
  has_retrospective: boolean;
  learnings_to_promote: Array<{ id: string; title: string | null }>;
  reusable_decisions: number;
  outputs: number;
  suggestions: string[];
}> {
  const db = getDb(env);
  const logs = await db.select().from(projectLogs)
    .where(and(eq(projectLogs.userId, userId), eq(projectLogs.projectId, projectId)))
    .orderBy(desc(projectLogs.createdAt));

  const hasRetro = logs.some((l) => l.entryType === "reflection");
  const learnings = logs.filter((l) => l.entryType === "learning");
  const decisions = logs.filter((l) => l.entryType === "decision" || l.entryType === "experiment");

  const outputRels = await db.select().from(relations)
    .where(and(eq(relations.userId, userId), eq(relations.targetId, projectId)));
  const outputs = outputRels.filter((r) => r.relationType === "created-from").length;

  const suggestions: string[] = [];
  if (!hasRetro) suggestions.push("Write a retrospective log entry: what worked, what did not, what you would change.");
  if (learnings.length) suggestions.push(`Promote ${learnings.length} learning entr(y/ies) into durable knowledge notes.`);
  if (decisions.length) suggestions.push(`${decisions.length} decision/experiment entr(y/ies) are reusable evidence — worth a case study.`);
  if (!outputs) suggestions.push("No content or portfolio output yet. Create a content seed from this project.");

  return {
    project_id: projectId,
    has_retrospective: hasRetro,
    learnings_to_promote: learnings.map((l) => ({ id: l.id, title: l.title })),
    reusable_decisions: decisions.length,
    outputs,
    suggestions,
  };
}
