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

function bearerOrApiKey(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return req.headers.get("x-api-key");
}

// Reads are open; mutations require the API key. Actor defaults to 'human'.
app.use("/api/*", async (c, next) => {
  c.set("actor", "human");
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") {
    if (!validKey(c.env, bearerOrApiKey(c.req.raw))) {
      return c.json({ error: "unauthorized" }, 401);
    }
  }
  await next();
});

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
  if (!validKey(c.env, bearerOrApiKey(c.req.raw))) {
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
