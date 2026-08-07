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

/** Copy an attachment into R2 and return a stable path.
 *
 *  Sendblue serves attachments from its own inbound-file-store. Those still
 *  resolve, but they are Sendblue's infrastructure rather than ours, and a
 *  capture that depends on a third party to stay readable is not really kept.
 *  Content-addressed, so the same photo sent twice occupies one object. */
async function rehost(env: Env, url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hash = [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
    // Sendblue sends application/octet-stream, so the extension comes from the
    // URL rather than the content type.
    const ext = (url.split("?")[0].match(/\.([a-z0-9]{3,4})$/i)?.[1] ?? "bin").toLowerCase();
    const key = `im/${hash}.${ext}`;
    await env.VAULT.put(key, buf, { httpMetadata: { contentType: res.headers.get("content-type") ?? "application/octet-stream" } });
    return `/files/${key}`;
  } catch {
    return null;
  }
}

/** Has this exact Sendblue message already been captured?
 *
 *  Sendblue retries a webhook it considers failed, and the first version of this
 *  handler awaited the reply before responding — which took long enough to be
 *  treated as a failure, so a single shared reel was captured three times. The
 *  handler now answers immediately, and this is the belt to that braces: a
 *  retry finds the message already stored and stops. */
async function alreadyCaptured(c: store.Ctx, handle: string): Promise<boolean> {
  const row = await store.first<{ id: string }>(
    c, `SELECT id FROM page WHERE json_extract(properties_json, '$.message_handle') = ? LIMIT 1`, handle,
  );
  return !!row;
}

export async function handleInbound(
  req: Request, env: Env, waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
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

  // Answer Sendblue before doing any work. Capturing, re-hosting media and
  // replying all take longer than its webhook timeout, and a slow 200 is read
  // as a failure and retried.
  waitUntil(process(c, env, body, from, text, media));
  return Response.json({ ok: true, queued: true });
}

async function process(
  c: store.Ctx, env: Env, body: Inbound, from: string, text: string, media: string | undefined,
): Promise<void> {
  try {
    const handle = body.message_handle;
    if (handle && await alreadyCaptured(c, handle)) return;
    if (text && isQuestion(text)) {
      const hits = await store.search(c, text, { limit: 5 });
      if (!hits.length) {
        await reply(env, from, `Nothing found for "${text}".`);
      } else {
        const lines = hits.map((h) => `• ${h.title}\n  ${APP_URL}/page/?id=${h.entity_id}`);
        await reply(env, from, `${hits.length} result${hits.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}`);
      }
      return;
    }

    // Capture. A link in the text is the subject; an attachment is evidence
    // attached to it, not a second capture — sharing a reel sends both, and
    // filing them separately produced two unrelated-looking inbox rows.
    const link = text.match(/https?:\/\/\S+/)?.[0] ?? null;
    const stored = media ? await rehost(env, media) : null;
    const url = link ?? (stored ? `${APP_URL}${stored}` : media ?? null);
    const note = text && text !== link ? text : null;

    const page = await store.capture(c, {
      kind: "note",
      title: note?.slice(0, 60) || link || "From iMessage",
      url,
      raw: note,
    });
    // Recorded so a Sendblue retry is recognised, and so the attachment stays
    // attached even when the link is what titles the capture.
    await store.updatePage(c, page.id, {
      properties: {
        message_handle: body.message_handle ?? null,
        media: stored ?? media ?? null,
        via: "imessage",
      },
    });
    if (stored) {
      await store.writeBlocks(c, page.id, [
        { op: "insert", after: null, type: "image", content: { url: stored, caption: "" } },
      ]);
    }
    await reply(env, from, `Captured → ${APP_URL}/page/?id=${page.id}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Tell the sender it failed. Silence would look like it worked.
    await reply(env, from, `Couldn't do that: ${msg}`);
  }
}
