// The typed surface: tasks, sources, insights and decisions.
//
// In v7 each of these was a table with its own module. They are now pages in
// role-tagged collections, and this module is what keeps them addressable by
// name — for agents (list_tasks, weekly_review, suggest_daily3) and for the
// parts of the app that legitimately need to know what a task is.
//
// The trade this rewrite makes: structure is the user's to author, but meaning
// stays machine-readable. A user can rename the Tasks collection, add columns,
// or keep tasks in three different projects; `role` and the stable property keys
// mean none of that breaks the agent layer.
import { z } from "zod";
import { captureInput, createInsightInput, createTaskInput, recordDecisionInput, updateTaskInput, INLINE_SOURCE_KINDS } from "../schema";
import { Ctx, RuleError, all, first, id, logEvent, now } from "./db";
import { Page, createPage, deletePage, getPage, properties, updatePage } from "./pages";
import { collectionSchema, ensureRoleCollection, getCollection, pagesWithRole } from "./collections";
import { writeBlocks } from "./blocks";

/** A page from a role collection, with its properties already decoded — what
 *  callers actually want, instead of re-parsing properties_json everywhere. */
export interface RoleRow extends Page {
  owner_page_id: string | null;
  props: Record<string, unknown>;
}

const decorate = (rows: (Page & { owner_page_id: string | null })[]): RoleRow[] =>
  rows.map((r) => ({ ...r, props: properties(r) }));

// ---- Tasks ------------------------------------------------------------------
//
// Tasks live in ONE collection, not scattered across the pages they relate to.
// A page is for the durable thing — a tracker, an implementation plan, notes —
// and hanging a task list off each one splits "what do I actually do next"
// across the whole tree. The relationship still exists, but as a link on the
// task (`source_page`) rather than as ownership, so a task can be derived from
// a page without living inside it.

const TASKS_HOME_ID = "pg_tasks_home";

/** The single tasks collection, created on first use.
 *
 *  Its page is a root so the task system has an obvious front door in the
 *  sidebar; it is the task system itself rather than a note page that happens
 *  to carry tasks. */
export async function tasksHome(c: Ctx): Promise<{ pageId: string; collectionId: string }> {
  let page = await getPage(c, TASKS_HOME_ID);
  if (!page) {
    const t = now();
    await c.db
      .prepare(`INSERT INTO page (id, parent_page_id, collection_id, title, icon, cover, properties_json, position, status, trashed_at, favorite, is_ai, actor, created_at, updated_at)
                VALUES (?, NULL, NULL, 'Tasks', '✅', NULL, '{}', -2, 'active', NULL, 1, 0, 'human', ?, ?)`)
      .bind(TASKS_HOME_ID, t, t)
      .run();
    page = (await getPage(c, TASKS_HOME_ID))!;
  }
  const col = await ensureRoleCollection(c, TASKS_HOME_ID, "tasks");
  return { pageId: TASKS_HOME_ID, collectionId: col.id };
}

export async function listTasks(
  c: Ctx,
  opts: { pageId?: string; status?: string; section?: string } = {},
): Promise<RoleRow[]> {
  // Not scoped by owning page any more — tasks all live in one collection, so
  // "this page's tasks" means the ones derived from it.
  let rows = decorate(await pagesWithRole(c, "tasks"));
  if (opts.pageId) rows = rows.filter((r) => r.props.source_page === opts.pageId);
  if (opts.section) rows = rows.filter((r) => r.props.section === opts.section);
  if (opts.status) rows = rows.filter((r) => r.props.status === opts.status);
  return rows;
}

export interface TaskNode extends RoleRow {
  children: TaskNode[];
  /** done / total across the whole subtree, so a goal shows real progress. */
  progress: { done: number; total: number };
  /** Overdue, or due within three days — what the evening nudge surfaces. */
  pressing: "overdue" | "soon" | null;
}

function pressure(due: unknown): "overdue" | "soon" | null {
  const n = Number(due);
  if (!n) return null;
  const days = (n - Date.now()) / 86_400_000;
  if (days < 0) return "overdue";
  if (days <= 3) return "soon";
  return null;
}

/** Build the goal -> task -> subtask tree from the flat rows. */
function buildTree(rows: RoleRow[]): TaskNode[] {
  const byId = new Map<string, TaskNode>(
    rows.map((r) => [r.id, { ...r, children: [], progress: { done: 0, total: 0 }, pressing: pressure(r.props.due_date) }]),
  );
  const roots: TaskNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_page_id ? byId.get(node.parent_page_id) : undefined;
    if (parent) parent.children.push(node);
    // A subtask whose parent is done or gone still has to appear, or work
    // silently disappears from the list.
    else roots.push(node);
  }
  const roll = (n: TaskNode): { done: number; total: number } => {
    let done = n.props.status === "done" ? 1 : 0;
    let total = 1;
    for (const kid of n.children) {
      const sub = roll(kid);
      done += sub.done;
      total += sub.total;
    }
    n.progress = { done, total };
    return n.progress;
  };
  roots.forEach(roll);
  return roots;
}

/** Everything not finished, as a tree, grouped by section.
 *
 *  A parent is kept when any descendant is open, so a goal does not vanish from
 *  the list the moment its own row is ticked but its work is not done. */
export async function taskTree(c: Ctx): Promise<Array<{ section: string; tasks: TaskNode[] }>> {
  const { collectionId } = await tasksHome(c);
  const col = await getCollection(c, collectionId);
  const defined = col ? (collectionSchema(col).find((p) => p.key === "section")?.options ?? []) : [];

  const all = decorate(await pagesWithRole(c, "tasks"));
  const tree = buildTree(all);

  const prune = (nodes: TaskNode[]): TaskNode[] =>
    nodes
      .map((n) => ({ ...n, children: prune(n.children) }))
      .filter((n) => n.props.status !== "done" || n.children.length > 0);

  const open = prune(tree);
  const used = [...new Set(open.map((t) => String(t.props.section ?? "")).filter(Boolean))];
  const order = [...defined, ...used.filter((u) => !defined.includes(u))];

  const sortNodes = (nodes: TaskNode[]): TaskNode[] =>
    [...nodes]
      .sort((a, b) => {
        // Pressure first, then the usual ordering.
        const rank = (n: TaskNode) => (n.pressing === "overdue" ? 0 : n.pressing === "soon" ? 1 : 2);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        const ad = Number(a.props.due_date) || 0, bd = Number(b.props.due_date) || 0;
        if (ad && bd && ad !== bd) return ad - bd;
        if (ad !== bd) return ad ? -1 : 1;
        return (Number(b.props.priority) || 0) - (Number(a.props.priority) || 0);
      })
      .map((n) => ({ ...n, children: sortNodes(n.children) }));

  const groups = order.map((section) => ({
    section,
    tasks: sortNodes(open.filter((t) => t.props.section === section)),
  }));
  const none = sortNodes(open.filter((t) => !t.props.section));
  if (none.length) groups.push({ section: "", tasks: none });
  return groups;
}

/** Deadlines that need saying out loud tonight. Flattened across the tree,
 *  because an overdue subtask matters as much as an overdue goal. */
export async function pressingDeadlines(c: Ctx): Promise<RoleRow[]> {
  const all = (await listTasks(c)).filter((t) => t.props.status !== "done");
  return all
    .filter((t) => pressure(t.props.due_date) !== null)
    .sort((a, b) => (Number(a.props.due_date) || 0) - (Number(b.props.due_date) || 0));
}

/** Every open task, grouped by section — what the Tasks screen renders.
 *
 *  Sections come from the collection's own select options, so an empty section
 *  still appears and the order is the one you configured rather than whatever
 *  happens to have tasks in it today. */
export async function tasksBySection(c: Ctx): Promise<Array<{ section: string; tasks: RoleRow[] }>> {
  const { collectionId } = await tasksHome(c);
  const col = await getCollection(c, collectionId);
  const defined = col
    ? (collectionSchema(col).find((p) => p.key === "section")?.options ?? [])
    : [];
  const open = (await listTasks(c)).filter((t) => t.props.status !== "done");

  const used = [...new Set(open.map((t) => String(t.props.section ?? "")).filter(Boolean))];
  const order = [...defined, ...used.filter((u) => !defined.includes(u))];

  const groups = order.map((section) => ({
    section,
    tasks: sortSensibly(open.filter((t) => t.props.section === section)),
  }));
  const unsectioned = sortSensibly(open.filter((t) => !t.props.section));
  if (unsectioned.length) groups.push({ section: "", tasks: unsectioned });
  return groups;
}

/** Overdue first, then soonest due, then priority, then newest.
 *
 *  Deliberately not "balanced across sections": you asked to see everything
 *  open and choose, so the ordering answers "what is most pressing" rather than
 *  making the choice for you. */
function sortSensibly(rows: RoleRow[]): RoleRow[] {
  return [...rows].sort((a, b) => {
    const ad = Number(a.props.due_date) || null;
    const bd = Number(b.props.due_date) || null;
    if (ad && bd && ad !== bd) return ad - bd;
    if (ad && !bd) return -1;
    if (bd && !ad) return 1;
    const ap = Number(a.props.priority) || 0;
    const bp = Number(b.props.priority) || 0;
    if (ap !== bp) return bp - ap;
    return b.created_at - a.created_at;
  });
}

export async function getTask(c: Ctx, tid: string): Promise<RoleRow | null> {
  const page = await getPage(c, tid);
  if (!page) return null;
  return { ...page, owner_page_id: null, props: properties(page) };
}

// Three levels, no more: goal -> task -> subtask. Arbitrary depth is easy to
// build and easy to get lost in; three is the depth at which a plan is still
// something you can hold in your head.
export const MAX_TASK_DEPTH = 3;

/** How deep a task sits, by walking its parents. */
export async function taskDepth(c: Ctx, taskId: string | null): Promise<number> {
  let depth = 0;
  let cur = taskId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = await first<{ parent_page_id: string | null }>(c, `SELECT parent_page_id FROM page WHERE id = ?`, cur);
    depth++;
    cur = row?.parent_page_id ?? null;
  }
  return depth;
}

export async function createTask(
  c: Ctx,
  input: z.input<typeof createTaskInput> & {
    page_id?: string; section?: string; parent_id?: string;
  },
): Promise<Page> {
  // Every task goes to the one collection. `page_id` is now what the task came
  // FROM rather than where it lives — a task derived from the CS 180 page keeps
  // the link without the page owning a task list.
  const source = input.page_id ?? input.workspace_id ?? null;
  if (source && !(await getPage(c, source))) throw new RuleError(`page ${source} not found`, 404);
  const { collectionId } = await tasksHome(c);

  let section = input.section ?? null;
  const parentId = input.parent_id ?? null;
  if (parentId) {
    const parent = await getPage(c, parentId);
    if (!parent) throw new RuleError(`task ${parentId} not found`, 404);
    if ((await taskDepth(c, parentId)) >= MAX_TASK_DEPTH) {
      throw new RuleError(`tasks nest three deep — break this into its own goal instead`, 400);
    }
    // Section is inherited rather than set per level: a subtask of a school
    // goal is school work, and asking again at every level is friction that
    // produces inconsistency.
    section = section ?? (properties(parent).section as string | null) ?? null;
  }

  const task = await createPage(c, {
    collection_id: collectionId,
    title: input.title,
    properties: {
      status: "todo",
      section,
      priority: input.priority ?? 1,
      due_date: input.due_date ?? null,
      notes: input.notes ?? null,
      estimate_min: input.estimate_min ?? null,
      source_page: source,
    },
  });
  if (parentId) {
    await c.db.prepare(`UPDATE page SET parent_page_id = ? WHERE id = ?`).bind(parentId, task.id).run();
  }
  return (await getPage(c, task.id))!;
}

export async function updateTask(c: Ctx, tid: string, patch: z.input<typeof updateTaskInput>): Promise<Page> {
  const props: Record<string, string | number | boolean | string[] | null> = {};
  for (const k of ["status", "priority", "due_date", "notes", "estimate_min"] as const) {
    if (patch[k] !== undefined) props[k] = patch[k];
  }
  if (patch.status === "done") props.completed_at = now();
  return updatePage(c, tid, {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    properties: props,
  });
}

export async function completeTask(c: Ctx, tid: string): Promise<Page> {
  const page = await updatePage(c, tid, { properties: { status: "done", completed_at: now() } });
  await logEvent(c, "complete", "page", tid, { title: page.title });
  return page;
}

export const deleteTask = deletePage;

// ---- Sources ----------------------------------------------------------------

/** The inbox is a real page ('ws_inbox'), created on demand, so an unfiled
 *  capture is somewhere you can open and read rather than a status flag. */
export async function inboxPage(c: Ctx): Promise<Page> {
  const found = await getPage(c, "ws_inbox");
  if (found) return found;
  const t = now();
  await c.db
    .prepare(
      `INSERT INTO page (id, parent_page_id, collection_id, title, icon, properties_json, position, status, is_ai, actor, created_at, updated_at)
       VALUES ('ws_inbox', NULL, NULL, 'Inbox', '📥', '{}', -1, 'active', 0, 'human', ?, ?)`,
    )
    .bind(t, t)
    .run();
  return (await getPage(c, "ws_inbox"))!;
}

export async function listInbox(c: Ctx): Promise<RoleRow[]> {
  const rows = decorate(await pagesWithRole(c, "sources"));
  return rows.filter((r) => r.props.status === "inbox").sort((a, b) => b.created_at - a.created_at);
}

export function listPageSources(c: Ctx, pageId: string): Promise<RoleRow[]> {
  return pagesWithRole(c, "sources", { pageId }).then(decorate);
}

export async function listSources(c: Ctx, q?: string, limit = 20): Promise<RoleRow[]> {
  const rows = decorate(await pagesWithRole(c, "sources"));
  const term = q?.trim().toLowerCase();
  const filtered = term
    ? rows.filter((r) => r.title.toLowerCase().includes(term) || String(r.props.url ?? "").toLowerCase().includes(term))
    : rows;
  return filtered.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
}

/** Save a raw input immediately. Never blocks on a fetch; queues async ingest. */
export async function capture(c: Ctx, input: z.input<typeof captureInput> & { page_id?: string }): Promise<Page> {
  const data = captureInput.parse(input);
  const target = input.page_id ?? data.workspace_id ?? (await inboxPage(c)).id;
  const col = await ensureRoleCollection(c, target, "sources");
  const page = await createPage(c, {
    collection_id: col.id,
    title: data.title?.trim() || data.url || data.kind,
    properties: { kind: data.kind, url: data.url ?? null, status: "inbox", captured: now() },
  });
  // The captured payload becomes the page body, so a saved note is readable.
  if (data.raw?.trim()) {
    await writeBlocks(c, page.id, [{ op: "replace_content", content: data.raw }]);
  }

  const inline = (INLINE_SOURCE_KINDS as readonly string[]).includes(data.kind);
  if (!inline && c.env.JOBS) await c.env.JOBS.send({ type: "ingest_source", source_id: page.id });
  else if (inline && data.url && c.env.JOBS) await c.env.JOBS.send({ type: "enrich_source", source_id: page.id });
  return (await getPage(c, page.id))!;
}

/** File a capture into a page: move it into that page's Sources collection. */
export async function fileSource(c: Ctx, sid: string, pageId: string | null, patch: { title?: string; status?: string } = {}): Promise<Page> {
  const existing = await getPage(c, sid);
  if (!existing) throw new RuleError(`source ${sid} not found`, 404);
  if (pageId) {
    const col = await ensureRoleCollection(c, pageId, "sources");
    await c.db.prepare(`UPDATE page SET collection_id = ?, updated_at = ? WHERE id = ?`).bind(col.id, now(), sid).run();
  }
  return updatePage(c, sid, {
    ...(patch.title ? { title: patch.title } : {}),
    ...(patch.status ? { properties: { status: patch.status } } : {}),
  });
}

/** Delete a capture. Insights derived from it are detached rather than deleted —
 *  a knowledge note has to outlive the link it came from. Now that both are
 *  pages, that detach is a property edit rather than a foreign key problem. */
export async function deleteSource(c: Ctx, sid: string): Promise<void> {
  const derived = await all<{ id: string; properties_json: string }>(
    c, `SELECT id, properties_json FROM page WHERE json_extract(properties_json, '$.source_id') = ?`, sid,
  );
  for (const d of derived) await updatePage(c, d.id, { properties: { source_id: null } });
  await deletePage(c, sid);
  if (derived.length) await logEvent(c, "update", "page", sid, { detached_insights: derived.length });
}

// ---- Insights ---------------------------------------------------------------

export function listInsights(c: Ctx, pageId?: string): Promise<RoleRow[]> {
  // Proposed insights are excluded: until accepted they are a suggestion, not
  // knowledge, and listing them here would put them in front of agents as fact.
  return pagesWithRole(c, "insights", { pageId })
    .then(decorate)
    .then((rows) => rows.filter((r) => r.props.proposed !== true));
}

export async function createInsight(c: Ctx, input: z.input<typeof createInsightInput> & { page_id?: string }): Promise<Page> {
  const data = createInsightInput.parse(input);
  const target = input.page_id ?? data.workspace_id;
  if (!target) throw new RuleError("page_id is required", 400);
  const col = await ensureRoleCollection(c, target, "insights");
  const page = await createPage(c, {
    collection_id: col.id,
    title: data.title,
    properties: { source_id: data.source_id ?? null, is_ai: c.actor.startsWith("ai:") },
  });
  await writeBlocks(c, page.id, [{ op: "replace_content", content: data.body }]);
  if (c.env.JOBS) await c.env.JOBS.send({ type: "embed_insight", insight_id: page.id });
  return (await getPage(c, page.id))!;
}

export async function updateInsight(c: Ctx, iid: string, patch: { title?: string; body?: string }): Promise<Page> {
  if (patch.body) await writeBlocks(c, iid, [{ op: "replace_content", content: patch.body }]);
  const page = patch.title ? await updatePage(c, iid, { title: patch.title }) : (await getPage(c, iid))!;
  if (c.env.JOBS) await c.env.JOBS.send({ type: "embed_insight", insight_id: iid });
  return page;
}

export async function deleteInsight(c: Ctx, iid: string): Promise<void> {
  if (c.env.VECTORIZE) {
    try { await c.env.VECTORIZE.deleteByIds([iid]); } catch { /* best-effort */ }
  }
  await deletePage(c, iid);
}

// ---- Decisions --------------------------------------------------------------

export function listDecisions(c: Ctx, pageId?: string): Promise<RoleRow[]> {
  return pagesWithRole(c, "decisions", { pageId }).then(decorate);
}

export async function recordDecision(c: Ctx, input: z.input<typeof recordDecisionInput> & { page_id?: string }): Promise<Page> {
  const data = recordDecisionInput.parse(input);
  const target = input.page_id ?? data.workspace_id;
  const col = await ensureRoleCollection(c, target, "decisions");
  const page = await createPage(c, {
    collection_id: col.id,
    title: data.title,
    properties: {
      decided_on: data.decided_on ?? now(),
      impact: data.impact ?? null,
      alternatives: data.alternatives ?? null,
    },
  });
  await writeBlocks(c, page.id, [{ op: "replace_content", content: data.rationale }]);
  return (await getPage(c, page.id))!;
}

export const deleteDecision = deletePage;

// ---- Shared helpers ---------------------------------------------------------

/** Open tasks across everything, soonest-due first — the Daily 3's candidate
 *  pool and the weekly review's backlog. */
export async function openTasks(c: Ctx, limit = 50): Promise<RoleRow[]> {
  const rows = await listTasks(c);
  return rows
    .filter((r) => r.props.status !== "done")
    .sort((a, b) => {
      const ad = a.props.due_date as number | null, bd = b.props.due_date as number | null;
      if (ad && bd) return ad - bd;
      if (ad) return -1;
      if (bd) return 1;
      return (Number(b.props.priority) || 0) - (Number(a.props.priority) || 0);
    })
    .slice(0, limit);
}

export function taskById(c: Ctx, tid: string): Promise<Page | null> {
  return first<Page>(c, `SELECT * FROM page WHERE id = ?`, tid);
}

// ---- Proposals --------------------------------------------------------------
// Machine-extracted insights are created with `proposed: true` and stay out of
// every read path until accepted. The guard belongs in the queries rather than
// in the callers: a proposal that leaks into search or context assembly would
// be indistinguishable from knowledge you actually endorsed.

/** Insights awaiting review, newest first. */
export async function listProposals(c: Ctx): Promise<RoleRow[]> {
  const rows = decorate(await pagesWithRole(c, "insights"));
  return rows.filter((r) => r.props.proposed === true).sort((a, b) => b.created_at - a.created_at);
}

/** Accept a proposal: it becomes ordinary knowledge and joins the read paths. */
export async function acceptProposal(c: Ctx, iid: string): Promise<Page> {
  const page = await updatePage(c, iid, { properties: { proposed: null, accepted_at: now() } });
  if (c.env.JOBS) await c.env.JOBS.send({ type: "embed_insight", insight_id: iid });
  await logEvent(c, "accept", "page", iid, { title: page.title });
  return page;
}

/** Reject a proposal. Deleted rather than archived: an insight you declined is
 *  not a thing you want surfacing again, and the source it came from is intact. */
export async function rejectProposal(c: Ctx, iid: string): Promise<void> {
  const page = await getPage(c, iid);
  await deletePage(c, iid);
  await logEvent(c, "reject", "page", iid, { title: page?.title ?? "" });
}
