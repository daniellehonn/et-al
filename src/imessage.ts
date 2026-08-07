// iMessage front door, via Sendblue.
//
// Two things only, deliberately: capture and lookup. Texting a link files it to
// the inbox; texting a question searches. There is no agent loop here — et al.
// is the substrate agents operate over, not an agent itself, and adding a
// dispatcher would quietly change what it is. The loop can come later, on top.
//
// Apple ships no iMessage API, so Sendblue relays: it POSTs inbound messages
// here and exposes a REST endpoint to reply.
import type { Env } from "./schema";
import * as store from "./store";

interface Inbound {
  content?: string;
  media_url?: string;
  from_number?: string;
  to_number?: string;
  is_outbound?: boolean;
  service?: string;
  message_handle?: string;
}

/** Sendblue's docs say a configured secret is sent in the webhook headers but do
 *  not name the header, so the token in the webhook URL is the reliable check —
 *  it is fully under our control. Any header carrying it is accepted too, so
 *  this keeps working if the header name is pinned down later. */
function authorized(req: Request, env: Env): boolean {
  const expected = env.SENDBLUE_WEBHOOK_TOKEN;
  if (!expected) return false; // unset means the endpoint is closed, not open
  const url = new URL(req.url);
  if (url.searchParams.get("token") === expected) return true;
  for (const h of ["sb-signing-secret", "sb-webhook-secret", "x-sendblue-secret", "authorization"]) {
    const v = req.headers.get(h);
    if (v && (v === expected || v === `Bearer ${expected}`)) return true;
  }
  return false;
}

/** Only the owner's number is answered. Without this, anyone who learned the
 *  Sendblue number could read the workspace and write into the inbox. */
function isOwner(from: string | undefined, env: Env): boolean {
  const owner = env.SENDBLUE_OWNER_NUMBER;
  if (!owner || !from) return false;
  const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
  return digits(owner) === digits(from);
}

async function reply(env: Env, to: string, text: string): Promise<void> {
  if (!env.SENDBLUE_API_KEY_ID || !env.SENDBLUE_API_SECRET) return;
  await fetch("https://api.sendblue.co/api/send-message", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sb-api-key-id": env.SENDBLUE_API_KEY_ID,
      "sb-api-secret-key": env.SENDBLUE_API_SECRET,
    },
    // Long replies are truncated rather than split: a wall of texts is worse
    // than a short answer plus a link.
    body: JSON.stringify({ number: to, content: text.slice(0, 1400) }),
  }).catch(() => { /* best-effort; a failed reply must not retry the capture */ });
}

/** A question is looked up; anything else is kept. Deliberately crude — the cost
 *  of guessing wrong is a captured note instead of an answer, which is
 *  recoverable, whereas asking the user to learn a command syntax is not. */
function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.endsWith("?")) return true;
  return /^(what|where|when|who|why|how|which|find|search|show|list|do i|did i|is there|any )\b/.test(t);
}

const APP_URL = "https://et-al.daniellehonnn.workers.dev";

export async function handleInbound(req: Request, env: Env): Promise<Response> {
  if (!authorized(req, env)) return new Response("unauthorized", { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Inbound;
  // Our own outbound messages come back through the same webhook; answering them
  // would loop forever.
  if (body.is_outbound) return Response.json({ ok: true, ignored: "outbound" });

  const from = body.from_number ?? "";
  if (!isOwner(from, env)) return Response.json({ ok: true, ignored: "not owner" });

  const text = (body.content ?? "").trim();
  const media = body.media_url;
  if (!text && !media) return Response.json({ ok: true, ignored: "empty" });

  // Attributed as the messaging surface rather than as a person at a keyboard,
  // so the event log can tell where a capture came from.
  const c = store.ctx(env, "human");

  try {
    if (text && isQuestion(text)) {
      const hits = await store.search(c, text, { limit: 5 });
      if (!hits.length) {
        await reply(env, from, `Nothing found for "${text}".`);
      } else {
        const lines = hits.map((h) => `• ${h.title}\n  ${APP_URL}/page/?id=${h.entity_id}`);
        await reply(env, from, `${hits.length} result${hits.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}`);
      }
      return Response.json({ ok: true, action: "search" });
    }

    // Capture. A bare link keeps its URL so enrichment can title it; media
    // arrives as a URL too, which is enough to find it again.
    const url = text.match(/https?:\/\/\S+/)?.[0] ?? media ?? null;
    const note = text && text !== url ? text : null;
    const page = await store.capture(c, {
      kind: "note",
      title: note?.slice(0, 60) || url || "From iMessage",
      url,
      raw: note,
    });
    await reply(env, from, `Captured → ${APP_URL}/page/?id=${page.id}`);
    return Response.json({ ok: true, action: "capture", page_id: page.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Tell the sender it failed. Silence would look like it worked.
    await reply(env, from, `Couldn't do that: ${msg}`);
    return Response.json({ ok: false, error: msg });
  }
}
