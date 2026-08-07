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

/** The planning ask. Offered with candidates rather than as a blank prompt:
 *  choosing from what is already open is a smaller ask than remembering what
 *  matters at 8pm. */
function planningPrompt(open: Array<{ title: string }>): string {
  const list = open.length
    ? `\n\nOpen right now:\n${open.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`
    : "";
  return `What are your three for tomorrow?${list}\n\nReply with three lines, or numbers from the list.`;
}

/** Send, and say whether it worked.
 *
 *  The first version swallowed every failure, so an automation could report
 *  "ok" having sent nothing at all — which is exactly the state that made the
 *  outbound path impossible to verify. */
export async function send(env: Env, text: string): Promise<{ ok: boolean; detail: string }> {
  const to = env.SENDBLUE_OWNER_NUMBER;
  if (!to) return { ok: false, detail: "SENDBLUE_OWNER_NUMBER not set" };
  if (!env.SENDBLUE_API_KEY_ID || !env.SENDBLUE_API_SECRET) {
    return { ok: false, detail: "Sendblue API credentials not set" };
  }
  try {
    const res = await fetch("https://api.sendblue.co/api/send-message", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-api-key-id": env.SENDBLUE_API_KEY_ID,
        "sb-api-secret-key": env.SENDBLUE_API_SECRET,
      },
      body: JSON.stringify({ number: to, content: text.slice(0, 1400) }),
    });
    const body = await res.text();
    return { ok: res.ok, detail: `${res.status} ${body.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
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
  await runAutomations(c, env);
  const hour = localHour(env);
  const date = localDate(env);
  const evening = Number(env.NUDGE_EVENING_HOUR ?? 20); // 8pm local
  const morning = Number(env.NUDGE_MORNING_HOUR ?? 7);  // 7am local

  if (hour === evening && !(await alreadySent(c, "evening", date))) {
    // Close today before opening tomorrow. If a Daily 3 was set, the evening
    // starts by asking how it went; the planning question follows the answer
    // rather than arriving alongside it, because two questions in one message
    // get one answer.
    const todayD3 = await store.getDaily3(c, date);
    const live = todayD3.slots.filter((s) => s.task);
    if (live.length && !todayD3.reflection) {
      const lines = live.map((s) => `${s.slot}. ${s.task!.title}`).join("\n");
      await send(env, `Evening check-in. Today you set:\n\n${lines}\n\nWhich did you finish? Reply with numbers, "all", or "none" — and anything you want to note about the day.`);
      await markSent(c, "evening", date);
      return;
    }
    // Nothing to reflect on, so go straight to planning.
    await send(env, planningPrompt(await store.openTasks(c, 5)));
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

/** Fire any automation whose time has come.
 *
 *  Each one is independent, so a failure is recorded against that automation
 *  and the rest still run — one broken schedule must not silence the others. */
async function runAutomations(c: store.Ctx, env: Env): Promise<void> {
  let due: store.Automation[] = [];
  try { due = await store.dueAutomations(c); } catch { return; }

  for (const a of due) {
    try {
      const body = await renderAutomation(c, a);
      if (!body) { await store.recordRun(c, a, "ok", "(nothing to say)"); continue; }
      const sent = await send(env, body);
      // The send result decides the status: a run that reported ok while the
      // message never left is worse than no automation at all.
      await store.recordRun(c, a, sent.ok ? "ok" : "error", sent.ok ? body : `send failed: ${sent.detail}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await store.recordRun(c, a, "error", msg);
    }
  }
}

/** What an automation actually says.
 *
 *  Deliberately deterministic for now: `digest` assembles real state, `message`
 *  sends the task text verbatim. Neither calls a model — that arrives with the
 *  agent loop, and until then an automation that reliably says a true thing
 *  beats one that improvises. */
async function renderAutomation(c: store.Ctx, a: store.Automation): Promise<string | null> {
  if (a.action === "digest") {
    const [open, review] = await Promise.all([
      store.openTasks(c, 5),
      store.listPendingPatches(c),
    ]);
    const lines: string[] = [a.task];
    if (open.length) lines.push("", "Open:", ...open.map((t, i) => `${i + 1}. ${t.title}`));
    if (review.length) lines.push("", `${review.length} awaiting review.`);
    return lines.join("\n");
  }
  return a.task;
}

/** Parse a reply to the reflection ask.
 *
 *  Runs before the planning parser, since "1 and 3" means "I finished those"
 *  tonight and "make those my three" only after the day is closed. Returns true
 *  when it handled the message, and sends the planning question itself so the
 *  conversation moves on in one exchange. */
export async function tryRecordReflection(c: store.Ctx, env: Env, text: string): Promise<boolean> {
  const date = localDate(env);
  if (!(await alreadySent(c, "evening", date))) return false;

  const d3 = await store.getDaily3(c, date);
  const live = d3.slots.filter((s) => s.task);
  // Nothing was committed today, or the day is already closed.
  if (!live.length || d3.reflection) return false;
  // A link is something you are keeping, not a reflection.
  if (/https?:\/\//.test(text)) return false;

  const lower = text.toLowerCase();
  let done: number[] = [];
  if (/\b(all|everything|all three|all of them|yes)\b/.test(lower)) {
    done = live.map((s) => s.slot);
  } else if (/\b(none|nothing|no|zero)\b/.test(lower)) {
    done = [];
  } else {
    // Bare numbers anywhere in the message: "1 and 3", "did 2", "1,2".
    const nums = [...lower.matchAll(/\b([1-3])\b/g)].map((m) => Number(m[1]));
    if (!nums.length) return false; // not a reflection — let the other handlers try
    done = [...new Set(nums)].filter((n) => live.some((s) => s.slot === n));
  }

  await store.recordReflection(c, date, text, done);

  const carried = live.filter((s) => !done.includes(s.slot)).map((s) => s.task!.title);
  const note = done.length === live.length
    ? "All three. Nice."
    : done.length === 0
      ? "Noted — none closed out."
      : `${done.length} of ${live.length} done.`;
  const carry = carried.length ? `\n\nStill open: ${carried.join(", ")}` : "";
  await send(env, `${note}${carry}\n\n${planningPrompt(await store.openTasks(c, 5))}`);
  return true;
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
  // Today has to be closed before tomorrow is planned, or a reflection reply
  // would be read as a plan.
  const todayD3 = await store.getDaily3(c, date);
  if (todayD3.slots.some((s) => s.task) && !todayD3.reflection) return false;
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
