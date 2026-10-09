// REST surface for the web app — the human side of the trust model. Same store
// as MCP, plus what only a person may do: write a note's body directly, resolve
// proposals, and delete. Every route needs the API key or the session cookie
// (enforced in index.ts).
import { Hono } from "hono";
import type { Env } from "./schema";
import * as store from "./store";

type Vars = { actor: string };
export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

const ctx = (c: { env: Env; get: (k: "actor") => string }) => store.ctx(c.env, c.get("actor"));
const ok = { ok: true };

// ---- notes ------------------------------------------------------------------
api.get("/notes/tree", async (c) => c.json(await store.getNoteTree(ctx(c))));
api.get("/notes/:id", async (c) => c.json(await store.requireNote(ctx(c), c.req.param("id"))));
api.get("/notes/:id/ancestors", async (c) => c.json(await store.getAncestors(ctx(c), c.req.param("id"))));
api.post("/notes", async (c) => c.json(await store.createNote(ctx(c), await c.req.json())));
api.patch("/notes/:id", async (c) => c.json(await store.updateNote(ctx(c), c.req.param("id"), await c.req.json())));
api.post("/notes/:id/move", async (c) => c.json(await store.moveNote(ctx(c), c.req.param("id"), await c.req.json())));
// Delete means trash: reversible, because a delete takes the whole subtree.
api.delete("/notes/:id", async (c) => { await store.trashNote(ctx(c), c.req.param("id")); return c.json(ok); });
api.get("/trash", async (c) => c.json(await store.listTrash(ctx(c))));
api.post("/notes/:id/restore", async (c) => c.json(await store.restoreNote(ctx(c), c.req.param("id"))));
api.delete("/trash/:id", async (c) => { await store.deleteNote(ctx(c), c.req.param("id")); return c.json(ok); });

// A note's body. Direct writes are the human's; agents propose instead.
api.get("/notes/:id/blocks", async (c) => c.json(await store.getBlocks(ctx(c), c.req.param("id"))));
api.post("/notes/:id/blocks", async (c) => c.json(await store.writeBlocks(ctx(c), c.req.param("id"), (await c.req.json()).ops)));
// The editor sends its whole tree; the server reconciles by block id.
api.put("/notes/:id/blocks", async (c) => c.json(await store.setBlocks(ctx(c), c.req.param("id"), (await c.req.json()).blocks)));
api.get("/notes/:id/history", async (c) => c.json(await store.noteHistory(ctx(c), c.req.param("id"))));
api.post("/revisions/:id/restore", async (c) => { await store.restoreRevision(ctx(c), c.req.param("id")); return c.json(ok); });
api.get("/notes/:id/sources", async (c) => c.json(await store.listNoteSources(ctx(c), c.req.param("id"))));
api.get("/notes/:id/tasks", async (c) => c.json(await store.listTasks(ctx(c), { note_id: c.req.param("id") })));

// ---- proposals: the review queue -------------------------------------------
api.get("/proposals", async (c) => c.json(await store.listProposals(ctx(c), { note_id: c.req.query("note_id"), source_id: c.req.query("source_id") })));
api.get("/proposals/:id/preview", async (c) => c.json(await store.previewProposal(ctx(c), c.req.param("id"))));
api.post("/proposals/:id/accept", async (c) => c.json(await store.acceptProposal(ctx(c), c.req.param("id"))));
api.post("/proposals/:id/reject", async (c) => c.json(await store.rejectProposal(ctx(c), c.req.param("id"))));

// ---- tasks ------------------------------------------------------------------
api.get("/tasks", async (c) => c.json(await store.taskTree(ctx(c))));
api.post("/tasks", async (c) => c.json(await store.createTask(ctx(c), await c.req.json())));
api.patch("/tasks/:id", async (c) => c.json(await store.updateTask(ctx(c), c.req.param("id"), await c.req.json())));
api.delete("/tasks/:id", async (c) => { await store.deleteTask(ctx(c), c.req.param("id")); return c.json(ok); });

// ---- sources ----------------------------------------------------------------
api.get("/inbox", async (c) => c.json(await store.listInbox(ctx(c))));
// An Idempotency-Key header makes a retried capture return the first one.
const captureKey = (c: { req: { header: (name: string) => string | undefined } }) => c.req.header("idempotency-key") || null;
api.post("/capture", async (c) => c.json(await store.capture(ctx(c), await c.req.json(), captureKey(c))));

// Share-sheet front door. `/capture` is strict — `url` must be a real URL. A
// share sheet can't promise that: iOS hands over a URL, sometimes a page title,
// and a text blob that may itself just be the URL again. So this endpoint is
// deliberately forgiving where `/capture` is strict — it accepts JSON or form
// encoding, untangles the url/text/title overlap, and delegates. Keeping it
// separate leaves `/capture` honest as the typed API.
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

  return c.json(await store.capture(ctx(c), { title, url, text: note, note_id: str(raw.note_id) }, captureKey(c)));
});
api.get("/sources/:id", async (c) => c.json(await store.requireSource(ctx(c), c.req.param("id"))));
api.patch("/sources/:id", async (c) => c.json(await store.fileSource(ctx(c), c.req.param("id"), await c.req.json())));
api.post("/sources/:id/retry", async (c) => c.json(await store.retryFetch(ctx(c), c.req.param("id"))));
api.delete("/sources/:id", async (c) => { await store.deleteSource(ctx(c), c.req.param("id")); return c.json(ok); });

// ---- search, context, activity ---------------------------------------------
api.get("/search", async (c) => c.json(await store.search(ctx(c), c.req.query("q") ?? "")));
api.get("/context/:id", async (c) => c.json(await store.buildContext(ctx(c), c.req.param("id"), c.req.query("q"))));
api.get("/agent-activity", async (c) => c.json(await store.getAgentActivity(ctx(c))));
