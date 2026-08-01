// Home & review aggregates — "what should I do today?" and the weekly review's
// raw material. Both are deterministic; the agent reasons over them.
import { Ctx, all } from "./db";
import { getDaily3, type Daily3 } from "./daily";
import { allHealth, type Health } from "./health";
import { listInbox, type RoleRow } from "./roles";
import { listChildren, subtreeIds, type Page } from "./pages";

export interface HomeView {
  daily3: Daily3;
  health: Health[];
  root_pages: Page[];
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
  const [daily3, health, roots, inbox, recent] = await Promise.all([
    getDaily3(c),
    allHealth(c),
    listChildren(c, null),
    listInbox(c),
    all<RecentEvent>(c, `SELECT id, actor, action, entity_type, entity_id, created_at FROM event ORDER BY created_at DESC LIMIT 20`),
  ]);
  return {
    daily3,
    health,
    root_pages: roots.filter((p) => p.status === "active"),
    inbox_count: inbox.length,
    recent_activity: recent,
  };
}

export interface WeeklyReview {
  inbox: RoleRow[];
  stale_projects: Array<Health & { title: string }>;
  completed_this_week: RecentEvent[];
  health: Health[];
}

export async function getWeeklyReview(c: Ctx): Promise<WeeklyReview> {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const [inbox, health, completed, titles] = await Promise.all([
    listInbox(c),
    allHealth(c),
    all<RecentEvent>(c, `SELECT id, actor, action, entity_type, entity_id, created_at FROM event WHERE action = 'complete' AND created_at >= ? ORDER BY created_at DESC`, weekAgo),
    all<{ id: string; title: string }>(c, `SELECT id, title FROM page WHERE collection_id IS NULL`),
  ]);
  const byId = new Map(titles.map((t) => [t.id, t.title]));
  const stale = health
    .filter((h) => (h.days_since_activity ?? 999) >= 7 && h.open_tasks > 0)
    .map((h) => ({ ...h, title: byId.get(h.page_id) ?? h.page_id }));
  return { inbox, stale_projects: stale, completed_this_week: completed, health };
}

/** Every event touching a page, anything nested under it, or any row in a
 *  collection it owns. In v7 this was a union of six per-table subqueries; with
 *  one primitive it is one id set. */
export async function getPageTimeline(c: Ctx, pageId: string, limit = 60): Promise<RecentEvent[]> {
  const ids = await subtreeIds(c, pageId);
  const marks = ids.map(() => "?").join(",");
  const rows = await all<{ id: string }>(
    c,
    `SELECT p.id FROM page p JOIN collection col ON p.collection_id = col.id
      WHERE col.parent_page_id IN (${marks})`,
    ...ids,
  );
  const allIds = [...ids, ...rows.map((r) => r.id)];
  const allMarks = allIds.map(() => "?").join(",");
  return all<RecentEvent>(
    c,
    `SELECT id, actor, action, entity_type, entity_id, created_at FROM event
      WHERE entity_id IN (${allMarks}) ORDER BY created_at DESC LIMIT ?`,
    ...allIds, limit,
  );
}

/** Kept under the old name so existing callers keep resolving. */
export const getWorkspaceTimeline = getPageTimeline;

export function getAgentActivity(c: Ctx, limit = 50): Promise<RecentEvent[]> {
  return all<RecentEvent>(c, `SELECT id, actor, action, entity_type, entity_id, created_at FROM event WHERE actor LIKE 'ai:%' ORDER BY created_at DESC LIMIT ?`, limit);
}
