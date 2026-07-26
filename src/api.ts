// REST surface for the web app. Same store functions as MCP. Reads are open;
// mutations require the API key (enforced in index.ts middleware). Unlike MCP,
// the web app CAN write document blocks directly — it is the human surface.
import { Hono } from "hono";
import type { Env } from "./schema";
import * as store from "./store";

type Vars = { actor: string };
export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

const ctx = (c: { env: Env; get: (k: "actor") => string }) => store.ctx(c.env, c.get("actor"));

// ---- aggregates -------------------------------------------------------------
api.get("/home", async (c) => c.json(await store.getHome(ctx(c))));
api.get("/review", async (c) => c.json(await store.getWeeklyReview(ctx(c))));
api.get("/agent-activity", async (c) => c.json(await store.getAgentActivity(ctx(c))));

// ---- workspaces -------------------------------------------------------------
api.get("/workspaces", async (c) => {
  const parent = c.req.query("parent_id");
  return c.json(await store.listWorkspaces(ctx(c), parent === "root" ? null : parent));
});
api.get("/workspaces/:id", async (c) => c.json(await store.getWorkspace(ctx(c), c.req.param("id"))));
api.post("/workspaces", async (c) => c.json(await store.createWorkspace(ctx(c), await c.req.json())));
api.patch("/workspaces/:id", async (c) => c.json(await store.updateWorkspace(ctx(c), c.req.param("id"), await c.req.json())));
api.post("/workspaces/:id/move", async (c) => {
  const { new_parent_id } = await c.req.json();
  return c.json(await store.moveWorkspace(ctx(c), c.req.param("id"), new_parent_id ?? null));
});
api.delete("/workspaces/:id", async (c) => { await store.deleteWorkspace(ctx(c), c.req.param("id")); return c.json({ ok: true }); });

// ---- objectives -------------------------------------------------------------
api.get("/workspaces/:id/objectives", async (c) => c.json(await store.listObjectives(ctx(c), c.req.param("id"))));
api.post("/objectives", async (c) => c.json(await store.createObjective(ctx(c), await c.req.json())));
api.patch("/objectives/:id", async (c) => c.json(await store.updateObjective(ctx(c), c.req.param("id"), await c.req.json())));
api.delete("/objectives/:id", async (c) => { await store.deleteObjective(ctx(c), c.req.param("id")); return c.json({ ok: true }); });

// ---- tasks ------------------------------------------------------------------
api.get("/workspaces/:id/tasks", async (c) => c.json(await store.listTasks(ctx(c), c.req.param("id"), { status: c.req.query("status"), objective_id: c.req.query("objective_id") })));
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
api.get("/sources/:id", async (c) => c.json(await store.getSource(ctx(c), c.req.param("id"))));
api.patch("/sources/:id", async (c) => c.json(await store.updateSource(ctx(c), c.req.param("id"), await c.req.json())));
api.delete("/sources/:id", async (c) => { await store.deleteSource(ctx(c), c.req.param("id")); return c.json({ ok: true }); });
api.post("/insights", async (c) => c.json(await store.createInsight(ctx(c), await c.req.json())));
api.get("/insights", async (c) => c.json(await store.listInsights(ctx(c), c.req.query("workspace_id"))));
api.patch("/insights/:id", async (c) => c.json(await store.updateInsight(ctx(c), c.req.param("id"), await c.req.json())));
api.delete("/insights/:id", async (c) => { await store.deleteInsight(ctx(c), c.req.param("id")); return c.json({ ok: true }); });

// ---- documents (human writes blocks directly; also resolves agent patches) ---
api.get("/workspaces/:id/documents", async (c) => c.json(await store.listDocuments(ctx(c), c.req.param("id"))));
api.get("/workspaces/:id/home", async (c) => c.json(await store.getOrCreateHomeDoc(ctx(c), c.req.param("id"))));
api.post("/documents", async (c) => c.json(await store.createDocument(ctx(c), await c.req.json())));
api.get("/documents/:id", async (c) => c.json(await store.getDocument(ctx(c), c.req.param("id"))));
api.get("/career", async (c) => c.json(await store.listCareerBlocks(ctx(c), c.req.query("workspace_id"))));
api.patch("/documents/:id", async (c) => c.json(await store.updateDocument(ctx(c), c.req.param("id"), await c.req.json())));
api.delete("/documents/:id", async (c) => { await store.deleteDocument(ctx(c), c.req.param("id")); return c.json({ ok: true }); });
api.get("/documents/:id/blocks", async (c) => c.json(await store.getBlocks(ctx(c), c.req.param("id"))));
api.post("/documents/:id/blocks", async (c) => {
  const { ops } = await c.req.json();
  return c.json(await store.writeBlocks(ctx(c), c.req.param("id"), ops));
});
api.post("/documents/:id/reparse", async (c) => c.json(await store.reparseDocumentTables(ctx(c), c.req.param("id"))));
api.get("/documents/:id/patches", async (c) => c.json(await store.listPatches(ctx(c), c.req.param("id"), c.req.query("status"))));
api.post("/patches/:id/resolve", async (c) => {
  const { accept } = await c.req.json();
  return c.json(await store.resolvePatch(ctx(c), c.req.param("id"), !!accept));
});

// ---- decisions / graph / search / health ------------------------------------
api.get("/workspaces/:id/decisions", async (c) => c.json(await store.listDecisions(ctx(c), c.req.param("id"))));
api.get("/workspaces/:id/timeline", async (c) => c.json(await store.getWorkspaceTimeline(ctx(c), c.req.param("id"))));
api.post("/decisions", async (c) => c.json(await store.recordDecision(ctx(c), await c.req.json())));
api.delete("/decisions/:id", async (c) => { await store.deleteDecision(ctx(c), c.req.param("id")); return c.json({ ok: true }); });
api.post("/relate", async (c) => c.json(await store.relate(ctx(c), await c.req.json())));
api.get("/backlinks", async (c) => c.json(await store.getBacklinks(ctx(c), c.req.query("type")!, c.req.query("id")!)));
api.get("/search", async (c) => c.json(await store.search(ctx(c), c.req.query("q") ?? "", {})));
api.get("/health-scores", async (c) => c.json(await store.allHealth(ctx(c))));
api.get("/context/:id", async (c) => c.json(await store.buildContext(ctx(c), c.req.param("id"), c.req.query("q"))));

// ---- customizable Overview widgets ------------------------------------------
api.get("/workspaces/:id/overview", async (c) => c.json(await store.listOverview(ctx(c), c.req.param("id"))));
api.post("/workspaces/:id/overview", async (c) => { const { type } = await c.req.json(); return c.json(await store.addOverviewBlock(ctx(c), c.req.param("id"), type)); });
api.patch("/overview/:bid", async (c) => c.json(await store.updateOverviewBlock(ctx(c), c.req.param("bid"), await c.req.json())));
api.delete("/overview/:bid", async (c) => { await store.deleteOverviewBlock(ctx(c), c.req.param("bid")); return c.json({ ok: true }); });
