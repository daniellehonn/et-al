// Automations: user-defined recurring work.
//
// The Daily 3 nudges are two prompts hard-coded into nudge.ts. This generalises
// them, so "every Friday at 5, tell me what I shipped this week" is a row rather
// than a code change.
//
// Cron is evaluated here rather than by a library: Workers have no cron parser
// in the runtime, the expressions a person writes for themselves are simple, and
// a dependency that only ever sees five-field expressions is not worth carrying.
import { Ctx, RuleError, all, first, id, logEvent, now } from "./db";

export interface Automation {
  id: string;
  name: string;
  schedule: string;
  timezone: string;
  task: string;
  action: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export function listAutomations(c: Ctx, enabledOnly = false): Promise<Automation[]> {
  return enabledOnly
    ? all<Automation>(c, `SELECT * FROM automation WHERE enabled = 1 ORDER BY created_at`)
    : all<Automation>(c, `SELECT * FROM automation ORDER BY created_at`);
}

export function getAutomation(c: Ctx, aid: string): Promise<Automation | null> {
  return first<Automation>(c, `SELECT * FROM automation WHERE id = ?`, aid);
}

// ---- cron ------------------------------------------------------------------

interface Fields { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number> }

/** Expand one cron field: a star, `a,b`, `a-b`, step syntax, and combinations. */
function expand(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step < 1) continue;
    let from = lo, to = hi;
    if (range !== "*" && range !== "") {
      const [a, b] = range.split("-");
      from = Number(a);
      to = b === undefined ? Number(a) : Number(b);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      // A single value with a step still runs to the end of the range:
      // "star slash 15" and "5 slash 15" both mean "from here, every 15".
      if (b === undefined && stepRaw) to = hi;
    }
    for (let v = from; v <= to; v += step) if (v >= lo && v <= hi) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Fields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mon, dow] = parts;
  const f = {
    min: expand(mi, 0, 59), hour: expand(h, 0, 23), dom: expand(dom, 1, 31),
    mon: expand(mon, 1, 12), dow: expand(dow.replace(/7/g, "0"), 0, 6),
  };
  if (Object.values(f).some((s) => s.size === 0)) return null;
  return f;
}

/** The wall-clock fields of an instant, in a given zone. */
function partsIn(ts: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", weekday: "short", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(new Date(ts))) p[type] = value;
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: Number(p.minute), hour: Number(p.hour) % 24,
    day: Number(p.day), month: Number(p.month), dow: dowMap[p.weekday] ?? 0,
  };
}

/** Standard cron semantics: when both day-of-month and day-of-week are
 *  restricted, either matching is enough. */
function matches(f: Fields, ts: number, tz: string): boolean {
  const p = partsIn(ts, tz);
  if (!f.min.has(p.minute) || !f.hour.has(p.hour) || !f.mon.has(p.month)) return false;
  const domAll = f.dom.size === 31;
  const dowAll = f.dow.size === 7;
  if (domAll && dowAll) return true;
  if (domAll) return f.dow.has(p.dow);
  if (dowAll) return f.dom.has(p.day);
  return f.dom.has(p.day) || f.dow.has(p.dow);
}

const MINUTE = 60_000;

/** The next matching instant after `from`, scanned minute by minute.
 *
 *  Brute force over a bounded horizon rather than date arithmetic: it is
 *  correct across DST transitions for free, because every candidate is tested
 *  in the user's own zone. A year of minutes is the cutoff — an expression with
 *  no match inside a year is a mistake worth surfacing rather than looping on. */
export function nextRun(expr: string, tz: string, from = Date.now()): number | null {
  const f = parseCron(expr);
  if (!f) return null;
  let ts = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  const limit = from + 366 * 24 * 60 * MINUTE;
  while (ts < limit) {
    if (matches(f, ts, tz)) return ts;
    ts += MINUTE;
  }
  return null;
}

// ---- CRUD ------------------------------------------------------------------

export async function createAutomation(
  c: Ctx,
  input: { name: string; schedule: string; task: string; timezone?: string; action?: string },
): Promise<Automation> {
  const tz = input.timezone ?? "America/Los_Angeles";
  const next = nextRun(input.schedule, tz);
  if (next === null) {
    throw new RuleError(`"${input.schedule}" is not a 5-field cron expression that matches within a year`, 400);
  }
  const aid = id("aut");
  const t = now();
  await c.db
    .prepare(`INSERT INTO automation (id, name, schedule, timezone, task, action, enabled, next_run_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .bind(aid, input.name, input.schedule, tz, input.task, input.action ?? "message", next, t, t)
    .run();
  await logEvent(c, "create", "page", aid, { automation: input.name, schedule: input.schedule });
  return (await getAutomation(c, aid))!;
}

export async function updateAutomation(
  c: Ctx, aid: string,
  patch: { name?: string; schedule?: string; task?: string; enabled?: boolean; timezone?: string },
): Promise<Automation> {
  const existing = await getAutomation(c, aid);
  if (!existing) throw new RuleError(`automation ${aid} not found`, 404);
  const schedule = patch.schedule ?? existing.schedule;
  const tz = patch.timezone ?? existing.timezone;
  // Recomputed whenever the schedule or zone changes, or the row would keep
  // firing on the old rhythm until its next tick.
  const next = (patch.schedule || patch.timezone) ? nextRun(schedule, tz) : existing.next_run_at;
  if (next === null) throw new RuleError(`"${schedule}" is not a valid cron expression`, 400);
  await c.db
    .prepare(`UPDATE automation SET name = ?, schedule = ?, timezone = ?, task = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
    .bind(patch.name ?? existing.name, schedule, tz, patch.task ?? existing.task,
          patch.enabled === undefined ? existing.enabled : (patch.enabled ? 1 : 0), next, now(), aid)
    .run();
  return (await getAutomation(c, aid))!;
}

export async function deleteAutomation(c: Ctx, aid: string): Promise<void> {
  await c.db.prepare(`DELETE FROM automation_run WHERE automation_id = ?`).bind(aid).run();
  await c.db.prepare(`DELETE FROM automation WHERE id = ?`).bind(aid).run();
  await logEvent(c, "delete", "page", aid, { automation: true });
}

/** Automations whose time has come. */
export function dueAutomations(c: Ctx): Promise<Automation[]> {
  return all<Automation>(
    c, `SELECT * FROM automation WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`, now(),
  );
}

/** Record the outcome and schedule the next occurrence.
 *
 *  next_run_at advances from now rather than from the scheduled time, so an
 *  automation that was missed while the Worker was idle does not then fire
 *  repeatedly to catch up. */
export async function recordRun(c: Ctx, a: Automation, status: "ok" | "error", result: string): Promise<void> {
  const t = now();
  await c.db
    .prepare(`INSERT INTO automation_run (id, automation_id, status, result, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id("aur"), a.id, status, result.slice(0, 2000), t)
    .run();
  const next = nextRun(a.schedule, a.timezone, t);
  await c.db
    .prepare(`UPDATE automation SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
    .bind(t, next, t, a.id)
    .run();
}

export function automationRuns(c: Ctx, aid: string, limit = 20) {
  return all(c, `SELECT * FROM automation_run WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?`, aid, limit);
}
