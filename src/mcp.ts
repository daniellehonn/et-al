// The MCP surface: two layers (data + intent) over the same store functions the
// REST API uses. Streamable HTTP, JSON-RPC 2.0. Every tool runs under a Ctx with
// actor='ai:<client>', so a write cannot forget to attribute itself.
//
// Documents are the exception to immediate writes: agents get `propose_document_patch`
// (surfaced as Accept/Reject in the web app), never a direct block write.
//
// Delete tools exist for tasks, objectives, sources, insights, and decisions —
// immediate but attributed, and skills tell agents to confirm first. Two deletes
// are deliberately NOT exposed to agents: deleting a document (it is co-owned and
// patch-gated) and deleting a workspace (a tree-wide cascade). Both stay human-only.
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
    description: "The object model, per-entity vocabularies, and the product's rules.",
    inputSchema: obj({}),
    handler: async () => ({
      entities: store /* re-exported constants */ && {
        note: "Workspace(tree) → Objectives, Tasks, Documents, Sources, Insights, Decisions; Relationships connect anything.",
      },
      rules: [
        "AI writes are immediate but attributed actor:'ai'.",
        "Documents change only via propose_document_patch (human Accept/Reject).",
        "Source.raw and Decisions are immutable.",
        "Capture rather than invent structure when the destination is unclear.",
      ],
    }),
  },
  {
    name: "open_workspace",
    description: "Resolve a 'Life → Build → et al.' path to a workspace and return it with its inherited context.",
    inputSchema: obj({ path: str }, ["path"]),
    handler: async (c, a) => {
      const ws = await store.resolvePath(c, String(a.path));
      if (!ws) return { error: "no workspace at that path" };
      return { workspace: ws, inherited: await store.ancestors(c, ws.id) };
    },
  },
  {
    name: "get_home",
    description: "Daily 3, workspace health, inbox count, and recent activity.",
    inputSchema: obj({}),
    handler: (c) => store.getHome(c),
  },
  // ---- context engine ----
  {
    name: "build_context",
    description: "Assemble the context package for a workspace: inherited ancestors, objectives, open tasks, documents, recent decisions, and query-related material.",
    inputSchema: obj({ workspace_id: str, query: str }, ["workspace_id"]),
    handler: (c, a) => store.buildContext(c, String(a.workspace_id), a.query ? String(a.query) : undefined),
  },
  // ---- workspaces / objectives / tasks ----
  { name: "list_workspaces", description: "List workspaces (optionally under a parent).", inputSchema: obj({ parent_id: str }), handler: (c, a) => store.listWorkspaces(c, a.parent_id as string | undefined) },
  { name: "create_workspace", description: "Create a workspace.", inputSchema: obj({ parent_id: str, type: str, title: str }, ["title"]), handler: (c, a) => store.createWorkspace(c, a as never) },
  { name: "update_workspace", description: "Update a workspace.", inputSchema: obj({ id: str }, ["id"]), handler: (c, a) => store.updateWorkspace(c, String(a.id), a as never) },
  { name: "move_workspace", description: "Relocate a workspace under a new parent (cycle-checked).", inputSchema: obj({ id: str, new_parent_id: str }, ["id"]), handler: (c, a) => store.moveWorkspace(c, String(a.id), (a.new_parent_id as string) ?? null) },
  { name: "list_objectives", description: "List a workspace's objectives.", inputSchema: obj({ workspace_id: str }, ["workspace_id"]), handler: (c, a) => store.listObjectives(c, String(a.workspace_id)) },
  { name: "create_objective", description: "Create an objective.", inputSchema: obj({ workspace_id: str, title: str }, ["workspace_id", "title"]), handler: (c, a) => store.createObjective(c, a as never) },
  { name: "update_objective", description: "Update an objective.", inputSchema: obj({ id: str }, ["id"]), handler: (c, a) => store.updateObjective(c, String(a.id), a as never) },
  { name: "list_tasks", description: "List a workspace's tasks (optional status/objective filter).", inputSchema: obj({ workspace_id: str, status: str, objective_id: str }, ["workspace_id"]), handler: (c, a) => store.listTasks(c, String(a.workspace_id), { status: a.status as string, objective_id: a.objective_id as string }) },
  { name: "create_task", description: "Create a task. Pass objective_id to file it under an objective (its parent-objective field, not a relationship edge).", inputSchema: obj({ workspace_id: str, title: str, objective_id: str, priority: num, notes: str, due_date: num }, ["workspace_id", "title"]), handler: (c, a) => store.createTask(c, a as never) },
  { name: "update_task", description: "Update a task. Set objective_id to move it under an objective (or null to detach); also status, priority, due_date, title, notes.", inputSchema: obj({ id: str, title: str, status: str, objective_id: str, priority: num, notes: str, due_date: num }, ["id"]), handler: (c, a) => store.updateTask(c, String(a.id), a as never) },
  { name: "complete_task", description: "Mark a task done.", inputSchema: obj({ id: str }, ["id"]), handler: (c, a) => store.completeTask(c, String(a.id)) },
  { name: "delete_task", description: "Delete a task. Destructive — confirm with the user first.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.deleteTask(c, String(a.id)); return { ok: true }; } },
  { name: "delete_objective", description: "Delete an objective (its tasks survive, detached). Destructive — confirm first.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.deleteObjective(c, String(a.id)); return { ok: true }; } },
  // ---- daily 3 ----
  { name: "get_daily3", description: "Today's three focus slots, status, and streak.", inputSchema: obj({ date: str }), handler: (c, a) => store.getDaily3(c, a.date as string | undefined) },
  { name: "set_daily3", description: "Set/replace the three focus tasks (before the day is locked).", inputSchema: obj({ task_ids: { type: "array", items: str }, date: str }, ["task_ids"]), handler: (c, a) => store.setDaily3(c, a as never) },
  { name: "confirm_daily3", description: "Lock the Daily 3 for the day.", inputSchema: obj({ date: str }), handler: (c, a) => store.confirmDaily3(c, a.date as string | undefined) },
  // ---- inbox / sources / insights ----
  { name: "capture", description: "Save a raw input to the inbox immediately (raw payload is immutable).", inputSchema: obj({ kind: str, title: str, url: str, raw: str, workspace_id: str }, ["kind"]), handler: (c, a) => store.capture(c, a as never) },
  { name: "list_inbox", description: "Sources still awaiting processing.", inputSchema: obj({}), handler: (c) => store.listInbox(c) },
  { name: "get_source", description: "A source with its parsed metadata.", inputSchema: obj({ id: str }, ["id"]), handler: (c, a) => store.getSource(c, String(a.id)) },
  { name: "delete_source", description: "Delete a captured source. Destructive — confirm with the user first.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.deleteSource(c, String(a.id)); return { ok: true }; } },
  { name: "create_insight", description: "Create a knowledge node (optionally linked to its source).", inputSchema: obj({ title: str, body: str, workspace_id: str, source_id: str }, ["title", "body"]), handler: (c, a) => store.createInsight(c, a as never) },
  { name: "list_insights", description: "List insights (optionally within a workspace).", inputSchema: obj({ workspace_id: str }), handler: (c, a) => store.listInsights(c, a.workspace_id as string | undefined) },
  { name: "update_insight", description: "Refine an insight's title or body.", inputSchema: obj({ id: str, title: str, body: str }, ["id"]), handler: (c, a) => store.updateInsight(c, String(a.id), a as never) },
  { name: "delete_insight", description: "Delete an insight. Destructive — confirm with the user first.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.deleteInsight(c, String(a.id)); return { ok: true }; } },
  // ---- documents (patch-only for agents) ----
  { name: "get_document", description: "A document's metadata.", inputSchema: obj({ id: str }, ["id"]), handler: (c, a) => store.getDocument(c, String(a.id)) },
  { name: "list_documents", description: "A workspace's documents.", inputSchema: obj({ workspace_id: str }, ["workspace_id"]), handler: (c, a) => store.listDocuments(c, String(a.workspace_id)) },
  { name: "get_blocks", description: "A document's ordered blocks.", inputSchema: obj({ document_id: str }, ["document_id"]), handler: (c, a) => store.getBlocks(c, String(a.document_id)) },
  { name: "create_document", description: "Create a document.", inputSchema: obj({ workspace_id: str, title: str, type: str }, ["workspace_id", "title"]), handler: (c, a) => store.createDocument(c, a as never) },
  { name: "propose_document_patch", description: "Propose a change to a document; the human accepts/rejects in the web app. The ONLY way an agent edits a document. Simplest: one op [{op:'replace_content', content:'<markdown>'}] to replace the whole body (parsed into blocks). Granular ops also supported: insert {after,type,content:{text}}, update {id,content:{text}}, delete {id}, move {id,after}.", inputSchema: obj({ document_id: str, ops: { type: "array", items: { type: "object" } }, summary: str }, ["document_id", "ops", "summary"]), handler: (c, a) => store.proposePatch(c, String(a.document_id), a.ops as never, String(a.summary)) },
  { name: "get_document_patches", description: "Pending/resolved patches for a document.", inputSchema: obj({ document_id: str, status: str }, ["document_id"]), handler: (c, a) => store.listPatches(c, String(a.document_id), a.status as string | undefined) },
  // ---- decisions / graph / search ----
  { name: "record_decision", description: "Record an immutable decision (title, rationale, alternatives, impact).", inputSchema: obj({ workspace_id: str, title: str, rationale: str }, ["workspace_id", "title", "rationale"]), handler: (c, a) => store.recordDecision(c, a as never) },
  { name: "list_decisions", description: "A workspace's decisions.", inputSchema: obj({ workspace_id: str }, ["workspace_id"]), handler: (c, a) => store.listDecisions(c, String(a.workspace_id)) },
  { name: "delete_decision", description: "Delete a decision record (content is immutable, but the record can be removed). Destructive — confirm first.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.deleteDecision(c, String(a.id)); return { ok: true }; } },
  { name: "relate", description: "Create a typed edge between two objects.", inputSchema: obj({ source_type: str, source_id: str, target_type: str, target_id: str, type: str }, ["source_type", "source_id", "target_type", "target_id", "type"]), handler: (c, a) => store.relate(c, a as never) },
  { name: "get_backlinks", description: "Everything referencing an object.", inputSchema: obj({ type: str, id: str }, ["type", "id"]), handler: (c, a) => store.getBacklinks(c, String(a.type), String(a.id)) },
  { name: "search", description: "Full-text search across every entity.", inputSchema: obj({ query: str }, ["query"]), handler: (c, a) => store.search(c, String(a.query), {}) },
  // ---- health & review ----
  { name: "get_workspace_health", description: "The activity/flow health score for a workspace (or all).", inputSchema: obj({ workspace_id: str }), handler: (c, a) => (a.workspace_id ? store.workspaceHealth(c, String(a.workspace_id)) : store.allHealth(c)) },
  { name: "weekly_review", description: "The raw material for a guided weekly review.", inputSchema: obj({}), handler: (c) => store.getWeeklyReview(c) },
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
        serverInfo: { name: "et-al", version: "7.0.0" },
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
