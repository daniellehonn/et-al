// Daily 3: exactly three tasks per day. Low volume, high commitment. Once
// confirmed the set is locked — finishing early does not grant more; tomorrow is
// a fresh set. Streak/consistency are derived, not stored.
import { z } from "zod";
import { setDaily3Input } from "../schema";
import { Ctx, RuleError, all, first, id, logEvent, now } from "./db";
import { getPage, properties, type Page } from "./pages";

export interface DailyFocusDay {
  date: string;
  confirmed_at: number | null;
  reflection: string | null;
  created_at: number;
}

export interface DailyFocusSlot {
  id: string;
  date: string;
  slot: number;
  page_id: string;
  status: string;
}

export interface Daily3 {
  date: string;
  confirmed: boolean;
  reflection: string | null;
  slots: Array<{ slot: number; status: string; task: (Page & { props: Record<string, unknown> }) | null }>;
  streak: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function streak(c: Ctx, upto: string): Promise<number> {
  // Count consecutive confirmed days ending at `upto`.
  const days = await all<DailyFocusDay>(c, `SELECT * FROM daily_focus_day WHERE confirmed_at IS NOT NULL AND date <= ? ORDER BY date DESC`, upto);
  let count = 0;
  const cursor = new Date(upto + "T00:00:00Z");
  for (const d of days) {
    if (d.date === cursor.toISOString().slice(0, 10)) {
      count++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    } else break;
  }
  return count;
}

export async function getDaily3(c: Ctx, date = today()): Promise<Daily3> {
  const day = await first<DailyFocusDay>(c, `SELECT * FROM daily_focus_day WHERE date = ?`, date);
  const slots = await all<DailyFocusSlot>(c, `SELECT * FROM daily_focus_slot WHERE date = ? ORDER BY slot`, date);
  const enriched = await Promise.all(
    slots.map(async (s) => {
      const page = await getPage(c, s.page_id);
      return { slot: s.slot, status: s.status, task: page ? { ...page, props: properties(page) } : null };
    }),
  );
  return {
    date,
    confirmed: !!day?.confirmed_at,
    reflection: day?.reflection ?? null,
    slots: enriched,
    streak: await streak(c, date),
  };
}

/** Set/replace the slots. Rejected once the day is confirmed (locked). */
export async function setDaily3(c: Ctx, input: z.infer<typeof setDaily3Input>): Promise<Daily3> {
  const data = setDaily3Input.parse(input);
  const date = data.date ?? today();
  const day = await first<DailyFocusDay>(c, `SELECT * FROM daily_focus_day WHERE date = ?`, date);
  if (day?.confirmed_at) throw new RuleError(`Daily 3 for ${date} is locked — tomorrow is a fresh set`);
  if (!day) {
    await c.db.prepare(`INSERT INTO daily_focus_day (date, created_at) VALUES (?, ?)`).bind(date, now()).run();
  }
  await c.db.prepare(`DELETE FROM daily_focus_slot WHERE date = ?`).bind(date).run();
  let slot = 1;
  for (const taskId of data.task_ids.slice(0, 3)) {
    await c.db
      .prepare(`INSERT INTO daily_focus_slot (id, date, slot, page_id, status) VALUES (?, ?, ?, ?, 'planned')`)
      .bind(id("dfs"), date, slot++, taskId)
      .run();
  }
  await logEvent(c, "update", "daily_focus", date, { task_ids: data.task_ids });
  return getDaily3(c, date);
}

export async function confirmDaily3(c: Ctx, date = today()): Promise<Daily3> {
  const day = await first<DailyFocusDay>(c, `SELECT * FROM daily_focus_day WHERE date = ?`, date);
  if (!day) throw new RuleError(`no Daily 3 set for ${date}`, 400);
  await c.db.prepare(`UPDATE daily_focus_day SET confirmed_at = ? WHERE date = ?`).bind(now(), date).run();
  await logEvent(c, "confirm", "daily_focus", date);
  return getDaily3(c, date);
}
