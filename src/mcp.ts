// The MCP surface: the tools an agent works through, over the same store the
// REST API uses. Streamable HTTP, JSON-RPC 2.0. Every tool runs under a Ctx with
// actor='ai:<client>', so a write cannot forget to attribute itself.
//
// What an agent may do is the trust model, and it is decided here by omission:
//  - Facts are written directly and attributed: notes' titles and places,
//    tasks, captures, filing.
//  - Prose is only ever proposed. There is no tool that writes a note's body;
//    `propose_note_patch` queues a change for the user to accept or reject.
//  - Nothing here resolves a proposal or deletes a note. Approving and
//    destroying stay with the user, in the web app.
import { ZodError } from "zod";
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
const opt = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const TOOLS: Tool[] = [
  // ---- orient ----
  {
    name: "get_schema",
    description: "How et al. is organised and what you may do in it. Read this first.",
    inputSchema: obj({}),
    handler: async () => ({
      model: {
        note: "What the user writes: a title, a body of blocks, and child notes. Notes nest freely.",
        task: "What the user is doing: a title, a status (todo|doing|done), an optional due date (unix ms), optional subtasks, optionally the note it belongs to.",
        source: "What the user saved: a link or a snippet, captured first and filed into a note later. Links are fetched in the background.",
        proposal: "A suggested change waiting for the user: a patch to a note's body, or an insight extracted from a source.",
      },
      rules: [
        "Your writes are immediate and attributed to you (ai:<client>).",
        "You cannot write a note's body. Propose it with propose_note_patch; the user accepts or rejects it.",
        "You cannot accept or reject proposals, and you cannot delete notes. Those are the user's.",
        "Prefer adding to an existing note over creating a new one. Use search and get_note_tree first.",
      ],
    }),
  },
  { name: "search", description: "Search notes, tasks and sources. Hybrid: keyword matching, plus meaning-based matching over notes.", inputSchema: obj({ query: str }, ["query"]), handler: (c, a) => store.search(c, String(a.query)) },
  {
    name: "build_context",
    description: "Everything needed to work on a note in one call: the note, the notes it sits inside, its body, child notes, open tasks, filed sources, and related material for the query (or its title).",
    inputSchema: obj({ note_id: str, query: str }, ["note_id"]),
    handler: (c, a) => store.buildContext(c, String(a.note_id), opt(a.query)),
  },
  { name: "get_note_tree", description: "Every note, nested. Titles and ids only; no bodies.", inputSchema: obj({}), handler: (c) => store.getNoteTree(c) },
  {
    name: "get_note",
    description: "One note: its ancestors, its body as markdown (to read), and its blocks with ids (to target with update/insert/delete ops).",
    inputSchema: obj({ id: str }, ["id"]),
    handler: async (c, a) => {
      const note = await store.requireNote(c, String(a.id));
      const blocks = await store.getBlocks(c, note.id);
      return { note, ancestors: await store.getAncestors(c, note.id), markdown: store.bodyLines(store.toBody(blocks)).join("\n"), blocks };
    },
  },
  { name: "get_agent_activity", description: "Recent writes by agents, newest first.", inputSchema: obj({}), handler: (c) => store.getAgentActivity(c) },

  // ---- notes ----
  { name: "create_note", description: "Create an empty note, optionally under a parent. To give it a body, follow with propose_note_patch.", inputSchema: obj({ title: str, parent_id: str }, ["title"]), handler: (c, a) => store.createNote(c, { title: String(a.title), parent_id: opt(a.parent_id) }) },
  { name: "update_note", description: "Rename a note.", inputSchema: obj({ id: str, title: str }, ["id", "title"]), handler: (c, a) => store.updateNote(c, String(a.id), { title: String(a.title) }) },
  { name: "move_note", description: "Move a note under another (omit parent_id for the root).", inputSchema: obj({ id: str, parent_id: str }, ["id"]), handler: (c, a) => store.moveNote(c, String(a.id), { parent_id: opt(a.parent_id) ?? null }) },
  {
    name: "propose_note_patch",
    description: "Propose a change to a note's body; the user accepts or rejects it. The only way to change a body. Simplest: ops [{op:'replace_content', content:'<markdown>'}] — indented list items nest. Granular ops: insert {after, parent, type, content:{text}}, update {id, content:{text}}, delete {id}, move {id, after, parent}. Block ids come from get_note.",
    inputSchema: obj({ note_id: str, ops: { type: "array", items: { type: "object" } }, summary: str }, ["note_id", "ops", "summary"]),
    handler: (c, a) => store.proposePatch(c, { note_id: String(a.note_id), ops: a.ops as never, summary: String(a.summary) }),
  },

  // ---- tasks ----
  { name: "list_tasks", description: "Tasks, next-to-do first. Pass note_id to scope to one note, open:true to leave out done ones.", inputSchema: obj({ note_id: str, open: { type: "boolean" } }), handler: (c, a) => store.listTasks(c, { note_id: opt(a.note_id), open: a.open === true }) },
  { name: "create_task", description: "Create a task. parent_id makes it a subtask; note_id ties it to a note; due_at is unix ms.", inputSchema: obj({ title: str, parent_id: str, note_id: str, due_at: num }, ["title"]), handler: (c, a) => store.createTask(c, a as never) },
  { name: "update_task", description: "Change a task's title, status (todo|doing|done), due_at or note.", inputSchema: obj({ id: str, title: str, status: str, due_at: num, note_id: str }, ["id"]), handler: (c, a) => { const { id, ...patch } = a; return store.updateTask(c, String(id), patch as never); } },
  { name: "delete_task", description: "Delete a task and its subtasks. Destructive: confirm with the user first.", inputSchema: obj({ id: str }, ["id"]), handler: async (c, a) => { await store.deleteTask(c, String(a.id)); return { ok: true }; } },

  // ---- capture ----
  {
    name: "capture",
    description: "Save something to the inbox now: a url, some text, or both. A link is fetched in the background, and may produce proposed insights. Pass a `key` to make retries safe: the same key returns the same source. Saving a link already waiting in the inbox returns that one (already_captured: true).",
    inputSchema: obj({ url: str, text: str, title: str, note_id: str, key: str }),
    handler: (c, a) => { const { key, ...input } = a; return store.capture(c, input as never, opt(key)); },
  },
  { name: "list_inbox", description: "Captured sources not yet dealt with, newest first.", inputSchema: obj({}), handler: (c) => store.listInbox(c) },
  { name: "file_source", description: "File a source into a note (which also clears it from the inbox), retitle it, or set status done.", inputSchema: obj({ id: str, note_id: str, title: str, status: str }, ["id"]), handler: (c, a) => { const { id, ...patch } = a; return store.fileSource(c, String(id), patch as never); } },
  // Read-only on purpose: an agent that could accept would be approving
  // machine-written changes on the user's behalf.
  { name: "list_proposals", description: "Changes waiting for the user: your patches and extracted insights. Only the user can accept or reject them, in the web app.", inputSchema: obj({ note_id: str }), handler: (c, a) => store.listProposals(c, { note_id: opt(a.note_id) }) },
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
        serverInfo: { name: "et-al", version: "9.0.0" },
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
    // An agent reads this and retries, so bad input names the field at fault.
    const message = err instanceof ZodError
      ? `${err.issues[0]?.path.join(".") || "input"}: ${err.issues[0]?.message ?? "invalid"}`
      : err instanceof Error ? err.message : String(err);
    return Response.json(rpcError(id, -32000, message));
  }
}

