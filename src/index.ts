// The Worker: routing, auth, REST + MCP, health, and the deterministic ingest
// queue. No LLM provider lives here — the Worker fetches, parses, and embeds;
// all reasoning happens in an external agent over MCP.
import { Hono } from "hono";
import type { Env } from "./schema";
import { RuleError, ctx } from "./store";
import * as store from "./store";
import { api } from "./api";
import { handleMcp } from "./mcp";

const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();

function validKey(env: Env, provided: string | null): boolean {
  const expected = env.ET_AL_API_KEY ?? "dev-key"; // dev fallback when unset
  return provided === expected;
}

// A credential can arrive three ways: Bearer, x-api-key, or the session cookie
// the web app sets after login (so the browser never holds the key in JS).
function credential(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const header = req.headers.get("x-api-key");
  if (header) return header;
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)et_al_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Reads are open; mutations require a valid credential. Actor defaults to
// 'human'. Login/logout/session manage the cookie and bypass the mutation gate.
app.use("/api/*", async (c, next) => {
  c.set("actor", "human");
  const path = new URL(c.req.url).pathname;
  if (path === "/api/login" || path === "/api/logout" || path === "/api/session") return next();
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") {
    if (!validKey(c.env, credential(c.req.raw))) {
      return c.json({ error: "unauthorized" }, 401);
    }
  }
  await next();
});

// Exchange the API key for an httpOnly session cookie (single-user auth).
app.post("/api/login", async (c) => {
  const { key } = await c.req.json<{ key?: string }>().catch(() => ({ key: undefined }));
  if (!validKey(c.env, key ?? null)) return c.json({ error: "invalid key" }, 401);
  const secure = new URL(c.req.url).protocol === "https:";
  c.header("Set-Cookie", `et_al_session=${encodeURIComponent(key!)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure ? "; Secure" : ""}`);
  return c.json({ ok: true });
});
app.post("/api/logout", (c) => {
  c.header("Set-Cookie", "et_al_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  return c.json({ ok: true });
});
app.get("/api/session", (c) => c.json({ authed: validKey(c.env, credential(c.req.raw)) }));

// Map rule violations to clean status codes.
app.onError((err, c) => {
  if (err instanceof RuleError) return c.json({ error: err.message }, err.status as 400);
  const message = err instanceof Error ? err.message : "internal error";
  return c.json({ error: message }, 500);
});

app.get("/health", (c) => {
  return c.json({
    app: c.env.APP_NAME ?? "et al.",
    version: "7.0.0",
    bindings: {
      d1: !!c.env.DB,
      r2: !!c.env.VAULT,
      vectorize: !!c.env.VECTORIZE,
      ai: !!c.env.AI,
      queue: !!c.env.JOBS,
      kv: !!c.env.KV,
    },
  });
});

// Seed the default Life Areas. Idempotent-ish: only seeds when empty.
app.post("/api/bootstrap", async (c) => {
  const c2 = ctx(c.env, "human");
  const existing = await store.listWorkspaces(c2);
  if (existing.length > 0) return c.json({ seeded: false, count: existing.length });
  const life = await store.createWorkspace(c2, { type: "area", title: "Life" });
  for (const title of ["Build", "School", "Career", "Health", "Personal"]) {
    await store.createWorkspace(c2, { parent_id: life.id, type: "area", title });
  }
  return c.json({ seeded: true });
});

app.route("/api", api);

// MCP: Bearer/x-api-key required for every call. The client name becomes the actor.
app.all("/mcp", async (c) => {
  if (!validKey(c.env, credential(c.req.raw))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const agentName = c.req.header("x-mcp-client") ?? "claude";
  return handleMcp(c.req.raw, c.env, agentName);
});

export default {
  fetch: app.fetch,

  // Deterministic ingest. Best-effort: failures leave the source in the inbox.
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const c = ctx(env, "system");
    for (const msg of batch.messages) {
      try {
        const body = msg.body as { type: string; source_id?: string; insight_id?: string };
        if (body.type === "ingest_source" && body.source_id) {
          await ingestSource(c, env, body.source_id);
        } else if (body.type === "enrich_source" && body.source_id) {
          await enrichSource(c, env, body.source_id);
        } else if (body.type === "embed_insight" && body.insight_id) {
          await embedInsight(c, env, body.insight_id);
        }
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  },
};

// Give a captured link a face: title, description, site, image.
//
// Deliberately NOT ingestSource. That one drives a source through its lifecycle
// and lands it on 'processed', which pulls it out of the inbox. Enrichment is
// the opposite contract — it only ever decorates, and never touches `status`, so
// a pasted link stays in the inbox looking like something you can recognise
// instead of a bare URL. Best-effort throughout: a link that won't fetch or
// won't parse is still a perfectly good capture.
async function enrichSource(c: store.Ctx, env: Env, sourceId: string): Promise<void> {
  const src = await store.getSource(c, sourceId);
  if (!src?.url) return;

  let target: URL;
  try { target = new URL(src.url); } catch { return; }
  if (target.protocol !== "http:" && target.protocol !== "https:") return;

  const meta = await fetchLinkMeta(target);
  // Always record the site, so even a failed fetch leaves the row more legible
  // than a raw URL — and so the UI can tell "enriched" from "not yet tried".
  const merged = { site: target.hostname.replace(/^www\./, ""), ...meta, enriched_at: Date.now() };

  // Only claim the title if the human never wrote one. `/api/share` seeds title
  // from the URL when a bare link is pasted, so that counts as unwritten too.
  const keepTitle = src.title && src.title !== src.url;
  const title = keepTitle ? src.title : (usefulTitle(meta.title, merged.site) ?? src.title);

  await env.DB
    .prepare(`UPDATE source SET title = ?, metadata_json = ?, updated_at = ? WHERE id = ?`)
    .bind(title, JSON.stringify(merged), Date.now(), sourceId)
    .run();
  await store.ftsUpsert(c, "source", sourceId, title ?? src.url, [src.raw, meta.description].filter(Boolean).join("\n"));
}

// Reject a fetched title that only names the platform. Login-walled feeds serve
// a JS shell to any anonymous fetch — Instagram returns <title>Instagram</title>
// on every reel — so taking it would label every saved item identically and lose
// the URL, which at least identifies the thing. Better to keep the link and let
// the human name it.
function usefulTitle(title: string | undefined, site: string): string | undefined {
  if (!title) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const t = norm(title);
  // The site as given ("Instagram") and its bare hostname token ("instagram").
  return t && t !== norm(site) && t !== norm(site.split(".")[0]) ? title : undefined;
}

// Parse OpenGraph/meta out of a page with HTMLRewriter — streaming, so we never
// buffer the document, and we can abandon the body once <head> is done.
async function fetchLinkMeta(target: URL): Promise<{ title?: string; description?: string; image?: string; site?: string }> {
  const out: { title?: string; description?: string; image?: string; site?: string } = {};
  try {
    const res = await fetch(target.toString(), {
      redirect: "follow",
      headers: {
        // Many sites serve a stub or a consent wall to unknown agents; a plain
        // browser UA gets the real markup with the OG tags on it.
        "user-agent": "Mozilla/5.0 (compatible; et-al/1.0; +https://et-al.daniellehonnn.workers.dev)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("html")) return out;

    // og:* wins over twitter:* wins over the bare tags, so only fill a blank.
    const set = (k: keyof typeof out, v: string | null, force = false) => {
      const t = v?.trim().replace(/\s+/g, " ").slice(0, 400);
      if (t && (force || !out[k])) out[k] = t;
    };

    // <title> arrives in arbitrary text chunks, so accumulate separately and
    // only commit once the element closes — set() refuses to overwrite.
    let titleBuf = "";
    await new HTMLRewriter()
      .on("meta", {
        element(el) {
          const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? "").toLowerCase();
          const content = el.getAttribute("content");
          // force=true for og:*: it outranks a <title> we may already have taken.
          if (key === "og:title" || key === "twitter:title") set("title", content, key === "og:title");
          else if (key === "og:description" || key === "twitter:description" || key === "description") set("description", content, key === "og:description");
          else if (key === "og:image" || key === "twitter:image") set("image", content);
          else if (key === "og:site_name") set("site", content, true);
        },
      })
      .on("title", {
        text(t) {
          titleBuf += t.text;
          if (t.lastInTextNode) { set("title", titleBuf); titleBuf = ""; }
        },
      })
      .transform(res)
      .arrayBuffer();
  } catch { /* offline, timeout, malformed — the capture survives regardless */ }

  // Resolve a relative og:image against the page it came from.
  if (out.image) { try { out.image = new URL(out.image, target).toString(); } catch { delete out.image; } }
  return out;
}

async function ingestSource(c: store.Ctx, env: Env, sourceId: string): Promise<void> {
  const src = await store.getSource(c, sourceId);
  if (!src || !src.url) return;
  await env.DB.prepare(`UPDATE source SET status = 'processing', updated_at = ? WHERE id = ?`).bind(Date.now(), sourceId).run();
  // Deterministic fetch only — no interpretation. The agent turns this into insights.
  let text = "";
  try {
    const res = await fetch(src.url);
    text = (await res.text()).slice(0, 100_000);
  } catch { /* leave text empty; still mark processed so it exits the inbox */ }
  await env.DB
    .prepare(`UPDATE source SET status = 'processed', metadata_json = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify({ fetched_len: text.length }), Date.now(), sourceId)
    .run();
  await store.ftsUpsert(c, "source", sourceId, src.title ?? src.url, text);
}

async function embedInsight(c: store.Ctx, env: Env, insightId: string): Promise<void> {
  if (!env.AI || !env.VECTORIZE) return;
  const ins = await store.getInsight(c, insightId);
  if (!ins) return;
  const out = (await env.AI.run("@cf/baai/bge-base-en-v1.5" as never, { text: [`${ins.title}\n\n${ins.body}`] } as never)) as unknown as { data: number[][] };
  const vector = out?.data?.[0];
  if (!vector) return;
  await env.VECTORIZE.upsert([{ id: insightId, values: vector, metadata: { workspace_id: ins.workspace_id ?? "" } }]);
  await env.DB.prepare(`UPDATE insight SET embedding_id = ? WHERE id = ?`).bind(insightId, insightId).run();
}
