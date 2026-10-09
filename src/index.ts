// The Worker: routing, auth, REST + MCP, health, and the background queue.
// Agents do their reasoning outside, over MCP. The one model call inside is
// extraction on Workers AI (a Cloudflare binding, so no vendor key lives here),
// and it can only propose: nothing it produces is real until a human accepts it.
import { Hono } from "hono";
import { ZodError } from "zod";
import type { Env, Job } from "./schema";
import { RuleError, ctx } from "./store";
import { api } from "./api";
import { embedNote, ingestSource } from "./ingest";
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

// Every /api call requires a valid credential, reads included: this is one
// person's notes, tasks and saved links, and an open read would publish all of
// it to anyone who found the URL. Actor defaults to 'human'. Login/logout/session
// manage the cookie, so they are the only routes the gate lets through.
app.use("/api/*", async (c, next) => {
  c.set("actor", "human");
  const path = new URL(c.req.url).pathname;
  if (path === "/api/login" || path === "/api/logout" || path === "/api/session") return next();
  if (!validKey(c.env, credential(c.req.raw))) {
    return c.json({ error: "unauthorized" }, 401);
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
  // Bad input is the caller's to fix, so say which field and why.
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return c.json({ error: `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}` }, 400);
  }
  const message = err instanceof Error ? err.message : "internal error";
  return c.json({ error: message }, 500);
});

app.get("/health", (c) => {
  return c.json({
    app: c.env.APP_NAME ?? "et al.",
    version: "9.0.0",
    bindings: {
      d1: !!c.env.DB,
      r2: !!c.env.VAULT,
      vectorize: !!c.env.VECTORIZE,
      ai: !!c.env.AI,
      queue: !!c.env.JOBS,
    },
  });
});

// ---- Files (R2) -------------------------------------------------------------
// Images pasted into a note are uploaded to VAULT and served from here.

// Served outside /api so an <img src> is a plain URL. It is gated like the API:
// an <img> on the same origin sends the session cookie, so the app's own images
// still load, and nobody else's do.
app.get("/files/*", async (c) => {
  if (!validKey(c.env, credential(c.req.raw))) return c.text("unauthorized", 401);
  const key = new URL(c.req.url).pathname.replace(/^\/files\//, "");
  if (!key) return c.text("not found", 404);
  const obj = await c.env.VAULT.get(key);
  if (!obj) return c.text("not found", 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  // A key is never reused for different content, so a hit can be cached hard —
  // but only by the browser that was allowed to fetch it, never a shared cache.
  headers.set("cache-control", "private, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
});

// Upload sits under /api so the existing mutation gate protects it.
app.put("/api/files/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const contentType = c.req.header("content-type") ?? "application/octet-stream";
  await c.env.VAULT.put(key, c.req.raw.body, { httpMetadata: { contentType } });
  return c.json({ ok: true, key, url: `/files/${key}` });
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

  // Background work. Each job is best-effort and records its own failures, so
  // a throw here means something unexpected: retry it, up to max_retries.
  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    const c = ctx(env, "system");
    for (const msg of batch.messages) {
      try {
        if (msg.body.type === "ingest_source") await ingestSource(c, env, msg.body.source_id);
        else if (msg.body.type === "embed_note") await embedNote(c, env, msg.body.note_id);
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  },
};
