// Proactive messages: ask for tomorrow's Daily 3 in the evening, send it back in
// the morning.
//
// This is the first thing in et al. that starts a conversation rather than
// answering one. It is still not an agent loop — there is no model deciding what
// to do, just two scheduled prompts and a parser for the reply — but it is the
// piece that makes the system feel like it is paying attention.
import type { Env } from "./schema";
import * as store from "./store";

const APP_URL = "https://et-al.daniellehonnn.workers.dev";

/** The hour where the user actually is.
 *
 *  Cloudflare crons are UTC only, so a fixed UTC hour drifts by one across a DST
 *  boundary and the evening nudge would arrive at the wrong time for half the
 *  year. Running hourly and asking what time it is locally is DST-correct
 *  without any offset arithmetic. */
function localHour(env: Env): number {
  const tz = env.TIMEZONE ?? "America/Los_Angeles";
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date());
  return Number(h) % 24;
}

function localDate(env: Env): string {
  const tz = env.TIMEZONE ?? "America/Los_Angeles";
  // en-CA formats as YYYY-MM-DD, which is the shape daily_focus_day stores.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

export async function send(env: Env, text: string): Promise<void> {
  const to = env.SENDBLUE_OWNER_NUMBER;
  if (!to || !env.SENDBLUE_API_KEY_ID || !env.SENDBLUE_API_SECRET) return;
  await fetch("https://api.sendblue.co/api/send-message", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sb-api-key-id": env.SENDBLUE_API_KEY_ID,
      "sb-api-secret-key": env.SENDBLUE_API_SECRET,
    },
    body: JSON.stringify({ number: to, content: text.slice(0, 1400) }),
  }).catch(() => { /* best-effort */ });
}

/** Nudges are logged so an hourly cron cannot send the same one twice — a
 *  duplicate wake-up is worse than a missed one. */
async function alreadySent(c: store.Ctx, kind: string, date: string): Promise<boolean> {
  const row = await store.first<{ id: string }>(
    c, `SELECT id FROM event WHERE action = 'nudge' AND entity_id = ? LIMIT 1`, `${kind}:${date}`,
  );
  return !!row;
}

async function markSent(c: store.Ctx, kind: string, date: string): Promise<void> {
  await store.logEvent(c, "nudge", "page", `${kind}:${date}`, { kind, date });
}

export async function runNudges(env: Env): Promise<void> {
  const c = store.ctx(env, "ai:et-al");
  const hour = localHour(env);
  const date = localDate(env);
  const evening = Number(env.NUDGE_EVENING_HOUR ?? 20); // 8pm local
  const morning = Number(env.NUDGE_MORNING_HOUR ?? 7);  // 7am local

  if (hour === evening && !(await alreadySent(c, "evening", date))) {
    // Offered with candidates rather than a blank prompt: choosing from what is
    // already open is a smaller ask than remembering what matters.
    const open = await store.openTasks(c, 5);
    const list = open.length
      ? `\n\nOpen right now:\n${open.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`
      : "";
    await send(env, `Evening check-in. What are your three for tomorrow?${list}\n\nReply with three lines, or numbers from the list.`);
    await markSent(c, "evening", date);
    return;
  }

  if (hour === morning && !(await alreadySent(c, "morning", date))) {
    const daily = await store.getDaily3(c, date);
    const set = daily.slots.filter((s) => s.task);
    const body = set.length
      ? set.map((s) => `${s.slot}. ${s.task!.title}`).join("\n")
      : "Nothing set — reply with three lines to choose them now.";
    const streak = daily.streak > 0 ? `\n\n${daily.streak}-day streak.` : "";
    await send(env, `Morning. Today's three:\n\n${body}${streak}\n\n${APP_URL}`);
    await markSent(c, "morning", date);
  }
}

/** Parse a reply to the evening nudge into three tasks.
 *
 *  Matches against open tasks first — "1" or a few words of an existing title —
 *  and only creates a task when nothing matches, so replying to the nudge does
 *  not quietly fill the workspace with near-duplicates. */
export async function trySetDailyThree(c: store.Ctx, env: Env, text: string): Promise<boolean> {
  // Only when a reply is actually expected. Without this gate any short message
  // would be read as a Daily 3, and every note texted in would silently become
  // a task — the parser is permissive precisely because the context is narrow.
  const date = localDate(env);
  if (!(await alreadySent(c, "evening", date))) return false;
  const d0 = new Date(`${date}T12:00:00Z`);
  d0.setUTCDate(d0.getUTCDate() + 1);
  const tomorrow = d0.toISOString().slice(0, 10);
  const existing = await store.getDaily3(c, tomorrow);
  // Already answered tonight: treat further messages as ordinary captures.
  if (existing.slots.some((s) => s.task)) return false;

  const lines = text.split(/\n|;/).map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 3) return false;
  // A message with a link is something you are keeping, not a plan.
  if (/https?:\/\//.test(text)) return false;

  const open = await store.openTasks(c, 25);
  const chosen: string[] = [];

  for (const line of lines) {
    // A bare number refers to the numbered list the nudge sent.
    const asIndex = /^\d+$/.test(line.trim()) ? Number(line.trim()) : null;
    if (asIndex && open[asIndex - 1]) { chosen.push(open[asIndex - 1].id); continue; }

    const needle = line.toLowerCase();
    const match = open.find((t) => t.title.toLowerCase().includes(needle) || needle.includes(t.title.toLowerCase()));
    if (match) { chosen.push(match.id); continue; }

    // Nothing matched, so this is a new intention. It needs somewhere to live;
    // the page that already owns the most tasks is the least surprising home.
    const host = open[0]?.owner_page_id ?? (await store.inboxPage(c)).id;
    const created = await store.createTask(c, { page_id: host, title: line, workspace_id: host });
    chosen.push(created.id);
  }

  if (!chosen.length) return false;
  await store.setDaily3(c, { date: tomorrow, task_ids: chosen.slice(0, 3) });
  return true;
}
