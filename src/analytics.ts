// Product analytics (spec §7.7) — first-party and local.
//
// These rows never leave the account. They exist to answer the product's own
// success questions, and one above all: the **weekly active transformation
// rate** — the share of weeks in which something captured actually became a
// project, note, tested tool, or content seed (§1.7).
//
// That metric is chosen precisely because it cannot be gamed by collecting more.
// So the events recorded here are transitions, not storage: a capture being
// saved is not a success, a capture becoming something is.

import { type Env, now } from "./store/index.ts";

/** Events the spec names in §7.7. */
export type AnalyticsEvent =
  | "capture_created"
  | "capture_processed"
  | "capture_triaged"
  | "project_activated"
  | "project_completed"
  | "project_log_created"
  | "tool_status_changed"
  | "knowledge_mastery_changed"
  | "content_seed_created"
  | "content_published"
  | "weekly_review_completed";

/** Events that represent a real transformation, for the north-star metric. */
const TRANSFORMATION_EVENTS: AnalyticsEvent[] = [
  "capture_triaged", "project_activated", "project_completed",
  "tool_status_changed", "knowledge_mastery_changed", "content_seed_created",
  "content_published",
];

/** ISO year-week, so weekly rollups are a GROUP BY rather than date maths. */
export function isoWeek(unix: number): string {
  const d = new Date(unix * 1000);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;         // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNumber + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Never throws: analytics must not be able to fail a user action. */
export async function track(
  env: Env, userId: string, event: AnalyticsEvent, properties: Record<string, unknown> = {},
): Promise<void> {
  const ts = now();
  try {
    await env.DB.prepare(
      "INSERT INTO analytics_events (user_id, event, properties, week, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(userId, event, JSON.stringify(properties), isoWeek(ts), ts).run();
  } catch { /* analytics is never load-bearing */ }
}

export interface Metrics {
  weeks_observed: number;
  weeks_with_transformation: number;
  /** The north-star (§1.7). */
  weekly_active_transformation_rate: number;
  active_project_next_action_coverage: number;
  tool_test_conversion: number;
  knowledge_application_rate: number;
  project_completion_rate: number;
  outputs_per_completed_project: number;
  event_counts: Record<string, number>;
}

/**
 * Computes the spec's success metrics (§1.7) from canonical rows plus the event
 * log. Ratios are reported as 0 when the denominator is zero rather than as
 * NaN or a flattering 100%.
 */
export async function getMetrics(env: Env, userId: string): Promise<Metrics> {
  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) / 100 : 0);

  const weeks = await env.DB.prepare(
    `SELECT week, SUM(CASE WHEN event IN (${TRANSFORMATION_EVENTS.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS t
     FROM analytics_events WHERE user_id = ? GROUP BY week`,
  ).bind(...TRANSFORMATION_EVENTS, userId).all<{ week: string; t: number }>();
  const weekRows = weeks.results ?? [];
  const withTransformation = weekRows.filter((w) => w.t > 0).length;

  const counts = await env.DB.prepare(
    "SELECT event, COUNT(*) AS n FROM analytics_events WHERE user_id = ? GROUP BY event",
  ).bind(userId).all<{ event: string; n: number }>();

  const one = async (sql: string) =>
    (await env.DB.prepare(sql).bind(userId).first<{ n: number }>())?.n ?? 0;

  const [activeTotal, activeWithAction, toolsTotal, toolsResolved,
         notesTotal, notesApplied, projectsTotal, projectsDone, outputs] = await Promise.all([
    one("SELECT COUNT(*) n FROM projects WHERE user_id = ? AND status = 'active'"),
    one("SELECT COUNT(*) n FROM projects WHERE user_id = ? AND status = 'active' AND next_action IS NOT NULL AND next_action <> ''"),
    one("SELECT COUNT(*) n FROM tools WHERE user_id = ?"),
    one("SELECT COUNT(*) n FROM tools WHERE user_id = ? AND status IN ('tested','adopted','rejected')"),
    one("SELECT COUNT(*) n FROM knowledge_notes WHERE user_id = ?"),
    one("SELECT COUNT(*) n FROM knowledge_notes WHERE user_id = ? AND mastery = 'applied'"),
    one("SELECT COUNT(*) n FROM projects WHERE user_id = ? AND status NOT IN ('idea','archived')"),
    one("SELECT COUNT(*) n FROM projects WHERE user_id = ? AND status = 'completed'"),
    one("SELECT COUNT(*) n FROM relations WHERE user_id = ? AND relation_type = 'created-from'"),
  ]);

  return {
    weeks_observed: weekRows.length,
    weeks_with_transformation: withTransformation,
    weekly_active_transformation_rate: ratio(withTransformation, weekRows.length),
    active_project_next_action_coverage: ratio(activeWithAction, activeTotal),
    tool_test_conversion: ratio(toolsResolved, toolsTotal),
    knowledge_application_rate: ratio(notesApplied, notesTotal),
    project_completion_rate: ratio(projectsDone, projectsTotal),
    outputs_per_completed_project: ratio(outputs, projectsDone),
    event_counts: Object.fromEntries((counts.results ?? []).map((r) => [r.event, r.n])),
  };
}
