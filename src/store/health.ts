// Workspace Health — the dumb, honest version. A function of recent activity and
// task flow, 0..100. No AI, no life-balancing judgment; that (the planning engine
// that rebalances a Daily 3 across neglected areas) is deferred. These numbers are
// the input it will eventually consume.
import { Ctx, all, first } from "./db";

export interface Health {
  workspace_id: string;
  score: number;
  open_tasks: number;
  done_tasks: number;
  last_activity: number | null;
  days_since_activity: number | null;
}

const DAY = 24 * 60 * 60 * 1000;

export async function workspaceHealth(c: Ctx, workspaceId: string): Promise<Health> {
  const tasks = await first<{ open: number; done: number }>(
    c,
    `SELECT SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
       FROM task WHERE workspace_id = ?`,
    workspaceId,
  );
  const last = await first<{ last_activity: number }>(
    c,
    `SELECT MAX(created_at) AS last_activity FROM event
      WHERE entity_type = 'workspace' AND entity_id = ?
         OR entity_id IN (SELECT id FROM task WHERE workspace_id = ?)`,
    workspaceId,
    workspaceId,
  );
  const open = tasks?.open ?? 0;
  const done = tasks?.done ?? 0;
  const lastActivity = last?.last_activity ?? null;
  const daysSince = lastActivity ? Math.floor((Date.now() - lastActivity) / DAY) : null;

  // Recency: full marks if touched today, decaying to 0 by ~14 days idle.
  const recency = daysSince === null ? 0 : Math.max(0, 1 - daysSince / 14);
  // Flow: reward finishing work; a workspace with only open tasks scores lower.
  const flow = open + done === 0 ? 0.5 : done / (open + done);
  const score = Math.round((recency * 0.6 + flow * 0.4) * 100);

  return { workspace_id: workspaceId, score, open_tasks: open, done_tasks: done, last_activity: lastActivity, days_since_activity: daysSince };
}

export async function allHealth(c: Ctx): Promise<Health[]> {
  const rows = await all<{ id: string }>(c, `SELECT id FROM workspace WHERE status = 'active'`);
  return Promise.all(rows.map((r) => workspaceHealth(c, r.id)));
}
