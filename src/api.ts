// REST surface for the web app. Same store functions as MCP. Reads are open;
// mutations require the API key (enforced in index.ts middleware). Unlike MCP,
// the web app CAN write page blocks directly — it is the human surface.
//
// v8 routes are page-shaped. The /workspaces/* and /documents/* paths are gone:
// both were the same thing all along, and the client now speaks /pages.
import { Hono } from "hono";
import type { Env } from "./schema";
import { SOURCE_KINDS } from "./schema";
import * as store from "./store";

type Vars = { actor: string };
export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

const ctx = (c: { env: Env; get: (k: "actor") => string }) => store.ctx(c.env, c.get("actor"));

// ---- aggregates -------------------------------------------------------------
api.get("/home", async (c) => c.json(await store.getHome(ctx(c))));
api.get("/review", async (c) => c.json(await store.getWeeklyReview(ctx(c))));
api.get("/agent-activity", async (c) => c.json(await store.getAgentActivity(ctx(c))));

// ---- pages (the tree, the body, and the patch queue) ------------------------
api.get("/pages", async (c) => {
  const parent = c.req.query("parent_page_id");
  return c.json(await store.listChildren(ctx(c), parent && parent !== "root" ? parent : null));
});
api.get("/tree", async (c) => c.json(await store.getPageTree(ctx(c))));
api.get("/pages/:id", async (c) => c.json(await store.getPage(ctx(c), c.req.param("id"))));
api.get("/pages/:id/ancestors", async (c) => c.json(await store.getAncestors(ctx(c), c.req.param("id"))));
api.post("/pages", async (c) => c.json(await store.createPage(ctx(c), await c.req.json())));
api.patch("/pages/:id", async (c) => c.json(await store.updatePage(ctx(c), c.req.param("id"), await c.req.json())));
api.post("/pages/:id/move", async (c) => c.json(await store.movePage(ctx(c), c.req.param("id"), await c.req.json())));
api.delete("/pages/:id", async (c) => { await store.deletePage(ctx(c), c.req.param("id")); return c.json({ ok: true }); });

api.get("/pages/:id/blocks", async (c) => c.json(await store.getBlocks(ctx(c), c.req.param("id"))));
api.post("/pages/:id/blocks", async (c) => {
  const { ops } = await c.req.json();
  return c.json(await store.writeBlocks(ctx(c), c.req.param("id"), ops));
});
api.get("/pages/:id/patches", async (c) => c.json(await store.listPatches(ctx(c), c.req.param("id"), c.req.query("status"))));
api.get("/patches", async (c) => c.json(await store.listPendingPatches(ctx(c))));
api.post("/patches/:id/resolve", async (c) => {
  const { accept } = await c.req.json();
  return c.json(await store.resolvePatch(ctx(c), c.req.param("id"), !!accept));
});

// ---- collections ------------------------------------------------------------
api.get("/pages/:id/collections", async (c) => c.json(await store.listCollections(ctx(c), c.req.param("id"))));
api.get("/collections/:id", async (c) => c.json(await store.getCollection(ctx(c), c.req.param("id"))));
api.get("/collections/:id/rows", async (c) => c.json(await store.queryCollection(ctx(c), c.req.param("id"), {})));
api.get("/collections/:id/views", async (c) => c.json(await store.listViews(ctx(c), c.req.param("id"))));
api.post("/collections", async (c) => c.json(await store.createCollection(ctx(c), await c.req.json())));
api.patch("/collections/:id", async (c) => c.json(await store.updateCollection(ctx(c), c.req.param("id"), await c.req.json())));
api.delete("/collections/:id", async (c) => { await store.deleteCollection(ctx(c), c.req.param("id")); return c.json({ ok: true }); });
api.post("/views", async (c) => c.json(await store.createView(ctx(c), await c.req.json())));
api.patch("/views/:id", async (c) => c.json(await store.updateView(ctx(c), c.req.param("id"), await c.req.json())));
api.delete("/views/:id", async (c) => { await store.deleteView(ctx(c), c.req.param("id")); return c.json({ ok: true }); });

// ---- tasks ------------------------------------------------------------------
api.get("/tasks", async (c) => c.json(await store.listTasks(ctx(c), { pageId: c.req.query("page_id"), status: c.req.query("status") })));
api.get("/pages/:id/tasks", async (c) => c.json(await store.listTasks(ctx(c), { pageId: c.req.param("id"), status: c.req.query("status") })));
api.post("/tasks", async (c) => c.json(await store.createTask(ctx(c), await c.req.json())));
api.patch("/tasks/:id", async (c) => c.json(await store.updateTask(ctx(c), c.req.param("id"), await c.req.json())));
api.delete("/tasks/:id", async (c) => { await store.deleteTask(ctx(c), c.req.param("id")); return c.json({ ok: true }); });

// ---- daily 3 ----------------------------------------------------------------
api.get("/daily3", async (c) => c.json(await store.getDaily3(ctx(c), c.req.query("date"))));
api.post("/daily3", async (c) => c.json(await store.setDaily3(ctx(c), await c.req.json())));
api.post("/daily3/confirm", async (c) => c.json(await store.confirmDaily3(ctx(c), c.req.query("date"))));

// ---- inbox / sources / insights ---------------------------------------------
api.get("/inbox", async (c) => c.json(await store.listInbox(ctx(c))));
api.post("/capture", async (c) => c.json(await store.capture(ctx(c), await c.req.json())));

// Share-sheet front door. `/capture` is strict — it demands a `kind` from the
// vocabulary. A share sheet can't supply that: iOS hands over a URL, sometimes a
// page title, and a text blob that may itself just be the URL again. So this
// endpoint is deliberately forgiving where `/capture` is deliberately strict —
// it accepts JSON or form encoding, untangles the url/text/title overlap, infers
// the kind, and delegates. Keeping it separate leaves `/capture` honest as the
// typed API that MCP and the web app use.
api.post("/share", async (c) => {
  const ct = c.req.header("content-type") ?? "";
  const raw: Record<string, unknown> = ct.includes("json")
    ? await c.req.json().catch(() => ({}))
    : Object.fromEntries(await c.req.formData().catch(() => new FormData()));

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const title = str(raw.title);

  // A share sheet decides what goes in which field, and it is regularly wrong:
  // share a text selection and `url` arrives holding prose. Trusting it would
  // fail zod's .url() and 500 — so treat `url` as a candidate, not a promise,
  // and demote it to text when it isn't actually a link.
  const claimed = str(raw.url);
  const isLink = (s: string | null) => !!s && /^https?:\/\/\S+$/i.test(s);
  const text = str(raw.text) ?? str(raw.raw) ?? (isLink(claimed) ? null : claimed);
  // Android puts the URL in `url`; iOS Shortcuts and many apps bury it in the
  // text blob instead. Take the first http(s) token we can find either way.
  const url = (isLink(claimed) ? claimed : null) ?? text?.match(/https?:\/\/\S+/)?.[0] ?? null;
  // If the text was only ever the URL, it carries no extra signal — drop it so
  // the inbox row doesn't show the same link twice.
  const note = text && text !== url ? text : null;

  if (!url && !note && !title) return c.json({ error: "nothing to capture" }, 400);

  // Default to `note` even when a URL is present. This looks wrong but matches
  // Quick Capture, which also files links as notes: `note` is an inline kind, so
  // it does NOT enqueue ingest, and the row stays put with status 'inbox'. The
  // link-ish kinds (url/youtube/pdf) enqueue a fetch that flips the source to
  // 'processed', which would drop a share straight out of the inbox — the exact
  // opposite of capture-first-organize-later. The URL is still stored in `url`,
  // so the inbox renders it as a link and process_inbox can type it properly.
  // A Shortcut that genuinely wants eager fetching can pass `kind` explicitly.
  // Narrow against the vocabulary rather than casting: an unknown `kind` from a
  // hand-built Shortcut falls back to `note` instead of reaching zod as a 400.
  const asked = str(raw.kind);
  const kind = (SOURCE_KINDS as readonly string[]).includes(asked ?? "")
    ? (asked as (typeof SOURCE_KINDS)[number])
    : "note";

  return c.json(await store.capture(ctx(c), {
    kind,
    title: title ?? url ?? note?.slice(0, 60),
    url,
    raw: note,
    page_id: str(raw.page_id) ?? str(raw.workspace_id) ?? undefined,
  }));
});
api.get("/sources", async (c) => c.json(await store.listSources(ctx(c), c.req.query("q"))));
api.get("/pages/:id/sources", async (c) => c.json(await store.listPageSources(ctx(c), c.req.param("id"))));
api.get("/sources/:id", async (c) => c.json(await store.getPage(ctx(c), c.req.param("id"))));
api.patch("/sources/:id", async (c) => {
  const body = await c.req.json();
  return c.json(await store.fileSource(ctx(c), c.req.param("id"), body.page_id ?? null, body));
});
api.delete("/sources/:id", async (c) => { await store.deleteSource(ctx(c), c.req.param("id")); return c.json({ ok: true }); });
api.post("/insights", async (c) => c.json(await store.createInsight(ctx(c), await c.req.json())));
api.get("/insights", async (c) => c.json(await store.listInsights(ctx(c), c.req.query("page_id"))));
api.patch("/insights/:id", async (c) => c.json(await store.updateInsight(ctx(c), c.req.param("id"), await c.req.json())));
api.delete("/insights/:id", async (c) => { await store.deleteInsight(ctx(c), c.req.param("id")); return c.json({ ok: true }); });

api.get("/career", async (c) => c.json(await store.listCareerBlocks(ctx(c), c.req.query("page_id"))));

// ---- decisions / graph / search / health ------------------------------------
api.get("/pages/:id/decisions", async (c) => c.json(await store.listDecisions(ctx(c), c.req.param("id"))));
api.get("/pages/:id/timeline", async (c) => c.json(await store.getPageTimeline(ctx(c), c.req.param("id"))));
api.post("/decisions", async (c) => c.json(await store.recordDecision(ctx(c), await c.req.json())));
api.delete("/decisions/:id", async (c) => { await store.deleteDecision(ctx(c), c.req.param("id")); return c.json({ ok: true }); });
api.post("/relate", async (c) => c.json(await store.relate(ctx(c), await c.req.json())));
api.get("/backlinks", async (c) => c.json(await store.getBacklinks(ctx(c), c.req.query("type") ?? "page", c.req.query("id")!)));
api.get("/search", async (c) => c.json(await store.search(ctx(c), c.req.query("q") ?? "", {})));
api.get("/health-scores", async (c) => c.json(await store.allHealth(ctx(c))));
api.get("/pages/:id/health", async (c) => c.json(await store.pageHealth(ctx(c), c.req.param("id"))));
api.get("/context/:id", async (c) => c.json(await store.buildContext(ctx(c), c.req.param("id"), c.req.query("q"))));

// The Overview tab is gone: a page's body IS its overview now, so the widget
// endpoints that used to back it have no equivalent and no callers.
