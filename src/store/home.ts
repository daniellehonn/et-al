// Home & review aggregates — "what should I do today?" and the weekly review's
// raw material. Both are deterministic; the agent reasons over them.
import { Ctx, all } from "./db";
import { getDaily3, type Daily3 } from "./daily";
import { allHealth, type Health } from "./health";
import { listInbox, type Source } from "./sources";
import { listWorkspaces, type Workspace } from "./workspaces";

export interface HomeView {
  daily3: Daily3;
  health: Health[];
  active_workspaces: Workspace[];
  inbox_count: number;
  recent_activity: RecentEvent[];
}

export interface RecentEvent {
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  created_at: number;
}

export async function getHome(c: Ctx): Promise<HomeView> {
  const [daily3, health, workspaces, inbox, recent] = await Promise.all([
    getDaily3(c),
    allHealth(c),
    listWorkspaces(c),
    listInbox(c),
    all<RecentEvent>(c, `SELECT id, actor, action, entity_type, entity_id, created_at FROM event ORDER BY created_at DESC LIMIT 20`),
  ]);
  return {
    daily3,
    health,
    active_workspaces: workspaces.filter((w) => w.status === "active"),
    inbox_count: inbox.length,
    recent_activity: recent,
  };
}

export interface WeeklyReview {
  inbox: Source[];
  stale_projects: Array<Health & { title: string }>;
  completed_this_week: RecentEvent[];
  health: Health[];
}

export async function getWeeklyReview(c: Ctx): Promise<WeeklyReview> {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const [inbox, health, completed, workspaces] = await Promise.all([
    listInbox(c),
    allHealth(c),
    all<RecentEvent>(c, `SELECT id, actor, action, entity_type, entity_id, created_at FROM event WHERE action = 'complete' AND created_at >= ? ORDER BY created_at DESC`, weekAgo),
    listWorkspaces(c),
  ]);
  const titles = new Map(workspaces.map((w) => [w.id, w.title]));
  const stale = health
    .filter((h) => (h.days_since_activity ?? 999) >= 7 && h.open_tasks > 0)
    .map((h) => ({ ...h, title: titles.get(h.workspace_id) ?? h.workspace_id }));
  return { inbox, stale_projects: stale, completed_this_week: completed, health };
}

export function getAgentActivity(c: Ctx, limit = 50): Promise<RecentEvent[]> {
  return all<RecentEvent>(c, `SELECT id, actor, action, entity_type, entity_id, created_at FROM event WHERE actor LIKE 'ai:%' ORDER BY created_at DESC LIMIT ?`, limit);
}
