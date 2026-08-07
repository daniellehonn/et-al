// The MCP surface: two layers (data + intent) over the same store functions the
// REST API uses. Streamable HTTP, JSON-RPC 2.0. Every tool runs under a Ctx with
// actor='ai:<client>', so a write cannot forget to attribute itself.
//
// Page BODIES are the exception to immediate writes: agents get `propose_page_patch`
// (surfaced as Accept/Reject in the web app), never a direct block write. Page
// properties and metadata they may write directly — a status is a fact, a body is
// co-owned prose.
//
// Delete tools exist for tasks, sources and insights — immediate but attributed,
// and skills tell agents to confirm first. `delete_page` is deliberately NOT
// exposed: deleting a page cascades through its children and the collections it
// owns, which stays a human decision.
import type { Env } from "./schema";
import * as store from "./store";

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  handler: (c: store.Ctx, args: Json) => Promise<unknown>;
}

const str = { type: "string" };
const num = { type: "number" };
const obj = (props: Json, required: string[] = []): Json => ({ type: "object", properties: props, required });

const TOOLS: Tool[] = [
  // ---- orientation ----
  {
    name: "get_schema",
    description: "The object model and the product's rules. Read this first — v8 has two primitives, not seven entity types.",
    inputSchema: obj({}),
    handler: async () => ({
      model: {
        page: "The universal primitive. A project, a note, a task and a saved link are all pages: a title, an icon, a body of blocks, and child pages. Pages nest freely.",
        collection: "A set of pages with typed properties and saved views — a database. A collection is owned by a page and placed in its body by a block of type 'collection'.",
        role: "A collection may carry a role (tasks|sources|insights|decisions). The role is how you know what the pages inside mean; the user is free to rename, restyle or relocate the collection without breaking that.",
        properties: "A page in a collection carries property values keyed by the collection's schema. Task status/priority/due_date live here — they are not columns any more.",
      },
      rules: [
        "AI writes are immediate but attributed actor:'ai:<client>'.",
        "A page BODY changes only via propose_page_patch (human Accept/Reject). Properties and page metadata can be written directly.",
        "Decisions are immutable once recorded.",
        "Prefer creating a page over inventing structure. Do not create collections the user did not ask for.",
      ],
      career_blocks: {
        note: "When a project wraps, review it (build_context / list_tasks) and propose_page_patch inserting career blocks the user recycles into a resume. Get existing ones with get_career_blocks.",
        insert_via: "propose_page_patch ops: [{op:'insert', after:<id|null>, type:'<career type>', content:{...}}]",
        types: {
          accomplishment: "{ situation, task, action, result, bullet } — STAR + a one-line resume bullet",
          resume_bullet: "{ text, skills, date } — one polished, quantified line",
          role: "{ company, title, start, end, location, bullets: string[] } — a CV entry",
          project: "{ name, role, tech, outcome, link } — a portfolio project highlight",
        },
      },
    }),
  },
  {
    name: "open_page",
    description: "Resolve a 'Side Projects/et al.' style path to a page and return it with its ancestors.",
    inputSchema: obj({ path: str }, ["path"]),
    handler: async (c, a) => {
      const page = await store.resolvePagePath(c, String(a.path));
      if (!page) return { error: "no page at that path" };
      return { page, inherited: await store.getAncestors(c, page.id) };
    },
  },
  { name: "get_home", description: "Daily 3, page health, inbox count, and recent activity.", inputSchema: obj({}), handler: (c) => store.getHome(c) },
  {
    name: "build_context",
    description: "Assemble the context package for a page: its ancestors, its own body, child pages, collections, open tasks, recent decisions, and query-related material.",
    inputSchema: obj({ page_id: str, query: str }, ["page_id"]),
    handler: (c, a) => store.buildContext(c, String(a.page_id), a.query ? String(a.query) : undefined),
  },

  // ---- pages ----
  { name: "get_page", description: "A page with its properties.", inputSchema: obj({ id: str }, ["id"]), handler: (c, a) => store.getPage(c, String(a.id)) },
  { name: "get_page_tree", description: "The whole page tree — the sidebar. Collection rows are excluded.", inputSchema: obj({}), handler: (c) => store.getPageTree(c) },
  { name: "list_child_pages", description: "The direct children of a page (omit parent_page_id for the roots).", inputSchema: obj({ parent_page_id: str }), handler: (c, a) => store.listChildren(c, (a.parent_page_id as string | undefined) ?? null) },
  { name: "get_blocks", description: "A page's body, flat but in document order. parent_block_id gives the nesting.", inputSchema: obj({ page_id: str }, ["page_id"]), handler: (c, a) => store.getBlocks(c, String(a.page_id)) },
  { name: "create_page", description: "Create a page. Pass parent_page_id to nest it, or collection_id to add a row to a collection.", inputSchema: obj({ parent_page_id: str, collection_id: str, title: str, icon: str, properties: { type: "object" } }), handler: (c, a) => store.createPage(c, a as never) },
  { name: "update_page", description: "Update a page's title, icon, cover, status, or properties. Properties merge — pass null for a key to clear it. Does NOT change the body; use propose_page_patch for that.", inputSchema: obj({ id: str, title: str, icon: str, cover: str, status: str, properties: { type: "object" } }, ["id"]), handler: (c, a) => store.updatePage(c, String(a.id), a as never) },
  { name: "move_page", description: "Re-parent a page in the tree (cycle-checked).", inputSchema: obj({ id: str, new_parent_page_id: str, position: num }, ["id"]), handler: (c, a) => store.movePage(c, String(a.id), a as never) },
  {
    name: "propose_page_patch",
    description: "Propose a change to a page's BODY; the human accepts/rejects in the web app. The ONLY way an agent edits a body. Simplest: one op [{op:'replace_content', content:'<markdown>'}] — indented list items become nested blocks. Granular ops also supported: insert {after,parent,type,content:{text}}, update {id,content:{text}}, delete {id}, move {id,after,parent}.",
    inputSchema: obj({ page_id: str, ops: { type: "array", items: { type: "object" } }, summary: str }, ["page_id", "ops", "summary"]),
    handler: (c, a) => store.proposePagePatch(c, String(a.page_id), a.ops as never, String(a.summary)),
  },
  { name: "get_page_patches", description: "Pending/resolved patches for a page.", inputSchema: obj({ page_id: str, status: str }, ["page_id"]), handler: (c, a) => store.listPatches(c, String(a.page_id), a.status as string | undefined) },

  // ---- collections ----
  { name: "list_collections", description: "The collections a page owns.", inputSchema: obj({ page_id: str }, ["page_id"]), handler: (c, a) => store.listCollections(c, String(a.page_id)) },
  { name: "get_collection", description: "A collection with its property schema.", inputSchema: obj({ id: str }, ["id"]), handler: (c, a) => store.getCollection(c, String(a.id)) },
  { name: "query_collection", description: "The rows of a collection, optionally filtered and sorted. filter: [{key,op,value}] with op is|is_not|is_empty|is_not_empty|contains|gt|lt|in. sort: [{key,dir}].", inputSchema: obj({ collection_id: str, filter: { type: "array", items: { type: "object" } }, sort: { type: "array", items: { type: "object" } }, limit: num }, ["collection_id"]), handler: (c, a) => store.queryCollection(c, String(a.collection_id), a as never) },
  { name: "create_collection", description: "Create a collection on a page. Pass a role (tasks|sources|insights|decisions) to get its standard property schema, or a custom schema of [{key,name,type,options}].", inputSchema: obj({ parent_page_id: str, title: str, icon: str, role: str, schema: { type: "array", items: { type: "object" } } }, ["parent_page_id"]), handler: (c, a) => store.createCollection(c, a as never) },
  { name: "update_collection", description: "Rename a collection or change its property schema.", inputSchema: obj({ id: str, title: str, icon: str, schema: { type: "array", items: { type: "object" } } }, ["id"]), handler: (c, a) => store.updateCollection(c, String(a.id), a as never) },
  { name: "list_views", description: "A collection's saved views.", inputSchema: obj({ collection_id: str }, ["collection_id"]), handler: (c, a) => store.listViews(c, String(a.collection_id)) },
  { name: "create_view", description: "Add a view to a collection (table|board|list|gallery|calendar). group_by is a property key, for boards.", inputSchema: obj({ collection_id: str, name: str, type: str, group_by: str }, ["collection_id"]), handler: (c, a) => store.createView(c, a as never) },

  // ---- tasks (pages in a 'tasks' collection) ----
  { name: "list_tasks", description: "Tasks. All of them live in one collection; `page_id` filters to tasks derived from a given page, `section` to a section (school/clubs/projects/...). Each row is a page; its task fields are in `props`.", inputSchema: obj({ page_id: str, status: str, section: str }), handler: (c, a) => store.listTasks(c, { pageId: a.page_id as string | undefined, status: a.status as string | undefined, section: a.section as string | undefined }) },
  { name: "task_tree", description: "The whole task system: goals with their tasks and subtasks, grouped by section, each carrying progress (done/total across its subtree) and whether it is overdue or due soon.", inputSchema: obj({}), handler: (c) => store.taskTree(c) },
  { name: "add_task_section", description: "Add a new section (school, clubs, fitness, …).", inputSchema: obj({ name: str }, ["name"]), handler: async (c, a) => { const { collectionId } = await store.tasksHome(c); return store.addSelectOption(c, collectionId, "section", String(a.name)); } },
  { name: "tasks_by_section", description: "Every open task grouped by section, each group sorted by urgency. This is the whole task system in one call.", inputSchema: obj({}), handler: (c) => store.tasksBySection(c) },
  { name: "create_task", description: "Create a task, goal or subtask — they are one kind of thing. Pass `due_date` (unix ms) to make it a goal with a deadline, `parent_id` to nest it under another (three levels max: goal → task → subtask), `section` to file it, and `page_id` to record which page it came from. A subtask inherits its parent's section.", inputSchema: obj({ title: str, section: str, parent_id: str, due_date: num, page_id: str, notes: str, priority: num }, ["title"]), handler: (c, a) => store.createTask(c, a as never) },
  { name: "update_task", description: "Update a task's status, priority, due_date, title or notes.", inputSchema: obj({ id: str, title: str, status: str, priority: num, notes: str, due_date: num }, ["id"]), handler: (c, a) => store.updateTask(c, String(a.id), a as never) },
  { name: "complete_task", description: "Mark a task done.", inputSchema: obj({ id: str }, ["id"]), handler: (c, a) => store.completeTask(c, String(a.id)) },
  { name: "delete_task", description: "Delete a task. Destructive — confirm with the user first.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.deleteTask(c, String(a.id)); return { ok: true }; } },

  // ---- daily 3 ----
  { name: "get_daily3", description: "Today's three focus slots, status, and streak.", inputSchema: obj({ date: str }), handler: (c, a) => store.getDaily3(c, a.date as string | undefined) },
  { name: "set_daily3", description: "Set/replace the three focus tasks (before the day is locked).", inputSchema: obj({ task_ids: { type: "array", items: str }, date: str }, ["task_ids"]), handler: (c, a) => store.setDaily3(c, a as never) },
  { name: "confirm_daily3", description: "Lock the Daily 3 for the day.", inputSchema: obj({ date: str }), handler: (c, a) => store.confirmDaily3(c, a.date as string | undefined) },

  // ---- capture & knowledge ----
  { name: "capture", description: "Save a raw input to the inbox immediately. Becomes a page in a Sources collection; `raw` becomes its body.", inputSchema: obj({ kind: str, title: str, url: str, raw: str, page_id: str }, ["kind"]), handler: (c, a) => store.capture(c, a as never) },
  { name: "list_inbox", description: "Captures still awaiting processing.", inputSchema: obj({}), handler: (c) => store.listInbox(c) },
  { name: "list_page_sources", description: "Material saved into a page — its shelf of filed captures.", inputSchema: obj({ page_id: str }, ["page_id"]), handler: (c, a) => store.listPageSources(c, String(a.page_id)) },
  { name: "file_source", description: "File a capture into a page, and/or relabel it or mark it processed.", inputSchema: obj({ id: str, page_id: str, title: str, status: str }, ["id"]), handler: (c, a) => store.fileSource(c, String(a.id), (a.page_id as string | undefined) ?? null, a as never) },
  { name: "delete_source", description: "Delete a captured source. Insights derived from it survive, detached. Destructive — confirm with the user first.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.deleteSource(c, String(a.id)); return { ok: true }; } },
  { name: "create_insight", description: "Create a knowledge note on a page (optionally linked to the source it came from). The body is markdown.", inputSchema: obj({ page_id: str, title: str, body: str, source_id: str }, ["page_id", "title", "body"]), handler: (c, a) => store.createInsight(c, a as never) },
  { name: "list_insights", description: "Knowledge notes, across everything or within one page.", inputSchema: obj({ page_id: str }), handler: (c, a) => store.listInsights(c, a.page_id as string | undefined) },
  { name: "update_insight", description: "Refine a knowledge note's title or body.", inputSchema: obj({ id: str, title: str, body: str }, ["id"]), handler: (c, a) => store.updateInsight(c, String(a.id), a as never) },
  { name: "delete_insight", description: "Delete a knowledge note. Destructive — confirm with the user first.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.deleteInsight(c, String(a.id)); return { ok: true }; } },

  // ---- decisions & graph ----
  { name: "record_decision", description: "Record an immutable decision (title, rationale, alternatives, impact).", inputSchema: obj({ page_id: str, title: str, rationale: str, impact: str }, ["page_id", "title", "rationale"]), handler: (c, a) => store.recordDecision(c, a as never) },
  { name: "list_decisions", description: "Decisions, across everything or within one page.", inputSchema: obj({ page_id: str }), handler: (c, a) => store.listDecisions(c, a.page_id as string | undefined) },
  { name: "relate", description: "Create a typed edge between two pages.", inputSchema: obj({ source_id: str, target_id: str, type: str }, ["source_id", "target_id", "type"]), handler: (c, a) => store.relate(c, { source_type: "page", target_type: "page", ...(a as object) } as never) },
  { name: "get_backlinks", description: "Everything referencing a page.", inputSchema: obj({ id: str }, ["id"]), handler: (c, a) => store.getBacklinks(c, "page", String(a.id)) },
  { name: "search", description: "Search across everything. Hybrid: keyword matching over all pages, plus semantic matching over knowledge notes, so a page phrased differently from the query still surfaces.", inputSchema: obj({ query: str }, ["query"]), handler: (c, a) => store.search(c, String(a.query), {}) },

  // ---- health & review ----
  { name: "get_page_health", description: "The activity/flow health score for a page (or every page that owns tasks).", inputSchema: obj({ page_id: str }), handler: (c, a) => (a.page_id ? store.pageHealth(c, String(a.page_id)) : store.allHealth(c)) },
  { name: "weekly_review", description: "The raw material for a guided weekly review.", inputSchema: obj({}), handler: (c) => store.getWeeklyReview(c) },
  { name: "get_career_blocks", description: "Every career block (accomplishment/STAR, resume bullet, role) across the user's work — the raw material for generating a resume, LinkedIn post, or STAR story. Optionally scope to one page.", inputSchema: obj({ page_id: str }), handler: (c, a) => store.listCareerBlocks(c, a.page_id as string | undefined) },
  // ---- proposals ----
  { name: "list_proposals", description: "Machine-extracted insights awaiting your review. They are excluded from list_insights, search and build_context until accepted — a proposal is a suggestion, not knowledge.", inputSchema: obj({}), handler: (c) => store.listProposals(c) },
  { name: "accept_proposal", description: "Accept a proposed insight. It becomes ordinary knowledge and is embedded for semantic search.", inputSchema: obj({ id: str }, ["id"]), handler: (c, a) => store.acceptProposal(c, String(a.id)) },
  { name: "reject_proposal", description: "Reject a proposed insight and delete it. The source it came from is untouched.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.rejectProposal(c, String(a.id)); return { ok: true }; } },

  // ---- automations ----
  { name: "list_automations", description: "Recurring tasks et al. runs on a schedule.", inputSchema: obj({}), handler: (c) => store.listAutomations(c) },
  { name: "create_automation", description: "Schedule recurring work. `schedule` is a 5-field cron expression evaluated in the user's timezone. action 'message' texts the task verbatim; 'digest' appends open tasks and pending reviews.", inputSchema: obj({ name: str, schedule: str, task: str, action: str, timezone: str }, ["name", "schedule", "task"]), handler: (c, a) => store.createAutomation(c, a as never) },
  { name: "update_automation", description: "Change an automation's schedule, task, or enabled state.", inputSchema: obj({ id: str, name: str, schedule: str, task: str, enabled: { type: "boolean" } }, ["id"]), handler: (c, a) => store.updateAutomation(c, String(a.id), a as never) },
  { name: "delete_automation", description: "Delete an automation. Destructive — confirm with the user first.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.deleteAutomation(c, String(a.id)); return { ok: true }; } },
  { name: "get_agent_activity", description: "Everything written by an AI agent.", inputSchema: obj({}), handler: (c) => store.getAgentActivity(c) },

];

// ---- JSON-RPC over Streamable HTTP ------------------------------------------

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleMcp(request: Request, env: Env, agentName: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  let body: { id?: unknown; method?: string; params?: Json };
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const { id, method, params } = body;
  const c = store.ctx(env, `ai:${agentName}`);

  try {
    if (method === "initialize") {
      return Response.json(rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "et-al", version: "8.0.0" },
      }));
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (method === "tools/list") {
      return Response.json(rpcResult(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }));
    }
    if (method === "tools/call") {
      const name = params?.name as string;
      const args = (params?.arguments as Json) ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return Response.json(rpcError(id, -32601, `unknown tool: ${name}`));
      const result = await tool.handler(c, args);
      return Response.json(rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }));
    }
    return Response.json(rpcError(id, -32601, `unknown method: ${method}`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(rpcError(id, -32000, message));
  }
}

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);
