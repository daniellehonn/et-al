// Page Health — the dumb, honest version. A function of recent activity and task
// flow, 0..100. No AI, no life-balancing judgment; that (the planning engine that
// rebalances a Daily 3 across neglected areas) is deferred. These numbers are the
// input it will eventually consume.
//
// v8 note: "a page's tasks" now means the rows of the Tasks collection it owns,
// so health is scoped to a page rather than a workspace — and any page can have
// one, which is the point of the restructure.
import { Ctx, all, first } from "./db";
import { listTasks } from "./roles";

export interface Health {
  page_id: string;
  score: number;
  open_tasks: number;
  done_tasks: number;
  last_activity: number | null;
  days_since_activity: number | null;
}

const DAY = 24 * 60 * 60 * 1000;

export async function pageHealth(c: Ctx, pageId: string): Promise<Health> {
  const tasks = await listTasks(c, { pageId });
  const done = tasks.filter((t) => t.props.status === "done").length;
  const open = tasks.length - done;

  // Activity means the page itself or anything filed under it — otherwise a
  // project worked on entirely through its tasks would look abandoned.
  const ids = [pageId, ...tasks.map((t) => t.id)];
  const marks = ids.map(() => "?").join(",");
  const last = await first<{ last_activity: number | null }>(
    c,
    `SELECT MAX(created_at) AS last_activity FROM event WHERE entity_id IN (${marks})`,
    ...ids,
  );
  const lastActivity = last?.last_activity ?? null;
  const daysSince = lastActivity ? Math.floor((Date.now() - lastActivity) / DAY) : null;

  // Recency: full marks if touched today, decaying to 0 by ~14 days idle.
  const recency = daysSince === null ? 0 : Math.max(0, 1 - daysSince / 14);
  // Flow: reward finishing work; a page with only open tasks scores lower.
  const flow = open + done === 0 ? 0.5 : done / (open + done);
  const score = Math.round((recency * 0.6 + flow * 0.4) * 100);

  return { page_id: pageId, score, open_tasks: open, done_tasks: done, last_activity: lastActivity, days_since_activity: daysSince };
}

/** Health for every page that actually owns tasks — scoring pages that have no
 *  work attached would just produce a list of zeroes. */
export async function allHealth(c: Ctx): Promise<Health[]> {
  const rows = await all<{ id: string }>(
    c,
    `SELECT DISTINCT p.id FROM page p
       JOIN collection col ON col.parent_page_id = p.id AND col.role = 'tasks'
      WHERE p.status = 'active'`,
  );
  return Promise.all(rows.map((r) => pageHealth(c, r.id)));
}

/** Kept under the old name so existing callers and agent tools keep resolving. */
export const workspaceHealth = pageHealth;
