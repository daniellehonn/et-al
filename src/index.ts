import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
  DB: D1Database;
  ET_AL_API_KEY?: string;
  SECOND_BRAIN_API_KEY?: string;
  APP_NAME?: string;
}

// ---------------------------------------------------------------------------
// Canonical schema (v3) — the single source of truth for the DB CHECKs
// (migrations/0004), the REST API, the MCP tools, and the UI (renderApp injects
// this exact object, so the surfaces cannot drift). Bump SCHEMA_VERSION
// whenever an enum changes, and add a migration alongside.
//
// Spaces are contexts (where something lives); types are shapes (what it is).
// "identity" is a real, writable space — the layer above the other spaces.
// space = NULL means "unsorted": captured but not yet filed. Unsorted items are
// always visible in their own bucket; they never vanish from views.
//
// Link semantics:
//   parent_id — "traces to": hierarchy (task under goal, space goal under identity goal)
//   related   — lateral association between items (surfaced as Linked/Backlinks)
// ---------------------------------------------------------------------------
// Not exported: the Workers runtime requires every named module export to be a
// handler or Durable Object, so exporting a plain value fails at startup.
const SCHEMA_VERSION = 3;

const TYPE_KEYS = ["page", "goal", "idea", "task", "link"] as const;
const SPACE_KEYS = ["identity", "school", "career", "learning", "projects", "life", "saved"] as const;
const STATUS_KEYS = ["active", "paused", "done", "archived", "inbox"] as const;
// Virtual filter value: matches rows where space IS NULL.
const UNSORTED = "unsorted";
const SPACE_FILTER_KEYS = [...SPACE_KEYS, UNSORTED] as const;

type ItemType = (typeof TYPE_KEYS)[number];
type ItemSpace = (typeof SPACE_KEYS)[number];
type ItemStatus = (typeof STATUS_KEYS)[number];

const LINK_SEMANTICS = {
  parent_id: "Traces to (hierarchy): a task under a goal, a space goal under an identity goal. Drives get_children and the Cascade view.",
  related: "Lateral association: non-hierarchical links between items. Drives get_backlinks and the Linked/Backlinks panels.",
} as const;

const SCHEMA_INFO = {
  version: SCHEMA_VERSION,
  types: TYPE_KEYS,
  spaces: SPACE_KEYS,
  statuses: STATUS_KEYS,
  null_space: "unsorted — captured but not yet filed; always visible in the Unsorted bucket",
  space_filters: SPACE_FILTER_KEYS,
  link_semantics: LINK_SEMANTICS,
};

type ListOptions = {
  type: string | null;
  space: string | null; // "unsorted" is a virtual filter that maps to WHERE space IS NULL
  status: string | null;
  parent_id: string | null;
  limit: number;
  offset: number;
};

interface Item {
  id: string;
  type: ItemType;
  title: string;
  space: ItemSpace | null; // null = unsorted (not yet filed)
  status: ItemStatus;
  tags: string;
  metadata: string;
  content: string;
  related: string;
  parent_id: string | null;
  due_date: number | null;
  created_at: number;
  updated_at: number;
}

interface ItemResponse extends Omit<Item, "tags" | "metadata" | "related"> {
  tags: string[];
  metadata: Record<string, unknown>;
  related: string[];
}

const TYPES = new Set<ItemType>(TYPE_KEYS);
const SPACES = new Set<ItemSpace>(SPACE_KEYS);
const STATUSES = new Set<ItemStatus>(STATUS_KEYS);

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,x-api-key,authorization",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: jsonHeaders });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/mcp")) {
        assertMcpAuthorized(request, env);
        return createMcpHandler(createEtAlMcpServer(env))(request, env, ctx);
      }

      if (url.pathname === "/") return htmlResponse(renderApp(env.APP_NAME ?? "et al."));
      if (url.pathname === "/health") return json({ ok: true, service: "et-al", schema_version: SCHEMA_VERSION });
      if (url.pathname === "/api/schema") return json(SCHEMA_INFO);

      if (url.pathname === "/api/session") {
        if (request.method === "GET") {
          return json({ authenticated: await isAuthorized(request, env) });
        }
        if (request.method === "POST") {
          const payload = (await readJson(request)) as { key?: string };
          if ((payload.key ?? "") !== apiKeyOf(env)) return json({ error: "Unauthorized", code: 401 }, 401);
          const secure = url.protocol === "https:" ? " Secure;" : "";
          return json({ authenticated: true }, 200, {
            "set-cookie": `et_al_session=${await sessionToken(env)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=31536000`,
          });
        }
        if (request.method === "DELETE") {
          return json({ authenticated: false }, 200, {
            "set-cookie": "et_al_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
          });
        }
      }

      if (url.pathname === "/api/review" && request.method === "GET") {
        return json(await getDailyReview(env.DB));
      }

      if (url.pathname === "/api/identity/graph" && request.method === "GET") {
        return json(await getIdentityGraph(env.DB));
      }

      if (url.pathname === "/api/search" && request.method === "GET") {
        const query = url.searchParams.get("q")?.trim() ?? "";
        return json({ items: await searchItems(env.DB, query, readListOptions(url)) });
      }

      if (url.pathname === "/api/items" && request.method === "GET") {
        return json({ items: await listItems(env.DB, readListOptions(url)) });
      }

      if (url.pathname === "/api/items" && request.method === "POST") {
        await assertAuthorized(request, env);
        const payload = await readJson(request);
        return json(await createItem(env.DB, payload), 201);
      }

      const itemChildrenMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/children$/);
      if (itemChildrenMatch && request.method === "GET") {
        return json({ items: await getChildren(env.DB, itemChildrenMatch[1], readListOptions(url)) });
      }

      const itemBacklinksMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/backlinks$/);
      if (itemBacklinksMatch && request.method === "GET") {
        return json({ items: await getBacklinks(env.DB, itemBacklinksMatch[1]) });
      }

      const itemMatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
      if (itemMatch && request.method === "GET") {
        const item = await getItem(env.DB, itemMatch[1]);
        if (!item) return json({ error: "Item not found", code: 404 }, 404);
        return json(item);
      }

      if (itemMatch && request.method === "PATCH") {
        await assertAuthorized(request, env);
        const payload = await readJson(request);
        const item = await updateItem(env.DB, itemMatch[1], payload);
        if (!item) return json({ error: "Item not found", code: 404 }, 404);
        return json(item);
      }

      if (itemMatch && request.method === "DELETE") {
        await assertAuthorized(request, env);
        const result = await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(itemMatch[1]).run();
        if (result.meta.changes === 0) return json({ error: "Item not found", code: 404 }, 404);
        return json({ ok: true });
      }

      return json({ error: "Not found", code: 404 }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = message === "Unauthorized" ? 401 : message.startsWith("Invalid") ? 400 : 500;
      return json({ error: message, code: status }, status);
    }
  },
} satisfies ExportedHandler<Env>;

function createEtAlMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "et-al",
    version: "0.1.0",
  });

  server.registerTool(
    "get_schema",
    {
      description: "Canonical et al. schema: version, type/space/status enums, and link semantics (parent_id = traces-to hierarchy, related = lateral). Call this before writing if unsure which values are valid.",
      inputSchema: {},
    },
    async () => mcpJson(SCHEMA_INFO),
  );

  server.registerTool(
    "list_items",
    {
      description: "List et al. items filtered by type, space, status, parent_id, limit, and offset. space 'unsorted' matches items not yet filed into any space.",
      inputSchema: {
        type: z.enum(TYPE_KEYS).optional(),
        space: z.enum(SPACE_FILTER_KEYS).optional(),
        status: z.enum(STATUS_KEYS).optional(),
        parent_id: z.string().optional().describe("Filter by parent item ID"),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (input) => mcpJson({ items: await listItems(env.DB, normalizeListOptions(input)) }),
  );

  server.registerTool(
    "get_item",
    {
      description: "Get one et al. item by ID, including content, tags, metadata, and related item IDs.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      const item = await getItem(env.DB, id);
      return mcpJson(item ?? { error: "Item not found", code: 404 });
    },
  );

  server.registerTool(
    "create_item",
    {
      description: "Create a new et al. item. Omit space to land in the visible Unsorted bucket. Use the 'identity' space for the identity layer (who you are / want to become). Use task type with due_date for actionable to-dos. parent_id = traces-to hierarchy; related = lateral links.",
      inputSchema: {
        type: z.enum(TYPE_KEYS).default("idea"),
        title: z.string().min(1),
        space: z.enum(SPACE_KEYS).optional().describe("Omit for unsorted; 'identity' is the layer above the other spaces"),
        status: z.enum(STATUS_KEYS).optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        content: z.string().optional(),
        related: z.array(z.string()).optional().describe("Lateral links — IDs must exist or the write errors"),
        parent_id: z.string().optional().describe("Traces-to hierarchy: task under a goal, space goal under an identity goal. Must exist or the write errors"),
        due_date: z.number().int().optional().describe("Unix timestamp deadline, primarily for tasks"),
      },
    },
    async (input) => mcpJson(await createItem(env.DB, input)),
  );

  server.registerTool(
    "update_item",
    {
      description: "Partially update an existing et al. item by ID. Invalid values error instead of being silently coerced.",
      inputSchema: {
        id: z.string().min(1),
        type: z.enum(TYPE_KEYS).optional(),
        title: z.string().min(1).optional(),
        space: z.enum(SPACE_KEYS).nullable().optional().describe("null moves the item to unsorted"),
        status: z.enum(STATUS_KEYS).optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        content: z.string().optional(),
        related: z.array(z.string()).optional().describe("Lateral links — IDs must exist or the write errors"),
        parent_id: z.string().nullable().optional().describe("Traces-to hierarchy; must exist or the write errors. Set to null to remove parent"),
        due_date: z.number().int().nullable().optional().describe("Unix timestamp deadline; null to clear"),
      },
    },
    async ({ id, ...updates }) => {
      const item = await updateItem(env.DB, id, updates);
      return mcpJson(item ?? { error: "Item not found", code: 404 });
    },
  );

  server.registerTool(
    "delete_item",
    {
      description: "Delete one et al. item by ID.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      const result = await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
      return mcpJson({ ok: result.meta.changes > 0, deleted: result.meta.changes });
    },
  );

  server.registerTool(
    "search_items",
    {
      description: "Search et al. items across title, content, and tags. Optional filters narrow the result set. space 'unsorted' matches items not yet filed.",
      inputSchema: {
        query: z.string().min(1),
        type: z.enum(TYPE_KEYS).optional(),
        space: z.enum(SPACE_FILTER_KEYS).optional(),
        status: z.enum(STATUS_KEYS).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, ...filters }) => mcpJson({ items: await searchItems(env.DB, query, normalizeListOptions(filters)) }),
  );

  server.registerTool(
    "get_daily_review",
    {
      description: "Get a gentle daily review: active goals, recent inbox captures, recent ideas, and unprocessed link count.",
      inputSchema: {},
    },
    async () => mcpJson(await getDailyReview(env.DB)),
  );

  server.registerTool(
    "bulk_update",
    {
      description: "Update status, space, tags, or related IDs for multiple items at once. Invalid values error instead of being silently coerced.",
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).max(50),
        status: z.enum(STATUS_KEYS).optional(),
        space: z.enum(SPACE_KEYS).nullable().optional().describe("null moves items to unsorted"),
        tags: z.array(z.string()).optional(),
        related: z.array(z.string()).optional(),
      },
    },
    async ({ ids, ...updates }) => mcpJson(await bulkUpdateItems(env.DB, ids, updates)),
  );

  server.registerTool(
    "triage_inbox",
    {
      description: "Inspect inbox and dump captures and suggest a type, space, tags, related items, and next action using deterministic heuristics. Read-only; use update_item or bulk_update to apply decisions.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10),
        include_content: z.boolean().default(false),
        related_limit: z.number().int().min(0).max(10).default(3),
      },
    },
    async ({ limit, include_content, related_limit }) => mcpJson(await triageInbox(env.DB, limit, include_content, related_limit)),
  );

  server.registerTool(
    "suggest_related_items",
    {
      description: "Suggest existing items that may relate to one item, ranked by shared tags, space, type, and title/content terms. This tool is read-only and does not change related IDs.",
      inputSchema: {
        id: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
      },
    },
    async ({ id, limit }) => mcpJson(await suggestRelatedItems(env.DB, id, limit)),
  );

  server.registerTool(
    "get_children",
    {
      description: "List items that are direct children of a given parent item (by parent_id). Useful for getting tasks under a page, or notes under a goal. Returns all children unless you pass filters.",
      inputSchema: {
        parent_id: z.string().min(1),
        type: z.enum(TYPE_KEYS).optional(),
        status: z.enum(STATUS_KEYS).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ parent_id, ...filters }) =>
      mcpJson({ items: await getChildren(env.DB, parent_id, normalizeListOptions(filters)) }),
  );

  server.registerTool(
    "get_backlinks",
    {
      description: "Find all items that reference a given item ID in their related array. Returns bidirectional backlinks.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => mcpJson({ items: await getBacklinks(env.DB, id) }),
  );

  server.registerTool(
    "summarize_space",
    {
      description: "Summarize one space with status/type counts, frequent tags, and recently updated highlights. This is a deterministic, read-only summary rather than an AI-generated narrative.",
      inputSchema: {
        space: z.enum(SPACE_FILTER_KEYS),
        recent_limit: z.number().int().min(1).max(20).default(5),
      },
    },
    async ({ space, recent_limit }) => mcpJson(await summarizeSpace(env.DB, space, recent_limit)),
  );

  return server;
}

function readListOptions(url: URL): ListOptions {
  return {
    type: url.searchParams.get("type"),
    space: url.searchParams.get("space"),
    status: url.searchParams.get("status"),
    parent_id: url.searchParams.get("parent_id"),
    limit: clampNumber(url.searchParams.get("limit"), 1, 100, 30),
    offset: clampNumber(url.searchParams.get("offset"), 0, 10000, 0),
  };
}

function normalizeListOptions(input: {
  type?: string;
  space?: string;
  status?: string;
  parent_id?: string;
  limit?: number;
  offset?: number;
}): ListOptions {
  return {
    type: input.type ?? null,
    space: input.space ?? null,
    status: input.status ?? null,
    parent_id: input.parent_id ?? null,
    limit: clampNumber(input.limit, 1, 100, 30),
    offset: clampNumber(input.offset, 0, 10000, 0),
  };
}

async function listItems(db: D1Database, options: ListOptions): Promise<ItemResponse[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.type) {
    if (!TYPES.has(options.type as ItemType)) throw new Error("Invalid type");
    clauses.push("type = ?");
    values.push(options.type);
  }

  if (options.space) {
    if (options.space === UNSORTED) {
      clauses.push("space IS NULL");
    } else {
      if (!SPACES.has(options.space as ItemSpace)) throw new Error(`Invalid space: ${options.space}`);
      clauses.push("space = ?");
      values.push(options.space);
    }
  }

  if (options.status) {
    if (!STATUSES.has(options.status as ItemStatus)) throw new Error("Invalid status");
    clauses.push("status = ?");
    values.push(options.status);
  }

  if (options.parent_id) {
    clauses.push("parent_id = ?");
    values.push(options.parent_id);
  }

  values.push(options.limit, options.offset);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db
    .prepare(`SELECT * FROM items ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...values)
    .all<Item>();

  return (result.results ?? []).map(serializeItem);
}

async function searchItems(db: D1Database, query: string, options: ListOptions): Promise<ItemResponse[]> {
  if (!query) return listItems(db, options);

  const clauses: string[] = ["items_fts MATCH ?"];
  const values: unknown[] = [query];

  if (options.type) {
    if (!TYPES.has(options.type as ItemType)) throw new Error("Invalid type");
    clauses.push("items.type = ?");
    values.push(options.type);
  }

  if (options.space) {
    if (options.space === UNSORTED) {
      clauses.push("items.space IS NULL");
    } else {
      if (!SPACES.has(options.space as ItemSpace)) throw new Error(`Invalid space: ${options.space}`);
      clauses.push("items.space = ?");
      values.push(options.space);
    }
  }

  if (options.status) {
    if (!STATUSES.has(options.status as ItemStatus)) throw new Error("Invalid status");
    clauses.push("items.status = ?");
    values.push(options.status);
  }

  values.push(options.limit);

  const result = await db
    .prepare(`
      SELECT items.*
      FROM items_fts
      JOIN items ON items.id = items_fts.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `)
    .bind(...values)
    .all<Item>();

  return (result.results ?? []).map(serializeItem);
}

async function getItem(db: D1Database, id: string): Promise<ItemResponse | null> {
  const row = await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>();
  return row ? serializeItem(row) : null;
}

// A write either applies exactly as requested or errors — never a silent no-op.
// parent_id and related IDs must point at real items.
async function assertLinksExist(
  db: D1Database,
  links: { parent_id?: string | null; related?: string[] },
  selfId?: string,
): Promise<void> {
  const ids = new Set<string>();
  if (links.parent_id) ids.add(links.parent_id);
  for (const relatedId of links.related ?? []) ids.add(relatedId);
  if (selfId && ids.has(selfId)) throw new Error("Invalid link: an item cannot reference itself");
  if (ids.size === 0) return;

  const list = [...ids];
  const placeholders = list.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT id FROM items WHERE id IN (${placeholders})`)
    .bind(...list)
    .all<{ id: string }>();
  const found = new Set((result.results ?? []).map((row) => row.id));
  const missing = list.filter((linkId) => !found.has(linkId));
  if (missing.length) throw new Error(`Invalid link: no item with id ${missing.join(", ")}`);
}

async function createItem(db: D1Database, payload: unknown): Promise<ItemResponse> {
  const input = parseCreatePayload(payload);
  await assertLinksExist(db, input);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await db.prepare(`
    INSERT INTO items (id, type, title, space, status, tags, metadata, content, related, parent_id, due_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.type,
    input.title,
    input.space ?? null,
    input.status,
    JSON.stringify(input.tags),
    JSON.stringify(input.metadata),
    input.content,
    JSON.stringify(input.related),
    input.parent_id ?? null,
    input.due_date ?? null,
    now,
    now,
  ).run();

  const item = await getItem(db, id);
  if (!item) throw new Error("Failed to create item");
  return item;
}

async function updateItem(db: D1Database, id: string, payload: unknown): Promise<ItemResponse | null> {
  const input = parseUpdatePayload(payload);
  await assertLinksExist(db, input, id);
  const entries = Object.entries(input);
  if (entries.length === 0) return getItem(db, id);

  const sets = entries.map(([key]) => `${key} = ?`);
  const values: Array<string | number | null> = entries.map(([, value]) => {
    if (value === undefined) return null;
    if (Array.isArray(value) || isPlainObject(value)) return JSON.stringify(value);
    return value;
  });

  values.push(Math.floor(Date.now() / 1000), id);

  const result = await db
    .prepare(`UPDATE items SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...values)
    .run();

  if (result.meta.changes === 0) return null;
  return getItem(db, id);
}

async function bulkUpdateItems(
  db: D1Database,
  ids: string[],
  updates: Partial<{ status: ItemStatus; space: ItemSpace | null; tags: string[]; related: string[] }>,
) {
  const cleanedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  );

  if (Object.keys(cleanedUpdates).length === 0) {
    return { updated: 0, items: [] };
  }

  const items: ItemResponse[] = [];
  for (const id of ids) {
    const item = await updateItem(db, id, cleanedUpdates);
    if (item) items.push(item);
  }

  return { updated: items.length, items };
}

async function getDailyReview(db: D1Database) {
  const activeGoals = await db.prepare(`
    SELECT * FROM items
    WHERE type = 'goal' AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 5
  `).all<Item>();

  const inbox = await db.prepare(`
    SELECT * FROM items
    WHERE status = 'inbox'
    ORDER BY created_at DESC
    LIMIT 5
  `).all<Item>();

  const recentIdeas = await db.prepare(`
    SELECT * FROM items
    WHERE type = 'idea' AND status != 'archived'
    ORDER BY created_at DESC
    LIMIT 3
  `).all<Item>();

  const unprocessedLinks = await db.prepare(`
    SELECT COUNT(*) AS count FROM items
    WHERE type = 'link'
      AND status != 'archived'
      AND json_extract(metadata, '$.processed') IS NOT 1
  `).first<{ count: number }>();

  const upcomingTasks = await db.prepare(`
    SELECT * FROM items
    WHERE type = 'task' AND status NOT IN ('done', 'archived')
      AND due_date IS NOT NULL AND due_date <= ?
    ORDER BY due_date ASC
    LIMIT 5
  `).bind(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60).all<Item>();

  return {
    activeGoals: (activeGoals.results ?? []).map(serializeItem),
    inbox: (inbox.results ?? []).map(serializeItem),
    recentIdeas: (recentIdeas.results ?? []).map(serializeItem),
    unprocessedLinks: unprocessedLinks?.count ?? 0,
    upcomingTasks: (upcomingTasks.results ?? []).map(serializeItem),
  };
}

// One round trip for the whole Identity home screen. Every lens (Cascade,
// Constellation, nav) derives from this payload, so the views cannot disagree.
// An item is "traced to identity" via EITHER mechanism:
//   parent_id → identity item ("traces to", the primary hierarchy)
//   related[] contains identity id (lateral association)
async function getIdentityGraph(db: D1Database) {
  const identity = await db.prepare(`
    SELECT * FROM items
    WHERE space = 'identity' AND status != 'archived'
    ORDER BY type = 'goal' DESC, updated_at DESC
  `).all<Item>();

  const inbound = await db.prepare(`
    SELECT items.*, items.parent_id AS identity_id, 'parent' AS via
    FROM items
    WHERE (items.space IS NULL OR items.space != 'identity')
      AND items.status != 'archived'
      AND items.parent_id IN (SELECT id FROM items WHERE space = 'identity')
    UNION
    SELECT items.*, je.value AS identity_id, 'related' AS via
    FROM items, json_each(items.related) je
    WHERE (items.space IS NULL OR items.space != 'identity')
      AND items.status != 'archived'
      AND je.value IN (SELECT id FROM items WHERE space = 'identity')
    ORDER BY updated_at DESC
  `).all<Item & { identity_id: string; via: "parent" | "related" }>();

  // Goals outside the identity layer with no trace to it via either mechanism.
  const orphanGoals = await db.prepare(`
    SELECT * FROM items
    WHERE type = 'goal'
      AND (space IS NULL OR space != 'identity')
      AND status NOT IN ('done', 'archived')
      AND json_extract(metadata, '$.untethered') IS NOT 1
      AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM items WHERE space = 'identity'))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(items.related) je
        WHERE je.value IN (SELECT id FROM items WHERE space = 'identity')
      )
    ORDER BY updated_at DESC
  `).all<Item>();

  // Dedupe: an item traced via both mechanisms keeps 'parent' (the stronger claim).
  const links: Record<string, Array<ItemResponse & { via: "parent" | "related" }>> = {};
  const seen = new Map<string, ItemResponse & { via: "parent" | "related" }>();
  for (const row of inbound.results ?? []) {
    const key = `${row.identity_id}:${row.id}`;
    const existing = seen.get(key);
    if (existing) {
      if (existing.via === "related" && row.via === "parent") existing.via = "parent";
      continue;
    }
    const entry = { ...serializeItem(row), via: row.via };
    delete (entry as Record<string, unknown>).identity_id;
    seen.set(key, entry);
    (links[row.identity_id] ??= []).push(entry);
  }

  return {
    schema_version: SCHEMA_VERSION,
    identity: (identity.results ?? []).map(serializeItem),
    links,
    orphanGoals: (orphanGoals.results ?? []).map(serializeItem),
  };
}

async function getChildren(db: D1Database, parentId: string, options: ListOptions): Promise<ItemResponse[]> {
  const clauses: string[] = ["parent_id = ?"];
  const values: unknown[] = [parentId];

  if (options.type) {
    if (!TYPES.has(options.type as ItemType)) throw new Error("Invalid type");
    clauses.push("type = ?");
    values.push(options.type);
  }
  if (options.status) {
    if (!STATUSES.has(options.status as ItemStatus)) throw new Error("Invalid status");
    clauses.push("status = ?");
    values.push(options.status);
  }

  values.push(options.limit, options.offset);

  const result = await db
    .prepare(`SELECT * FROM items WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...values)
    .all<Item>();

  return (result.results ?? []).map(serializeItem);
}

async function getBacklinks(db: D1Database, id: string): Promise<ItemResponse[]> {
  // Find items whose related JSON array contains this id
  const result = await db
    .prepare(`
      SELECT DISTINCT items.*
      FROM items, json_each(items.related) je
      WHERE je.value = ? AND items.id != ?
      ORDER BY items.updated_at DESC
    `)
    .bind(id, id)
    .all<Item>();

  return (result.results ?? []).map(serializeItem);
}

async function triageInbox(db: D1Database, limit: number, includeContent: boolean, relatedLimit: number) {
  const allItems = await listItems(db, {
    type: null,
    space: null,
    status: null,
    parent_id: null,
    limit: 100,
    offset: 0,
  });
  const items = allItems
    .filter((item) => item.status === "inbox")
    .slice(0, limit);

  return {
    readOnly: true,
    heuristicVersion: 1,
    count: items.length,
    items: items.map((item) => {
      const suggestedType = item.type === "idea" ? inferItemType(item) : item.type;
      const suggestedSpace = inferItemSpace(item, suggestedType);
      const suggestedTags = inferItemTags(item, suggestedType, suggestedSpace);
      const suggestions: { type: ItemType; space: ItemSpace | null; status: ItemStatus; tags: string[] } = {
        type: suggestedType,
        space: suggestedSpace,
        status: "active",
        tags: suggestedTags,
      };
      const relatedCandidates = rankRelatedCandidates(item, allItems, relatedLimit);

      return {
        id: item.id,
        title: item.title,
        current: { type: item.type, space: item.space, status: item.status, tags: item.tags },
        suggestions,
        reasons: explainTriageSuggestions(item, suggestions),
        relatedCandidates,
        nextAction: inferNextAction(item, suggestedType),
        ...(includeContent ? { content: item.content } : {}),
      };
    }),
    nextStep: "Review each suggestion, then apply accepted changes with update_item or bulk_update.",
  };
}

async function suggestRelatedItems(db: D1Database, id: string, limit: number) {
  const source = await getItem(db, id);
  if (!source) return { error: "Item not found", code: 404 };

  const candidates = await listItems(db, {
    type: null,
    space: null,
    status: null,
    parent_id: null,
    limit: 100,
    offset: 0,
  });
  const sourceTerms = meaningfulTerms(`${source.title} ${source.content}`);

  const suggestions = candidates
    .filter((candidate) => candidate.id !== source.id && candidate.status !== "archived" && !source.related.includes(candidate.id))
    .map((candidate) => {
      const sharedTags = source.tags.filter((tag) => candidate.tags.includes(tag));
      const sharedTerms = [...sourceTerms].filter((term) => meaningfulTerms(`${candidate.title} ${candidate.content}`).has(term));
      const reasons = [
        ...(sharedTags.length ? [`shared tags: ${sharedTags.join(", ")}`] : []),
        ...(source.space === candidate.space ? [`same space: ${source.space}`] : []),
        ...(source.type === candidate.type ? [`same type: ${source.type}`] : []),
        ...(sharedTerms.length ? [`shared terms: ${sharedTerms.slice(0, 5).join(", ")}`] : []),
      ];
      const score = sharedTags.length * 4 + sharedTerms.length * 2 + (source.space === candidate.space ? 2 : 0) + (source.type === candidate.type ? 1 : 0);
      return { item: candidate, score, reasons };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.item.updated_at - a.item.updated_at)
    .slice(0, limit)
    .map(({ item, score, reasons }) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      space: item.space,
      tags: item.tags,
      score,
      reasons,
    }));

  return {
    readOnly: true,
    source: { id: source.id, title: source.title },
    suggestions,
    nextStep: "Use update_item to add accepted IDs to the source item's related array.",
  };
}

async function summarizeSpace(db: D1Database, space: ItemSpace | typeof UNSORTED, recentLimit: number) {
  // "unsorted" is the virtual bucket for items with no space yet.
  const result = space === UNSORTED
    ? await db.prepare("SELECT * FROM items WHERE space IS NULL ORDER BY updated_at DESC").all<Item>()
    : await db.prepare("SELECT * FROM items WHERE space = ? ORDER BY updated_at DESC").bind(space).all<Item>();
  const items = (result.results ?? []).map(serializeItem);
  const byStatus = countBy(items, (item) => item.status);
  const byType = countBy(items, (item) => item.type);
  const tagCounts = countBy(items.flatMap((item) => item.tags), (tag) => tag);
  const topTags = Object.entries(tagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  return {
    readOnly: true,
    space,
    total: items.length,
    byStatus,
    byType,
    topTags,
    recentlyUpdated: items.slice(0, recentLimit).map(({ id, title, type, status, tags, updated_at }) => ({
      id,
      title,
      type,
      status,
      tags,
      updated_at,
    })),
  };
}

function inferItemType(item: ItemResponse): ItemType {
  const text = `${item.title} ${item.content}`.toLowerCase();
  if (/https?:\/\//.test(text)) return "link";
  if (/\b(goal|milestone|objective|finish|achieve|complete)\b/.test(text)) return "goal";
  if (/\b(task|todo|do|finish|submit|send|schedule|buy)\b/.test(text)) return "task";
  if (/\b(idea|maybe|could|what if|concept|thinking)\b/.test(text)) return "idea";
  return "page";
}

function inferItemSpace(item: ItemResponse, type: ItemType): ItemSpace | null {
  const text = `${item.title} ${item.content} ${item.tags.join(" ")}`.toLowerCase();
  if (type === "goal" && /\b(identity|purpose|vision|brand|become)\b/.test(text)) return "identity";
  if (type === "link") return "saved";
  if (/\b(internship|job|resume|career|interview|application)\b/.test(text)) return "career";
  if (/\b(class|course|school|homework|assignment|lecture|professor)\b/.test(text)) return "school";
  if (/\b(project|build|ship|launch|startup|app)\b/.test(text)) return "projects";
  if (/\b(home|health|family|personal|life|watch|movie|show)\b/.test(text)) return "life";
  if (/\b(learn|tutorial|book|study|research|experiment)\b/.test(text)) return "learning";
  return "projects";
}

function explainTriageSuggestions(
  item: ItemResponse,
  suggestions: { type: ItemType; space: ItemSpace | null; status: ItemStatus; tags: string[] },
): string[] {
  const reasons: string[] = [];
  if (item.type !== suggestions.type) reasons.push(`content cues suggest type '${suggestions.type}'`);
  if (item.space !== suggestions.space) reasons.push(`type and content cues suggest space '${suggestions.space}'`);
  const addedTags = suggestions.tags.filter((tag) => !item.tags.includes(tag));
  if (addedTags.length) reasons.push(`content cues suggest tags: ${addedTags.join(", ")}`);
  reasons.push("moving out of inbox marks the capture as reviewed");
  return reasons;
}

function inferItemTags(item: ItemResponse, type: ItemType, space: ItemSpace | null): string[] {
  const text = `${item.title} ${item.content}`.toLowerCase();
  const rules: Array<[string, RegExp]> = [
    ["reading", /\b(book|read|reading|article|paper)\b/],
    ["research", /\b(research|study|investigate|explore)\b/],
    ["meeting", /\b(meeting|agenda|sync|one-on-one|1:1)\b/],
    ["project", /\b(project|build|ship|launch)\b/],
    ["health", /\b(health|doctor|exercise|workout|sleep)\b/],
    ["people", /\b(person|people|friend|family|colleague)\b/],
  ];
  const inferred = rules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
  if (type === "link" && !inferred.includes("reference")) inferred.push("reference");
  if (space === "career" && !inferred.includes("career")) inferred.push("career");
  return [...new Set([...item.tags.map((tag) => tag.toLowerCase()), ...inferred])].slice(0, 8);
}

function inferNextAction(item: ItemResponse, type: ItemType): string {
  const text = `${item.title} ${item.content}`.toLowerCase();
  if (type === "link") return "Open the link, annotate what's useful, tag it, and connect it to related items.";
  if (type === "goal") return "Define the smallest concrete step and record it in this item's content.";
  if (/\b(call|email|message|ask|send|schedule)\b/.test(text)) return "Turn the named action into a concrete next step, then move this item out of the inbox.";
  if (type === "idea") return "Add one sentence explaining why the idea matters or what it could connect to.";
  return "Clarify the capture in one sentence, accept useful tags and connections, then move it out of the inbox.";
}

function rankRelatedCandidates(source: ItemResponse, candidates: ItemResponse[], limit: number) {
  if (limit === 0) return [];
  const sourceTerms = meaningfulTerms(`${source.title} ${source.content}`);
  return candidates
    .filter((candidate) => candidate.id !== source.id && candidate.status !== "archived" && !source.related.includes(candidate.id))
    .map((candidate) => {
      const sharedTags = source.tags.filter((tag) => candidate.tags.includes(tag));
      const sharedTerms = [...sourceTerms].filter((term) => meaningfulTerms(`${candidate.title} ${candidate.content}`).has(term));
      const score = sharedTags.length * 4 + sharedTerms.length * 2 + (source.space === candidate.space ? 2 : 0) + (source.type === candidate.type ? 1 : 0);
      const reasons = [
        ...(sharedTags.length ? [`shared tags: ${sharedTags.join(", ")}`] : []),
        ...(source.space === candidate.space ? [`same space: ${source.space}`] : []),
        ...(source.type === candidate.type ? [`same type: ${source.type}`] : []),
        ...(sharedTerms.length ? [`shared terms: ${sharedTerms.slice(0, 5).join(", ")}`] : []),
      ];
      return { candidate, score, reasons };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.candidate.updated_at - a.candidate.updated_at)
    .slice(0, limit)
    .map(({ candidate, score, reasons }) => ({
      id: candidate.id,
      title: candidate.title,
      type: candidate.type,
      space: candidate.space,
      tags: candidate.tags,
      score,
      reasons,
    }));
}

function meaningfulTerms(value: string): Set<string> {
  const stopWords = new Set(["about", "after", "again", "also", "and", "are", "but", "for", "from", "have", "into", "not", "that", "the", "this", "with", "you", "your"]);
  return new Set((value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((term) => !stopWords.has(term)));
}

function countBy<T>(values: T[], keyFor: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = keyFor(value);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function parseCreatePayload(payload: unknown) {
  if (!isPlainObject(payload)) throw new Error("Invalid JSON body");

  const title = readString(payload.title, "Untitled capture").trim();
  const type = payload.type === undefined ? "idea" : requireEnum(payload.type, TYPES, "type");
  // Omitted/null space = unsorted. Anything else must be a real space — an
  // unknown space is an error, never a silent null.
  const space = readSpaceStrict(payload.space);
  const status = payload.status === undefined
    ? (type === "goal" ? "active" : "inbox")
    : requireEnum(payload.status, STATUSES, "status");

  return {
    type,
    title: title || "Untitled capture",
    space,
    status,
    tags: payload.tags === undefined ? [] : requireStringArray(payload.tags, "tags"),
    metadata: readObject(payload.metadata),
    content: readString(payload.content, ""),
    related: payload.related === undefined ? [] : requireStringArray(payload.related, "related"),
    parent_id: readParentId(payload.parent_id),
    due_date: readDueDate(payload.due_date),
  };
}

function parseUpdatePayload(payload: unknown): Partial<{
  type: ItemType;
  title: string;
  space: ItemSpace | null;
  status: ItemStatus;
  tags: string[];
  metadata: Record<string, unknown>;
  content: string;
  related: string[];
  parent_id: string | null;
  due_date: number | null;
}> {
  if (!isPlainObject(payload)) throw new Error("Invalid JSON body");

  const out: ReturnType<typeof parseUpdatePayload> = {};
  if ("type" in payload) out.type = requireEnum(payload.type, TYPES, "type");
  if ("title" in payload) out.title = readString(payload.title, "").trim() || "Untitled capture";
  if ("space" in payload) out.space = readSpaceStrict(payload.space); // null = unsorted; junk errors
  if ("status" in payload) out.status = requireEnum(payload.status, STATUSES, "status");
  if ("tags" in payload) out.tags = requireStringArray(payload.tags, "tags");
  if ("metadata" in payload) out.metadata = readObject(payload.metadata);
  if ("content" in payload) out.content = readString(payload.content, "");
  if ("related" in payload) out.related = requireStringArray(payload.related, "related");
  if ("parent_id" in payload) out.parent_id = readParentId(payload.parent_id);
  if ("due_date" in payload) out.due_date = readDueDate(payload.due_date);
  return out;
}

function requireEnum<T extends string>(value: unknown, allowed: Set<T>, field: string): T {
  if (typeof value === "string" && allowed.has(value as T)) return value as T;
  throw new Error(`Invalid ${field}: ${JSON.stringify(value)} (allowed: ${[...allowed].join(", ")})`);
}

function readSpaceStrict(value: unknown): ItemSpace | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && SPACES.has(value as ItemSpace)) return value as ItemSpace;
  throw new Error(`Invalid space: ${JSON.stringify(value)} (allowed: ${SPACE_KEYS.join(", ")}, or null for unsorted)`);
}

function readParentId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value;
  throw new Error(`Invalid parent_id: ${JSON.stringify(value)}`);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid ${field}: expected an array of strings`);
  }
  return (value as string[]).map((entry) => entry.trim()).filter(Boolean);
}

function readDueDate(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value) {
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) return Math.floor(ts / 1000);
  }
  throw new Error(`Invalid due_date: ${JSON.stringify(value)} (unix seconds or a parseable date string)`);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function apiKeyOf(env: Env): string {
  return env.ET_AL_API_KEY || env.SECOND_BRAIN_API_KEY || "dev-key";
}

/**
 * Browser sessions never carry the raw key: they send an opaque, key-derived
 * token in an HttpOnly cookie set once by POST /api/session. Agents and scripts
 * keep using the x-api-key header.
 */
async function sessionToken(env: Env): Promise<string> {
  const bytes = new TextEncoder().encode("et-al-session-v1:" + apiKeyOf(env));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string {
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

async function assertAuthorized(request: Request, env: Env) {
  if (request.headers.get("x-api-key") === apiKeyOf(env)) return;
  // SameSite=Lax keeps cross-site writes from riding along on this cookie.
  if (readCookie(request, "et_al_session") === (await sessionToken(env))) return;
  throw new Error("Unauthorized");
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  try {
    await assertAuthorized(request, env);
    return true;
  } catch {
    return false;
  }
}

function assertMcpAuthorized(request: Request, env: Env) {
  const expected = env.ET_AL_API_KEY || env.SECOND_BRAIN_API_KEY || "dev-key";
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const apiKey = request.headers.get("x-api-key") || "";
  if (bearer !== expected && apiKey !== expected) throw new Error("Unauthorized");
}

function mcpJson(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function serializeItem(item: Item): ItemResponse {
  return {
    ...item,
    tags: safeJson<string[]>(item.tags, []),
    metadata: safeJson<Record<string, unknown>>(item.metadata, {}),
    related: safeJson<string[]>(item.related, []),
  };
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: string | number | null | undefined, min: number, max: number, fallback: number): number {
  // "" and null must fall through to the fallback: Number("") is 0, and 0
  // clamped by min:1 silently became limit=1 — the get_children truncation bug.
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function renderApp(appName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(appName)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box}
    body{margin:0;height:100vh;overflow:hidden;background:#fbfcfd;color:#1e2530;font-family:'Hanken Grotesk',system-ui,sans-serif}
    ::-webkit-scrollbar{width:10px;height:10px}
    ::-webkit-scrollbar-thumb{background:rgba(30,41,59,.14);border-radius:6px;border:3px solid #fbfcfd}
    @keyframes etfade{from{opacity:0}to{opacity:1}}
    @keyframes etpop{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:none}}
    a{color:#7c93ab}a:hover{color:#5e7994}
    button,input{font:inherit}
    .mono{font-family:'IBM Plex Mono',monospace}
    .shell{height:100vh;display:flex;flex-direction:column}
    .topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid rgba(30,41,59,.08);background:#fff;flex:none}
    .brand{display:flex;align-items:baseline;gap:13px;cursor:pointer;border:0;background:none;padding:0}
    .wordmark{font-size:16px;font-weight:600;letter-spacing:.28em;text-transform:uppercase}
    .stamp{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#93a0ae}
    .search{display:flex;align-items:center;gap:8px;width:260px;padding:7px 12px;background:#f2f5f8;border:1px solid rgba(30,41,59,.07);border-radius:9px}
    .search span{width:11px;height:11px;border:1.5px solid #b3bdc8;border-radius:50%;flex:none}
    .search input{border:none;background:transparent;outline:none;width:100%;color:#1e2530;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
    .capture-btn{display:flex;align-items:center;gap:7px;padding:8px 15px;background:#1e2530;color:#fff;border:0;border-radius:9px;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer}
    .capture-btn:hover{background:#31404f}
    .body{flex:1;display:flex;min-height:0}
    aside.nav{width:236px;flex:none;padding:24px 18px;border-right:1px solid rgba(30,41,59,.08);background:#f7f9fb;display:flex;flex-direction:column;gap:26px;overflow:auto}
    .nav-head{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#9aa6b3;padding:0 8px 12px}
    .nav-list{display:flex;flex-direction:column;gap:1px}
    .nav-row{display:flex;align-items:center;justify-content:space-between;gap:9px;padding:8px 10px;border:0;background:none;border-radius:8px;cursor:pointer;font-size:13px;color:#4a5563;text-align:left;width:100%}
    .nav-row:hover{background:rgba(30,41,59,.045)}
    .nav-row.active{background:#e9eef4;font-weight:600;color:#1e2530}
    .nav-row .label{display:flex;gap:9px;align-items:center}
    .dot{width:7px;height:7px;border-radius:2px;flex:none}
    .nav-count{font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:#aeb8c3;letter-spacing:.08em}
    .nav-foot{margin-top:auto;padding:14px 10px 0;border-top:1px solid rgba(30,41,59,.08);font-family:'IBM Plex Mono',monospace;font-size:8.5px;letter-spacing:.12em;text-transform:uppercase;color:#9aa6b3;line-height:1.9}
    main{flex:1;overflow:auto;min-width:0}
    .home{max-width:900px;padding:30px 40px;display:flex;flex-direction:column;gap:34px;animation:etfade .2s ease}
    .sec-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px}
    h2.sec{margin:0;font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;letter-spacing:.22em;text-transform:uppercase}
    .sec-meta{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#93a0ae}
    .card{background:#fff;border:1px solid rgba(30,41,59,.09);border-radius:12px;overflow:hidden}
    .goal-row{display:flex;align-items:center;gap:14px;padding:14px 18px;cursor:pointer;border:0;border-bottom:1px solid rgba(30,41,59,.06);background:#fff;width:100%;text-align:left}
    .goal-row:last-child{border-bottom:none}
    .goal-row:hover{background:#fafbfc}
    .num{font-family:'IBM Plex Mono',monospace;font-size:9px;color:#c2ccd6;letter-spacing:.1em}
    .box{width:17px;height:17px;border-radius:5px;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;line-height:0;border:1.6px solid #c2ccd6}
    .box.done{border-color:#1e2530;background:#1e2530;color:#fff}
    .box.green.done{border-color:#7ca88f;background:#7ca88f}
    .row-title{flex:1;font-size:13.5px}
    .row-title.done{color:#9aa6b3;text-decoration:line-through}
    .chips{display:flex;align-items:center;gap:4px}
    .chip{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#93a0ae;padding:5px 8px;border:0;background:none;cursor:pointer;border-radius:20px}
    .chip:hover{color:#4a5563}
    .chip.active{font-weight:600;color:#4a5563;background:#eef2f6;padding:5px 11px}
    .feed{display:flex;flex-direction:column;gap:10px}
    .feed-card{background:#fff;border:1px solid rgba(30,41,59,.09);border-radius:12px;padding:16px 18px;display:flex;gap:16px;cursor:pointer;text-align:left;width:100%}
    .feed-card:hover{border-color:rgba(30,41,59,.2);box-shadow:0 4px 16px rgba(30,41,59,.07)}
    .feed-meta{display:flex;align-items:center;gap:9px;margin-bottom:7px}
    .tag{font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;padding:2px 7px;border-radius:5px;border:1px solid}
    .feed-title{font-size:14.5px;font-weight:600;margin-bottom:3px}
    .feed-snippet{font-size:13px;color:#7a8794;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .placeholder{padding:40px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#aeb8c3}
    .detail{display:flex;animation:etfade .2s ease}
    .detail-main{flex:1;padding:30px 36px;min-width:0;max-width:760px}
    .crumb{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#93a0ae;cursor:pointer;border:0;background:none;padding:0}
    .crumb:hover{color:#1e2530}
    .detail-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:26px}
    .actions{display:flex;gap:16px;font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#7a8794}
    .actions button{border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:0}
    .actions button:hover{color:#1e2530}
    h1.detail-title{margin:0 0 12px;font-size:27px;font-weight:700;letter-spacing:-.015em;line-height:1.2}
    .meta-line{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#93a0ae;padding-bottom:20px;border-bottom:1px solid rgba(30,41,59,.09);margin-bottom:24px}
    .prose p{margin:0 0 16px;font-size:14.5px;line-height:1.7;color:#3a4553;white-space:pre-wrap}
    .prose h3{margin:22px 0 10px;font-size:15px;font-weight:700;letter-spacing:.01em}
    .prose .bullet{display:flex;gap:11px;font-size:14px;line-height:1.6;color:#3a4553;margin-bottom:9px}
    .prose .bullet span.dash{color:#b3bdc8;flex:none}
    .editor{width:100%;min-height:320px;border:1px solid rgba(30,41,59,.12);border-radius:11px;padding:14px 16px;font-size:14.5px;line-height:1.7;color:#3a4553;background:#fff;outline:none;resize:vertical}
    aside.meta{width:230px;flex:none;padding:30px 22px;border-left:1px solid rgba(30,41,59,.08);background:#f7f9fb;display:flex;flex-direction:column;gap:22px}
    .meta-label{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9aa6b3;margin-bottom:6px}
    .meta-value{display:flex;align-items:center;gap:8px;font-size:13px}
    .meta-edit{width:100%;font-family:inherit;font-size:13px;color:#1e2530;background:#fff;border:1px solid rgba(30,41,59,.12);border-radius:7px;padding:6px 8px;outline:none;cursor:pointer}
    .meta-edit:hover{border-color:rgba(30,41,59,.28)}
    .meta-edit:focus{border-color:#7c93ab;box-shadow:0 0 0 3px rgba(124,147,171,.14)}
    .title-edit{width:100%;margin:0 0 12px;font-size:27px;font-weight:700;letter-spacing:-.015em;line-height:1.2;font-family:inherit;color:#1e2530;background:transparent;border:1px solid transparent;border-radius:8px;padding:2px 6px;margin-left:-7px;outline:none}
    .title-edit:hover{border-color:rgba(30,41,59,.14)}
    .title-edit:focus{background:#fff;border-color:#7c93ab;box-shadow:0 0 0 3px rgba(124,147,171,.14)}
    .tag-pill{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:#4a5563;background:#e9eef4;padding:4px 9px;border-radius:20px}
    .linked-row{display:flex;gap:8px;align-items:center;font-size:12.5px;color:#4a5563;background:none;border:0;padding:0;cursor:pointer;text-align:left}
    .linked-row:hover{color:#1e2530}
    .dump-input{display:flex;align-items:center;gap:12px;padding:14px 16px;background:#fff;border:1px solid rgba(30,41,59,.12);border-radius:11px;margin-bottom:28px}
    .dump-input input{flex:1;border:none;outline:none;background:transparent;font-size:14px;color:#1e2530}
    .kbd{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#aeb8c3;border:1px solid rgba(30,41,59,.12);border-radius:5px;padding:3px 7px}
    .group-name{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#aeb8c3;margin-bottom:14px}
    .thought{display:flex;gap:16px;margin-bottom:16px}
    .thought .time{font-family:'IBM Plex Mono',monospace;font-size:9px;color:#c2ccd6;letter-spacing:.08em;width:42px;flex:none;padding-top:3px}
    .thought p{margin:0;font-size:14.5px;line-height:1.6;color:#2f3a47}
    .check-row{display:flex;align-items:center;gap:13px;padding:11px 2px;border-bottom:1px solid rgba(30,41,59,.06);cursor:pointer;background:none;border-left:0;border-right:0;border-top:0;width:100%;text-align:left}
    .check-row:hover{background:#fafbfc}
    .check-row .text{flex:1;font-size:14px}
    .check-row .text.done{color:#9aa6b3;text-decoration:line-through}
    .add-row{display:flex;align-items:center;gap:13px;padding:11px 2px;color:#93a0ae}
    .add-row .plus{width:17px;height:17px;border:1.5px dashed #c2ccd6;border-radius:5px;flex:none;display:flex;align-items:center;justify-content:center;font-size:12px;line-height:0}
    .add-row input{flex:1;border:none;outline:none;background:transparent;font-size:14px;color:#1e2530}
    .progress{display:flex;align-items:center;gap:14px;margin-bottom:28px}
    .progress .label{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#7ca88f}
    .progress .track{flex:1;height:3px;background:#e9eef4;border-radius:3px;overflow:hidden}
    .progress .bar{height:100%;background:#7ca88f}
    .overlay{position:fixed;inset:0;background:rgba(20,26,34,.28);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;z-index:50;animation:etfade .15s ease}
    .modal{width:520px;background:#fbfcfd;border:1px solid rgba(30,41,59,.12);border-radius:16px;box-shadow:0 24px 60px rgba(20,26,34,.24);overflow:hidden;animation:etpop .18s ease}
    .modal-head{padding:16px 22px;border-bottom:1px solid rgba(30,41,59,.08);display:flex;align-items:center;gap:12px}
    .modal-head .t{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#93a0ae;flex:1}
    .modal-body{padding:22px}
    .modal-body input.title{width:100%;border:none;outline:none;background:transparent;font-size:20px;font-weight:600;color:#1e2530;margin-bottom:22px}
    .field-label{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9aa6b3;margin-bottom:9px}
    .pick{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
    .pick button{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;padding:8px 13px;border:0;border-radius:8px;cursor:pointer;background:#eef2f6;color:#4a5563}
    .pick button.active{background:#1e2530;color:#fff}
    .pick.spaces button{font-family:'Hanken Grotesk',sans-serif;font-size:12.5px;letter-spacing:normal;text-transform:none;background:transparent;color:#7a8794;border:1px solid rgba(30,41,59,.1)}
    .pick.spaces button.active{background:#e9eef4;color:#1e2530;font-weight:600;border-color:rgba(30,41,59,.14)}
    .modal-foot{display:flex;justify-content:flex-end;gap:10px;align-items:center}
    .btn-ghost{padding:9px 16px;font-size:12.5px;font-weight:600;color:#7a8794;background:none;border:0;cursor:pointer;border-radius:9px}
    .btn-ghost:hover{background:#eef2f6}
    .btn-primary{padding:9px 18px;font-size:12.5px;font-weight:600;color:#fff;background:#1e2530;border:0;border-radius:9px;cursor:pointer}
    .btn-primary:disabled{background:#aab6c4;cursor:not-allowed}
    .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1e2530;color:#fff;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:10px 18px;border-radius:9px;z-index:80;animation:etpop .18s ease}
    .key-field{display:flex;align-items:center;gap:8px;margin-right:auto}
    .key-field input{width:130px;padding:7px 10px;border:1px solid rgba(30,41,59,.12);border-radius:8px;background:#fff;font-family:'IBM Plex Mono',monospace;font-size:10px;outline:none}
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <button class="brand" id="brand">
        <span class="wordmark">ET&nbsp;AL</span>
        <span class="stamp" id="stamp">2ND&nbsp;BRAIN</span>
      </button>
      <div style="display:flex;align-items:center;gap:12px">
        <div class="search"><span></span><input id="search" placeholder="Search / command…" autocomplete="off"></div>
        <button class="capture-btn" id="openCapture">+&nbsp;Capture</button>
      </div>
    </div>
    <div class="body">
      <aside class="nav">
        <div>
          <div class="nav-head" style="color:#c4917c">◈ Identity</div>
          <div class="nav-list" id="identityRow"></div>
        </div>
        <div>
          <div class="nav-head">§ Spaces</div>
          <div class="nav-list" id="spaceList"></div>
        </div>
        <div>
          <div class="nav-head">§ Types</div>
          <div class="nav-list" id="typeList"></div>
        </div>
        <div class="nav-foot" id="navFoot">Everything is an item</div>
      </aside>
      <main id="main"></main>
    </div>
  </div>
  <div id="modalRoot"></div>
  <div id="toastRoot"></div>
  <script>
    window.onerror = function(msg, src, line, col, err) {
      document.getElementById('main').innerHTML =
        '<div class="placeholder" style="color:#b4776f;text-align:left;font-family:monospace;font-size:12px;white-space:pre-wrap">' +
        'JS ERROR: ' + msg + '\\nAt line ' + line + '\\n' + (err && err.stack ? err.stack : '') + '</div>';
    };
    // The one schema. Injected by the worker from the same object that defines
    // the MCP tool enums and the DB CHKs — the UI cannot drift from the model.
    var SCHEMA = ${JSON.stringify(SCHEMA_INFO)};
    var SPACE_META = {
      identity: { label: 'Identity', dot: '#c4917c' },
      school:   { label: 'School',   dot: '#7c93ab' },
      career:   { label: 'Career',   dot: '#b1a07c' },
      learning: { label: 'Learning', dot: '#6f8fa8' },
      projects: { label: 'Projects', dot: '#7ca88f' },
      life:     { label: 'Life',     dot: '#c48b8b' },
      saved:    { label: 'Saved',    dot: '#8a7cab' }
    };
    var TYPE_META = {
      page: { label: 'Page', color: '#7c93ab', border: 'rgba(124,147,171,.35)' },
      goal: { label: 'Goal', color: '#93a3b6', border: 'rgba(147,163,182,.35)' },
      idea: { label: 'Idea', color: '#7ca88f', border: 'rgba(124,168,143,.35)' },
      task: { label: 'Task', color: '#c4917c', border: 'rgba(196,145,124,.35)' },
      link: { label: 'Link', color: '#b1a07c', border: 'rgba(177,160,124,.35)' }
    };
    var SPACES = {};
    SCHEMA.spaces.forEach(function (key) { SPACES[key] = SPACE_META[key] || { label: key, dot: '#9aa6b3' }; });
    var TYPES = {};
    SCHEMA.types.forEach(function (key) { TYPES[key] = TYPE_META[key] || { label: key, color: '#7c93ab', border: 'rgba(124,147,171,.35)' }; });
    var TYPE_KEYS = SCHEMA.types;
    // Identity is rendered as its own layer, not a peer space row.
    var SPACE_KEYS = SCHEMA.spaces.filter(function (key) { return key !== 'identity'; });
    var UNSORTED_INFO = { label: 'Unsorted', dot: '#aeb8c3' };
    var IDENTITY_COLOR = '#c4917c';

    var state = {
      view: 'home', activeId: null, filterSpace: 'all', filterType: null, query: '',
      items: [], review: null, loading: true, error: null, editing: false, capture: null, toast: null,
      authed: false, unlockPrompt: null, backlinks: null, lastSync: null,
      // Cascade is the default lens: identity goals earn their place by what hangs
      // off them, and that chain is what you act on. The last-used lens survives a re-render.
      identity: null, identityTab: 'cascade', collapsed: {}
    };

    // The browser never stores the key: POST /api/session exchanges it once for
    // an HttpOnly cookie, and every later write rides on that cookie.
    async function unlock(key) {
      var response = await fetch('/api/session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: key })
      });
      if (!response.ok) throw new Error('That key was not accepted.');
      state.authed = true;
    }

    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function pad(n) { return String(n).padStart(3, '0'); }
    function num(item) { return pad((parseInt(String(item.id).replace(/\\D/g, '').slice(-3), 10) || 0) % 1000); }
    function typeOf(item) { return TYPES[item.type] ? item.type : 'page'; }
    function spaceOf(item) { return (item.space && SPACES[item.space]) ? item.space : null; }
    function getSpaceInfo(item) {
      var sp = spaceOf(item);
      return sp ? SPACES[sp] : UNSORTED_INFO;
    }
    function isIdentity(item) { return item.space === 'identity'; }
    function isUnsorted(item) { return !item.space; }
    function identityItems() { return (state.identity && state.identity.identity) || state.items.filter(isIdentity); }
    // The lineage chip: the identity item this one traces up to — parent_id
    // (hierarchy) wins, related (lateral) counts too.
    function identityAncestor(item) {
      if (!item || isIdentity(item)) return null;
      var pool = identityItems();
      if (item.parent_id) {
        var parent = pool.find(function (candidate) { return candidate.id === item.parent_id; });
        if (parent) return parent;
      }
      var ids = item.related || [];
      for (var i = 0; i < ids.length; i++) {
        var hit = pool.find(function (candidate) { return candidate.id === ids[i]; });
        if (hit) return hit;
      }
      return null;
    }
    function childrenOf(id) {
      return state.items.filter(function (item) { return item.parent_id === id && item.status !== 'archived'; });
    }
    function stamp(ts) {
      var d = new Date(ts * 1000), now = Date.now() / 1000, diff = now - ts;
      if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + 'm';
      if (diff < 86400) return Math.round(diff / 3600) + 'h';
      return pad2(d.getDate()) + '·' + pad2(d.getMonth() + 1);
    }
    function pad2(n) { return String(n).padStart(2, '0'); }
    function isoDate(ts) { var d = new Date(ts * 1000); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
    function clock(ts) { var d = new Date(ts * 1000); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
    function formatDue(ts) {
      if (!ts) return '';
      var d = new Date(ts * 1000);
      var today = new Date(); today.setHours(0,0,0,0);
      var due = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      var diff = Math.floor((due - today) / 86400000);
      var str = pad2(d.getDate()) + '/' + pad2(d.getMonth()+1) + '/' + String(d.getFullYear()).slice(2);
      if (diff < 0) return str + ' · overdue';
      if (diff === 0) return str + ' · today';
      if (diff === 1) return str + ' · tomorrow';
      return str + ' · ' + diff + 'd';
    }
    function todayLine() {
      var d = new Date();
      var days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
      return days[d.getDay()] + ' ' + pad2(d.getDate()) + '·' + pad2(d.getMonth() + 1) + '·' + String(d.getFullYear()).slice(2);
    }
    function snippetOf(item) {
      var text = (item.content || '').replace(/[#>*\\-]/g, ' ').replace(/\\s+/g, ' ').trim();
      return text ? text.slice(0, 160) : 'No content yet — open to fill it in.';
    }
    // Subtasks are real task items with parent_id = this item — queryable,
    // consistent, no freeform metadata checklists.
    function childTasks(item) {
      return childrenOf(item.id).filter(function (child) { return child.type === 'task'; })
        .sort(function (a, b) { return a.created_at - b.created_at; });
    }
    function toast(message) {
      state.toast = message;
      render();
      clearTimeout(toast.timer);
      toast.timer = setTimeout(function () { state.toast = null; render(); }, 2200);
    }

    // ---------- data ----------
    // quiet = refresh in place (window focus, post-write) without the loading flash.
    async function load(quiet) {
      if (!quiet) { state.loading = true; state.error = null; render(); }
      try {
        var responses = await Promise.all([
          fetch('/api/review'), fetch('/api/items?limit=100'),
          fetch('/api/session', { credentials: 'same-origin' }),
          fetch('/api/identity/graph')
        ]);
        if (!responses[0].ok || !responses[1].ok) throw new Error('The workspace did not respond.');
        var payloads = await Promise.all([
          responses[0].json(), responses[1].json(), responses[2].json(),
          responses[3].ok ? responses[3].json() : Promise.resolve(null)
        ]);
        state.review = payloads[0];
        state.items = payloads[1].items || [];
        state.authed = !!payloads[2].authenticated;
        state.identity = payloads[3];
        state.lastSync = Date.now();
      } catch (error) {
        if (!quiet) state.error = error && error.message ? error.message : 'The workspace could not be loaded.';
      } finally {
        state.loading = false; render();
      }
    }

    // Identity graph is the shared source for Cascade, Constellation, and the
    // nav card — refresh it after any write that could change a link.
    async function refreshIdentity() {
      try {
        var response = await fetch('/api/identity/graph');
        if (response.ok) { state.identity = await response.json(); state.lastSync = Date.now(); }
      } catch (error) {}
    }

    async function write(method, path, payload) {
      var response = await fetch(path, {
        method: method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined
      });
      var data = await response.json().catch(function () { return {}; });
      if (response.status === 401) { state.authed = false; var unlockError = new Error('Unlock this workspace to save changes.'); unlockError.needsUnlock = true; throw unlockError; }
      if (!response.ok) throw new Error(data.error || 'Request failed.');
      return data;
    }

    function mergeItem(item) {
      var index = state.items.findIndex(function (candidate) { return candidate.id === item.id; });
      if (index === -1) state.items.unshift(item); else state.items[index] = item;
      if (state.review) {
        state.review.activeGoals = (state.review.activeGoals || []).map(function (g) { return g.id === item.id ? item : g; });
      }
    }

    async function patchItem(id, updates) {
      try {
        mergeItem(await write('PATCH', '/api/items/' + id, updates));
        render();
        refreshIdentity().then(render);
      } catch (error) { failWrite(error, function () { patchItem(id, updates); }); }
    }

    // Inline fix for an orphan goal: trace it to an identity item via parent_id.
    async function linkToIdentity(id, identityId) {
      try {
        mergeItem(await write('PATCH', '/api/items/' + id, { parent_id: identityId }));
        await refreshIdentity();
        render();
        toast('Traced to identity');
      } catch (error) { failWrite(error, function () { linkToIdentity(id, identityId); }); }
    }

    // Orphan nagging should be closable, not a permanent scold.
    async function untether(id) {
      var orphans = (state.identity && state.identity.orphanGoals) || [];
      var goal = orphans.find(function (o) { return o.id === id; });
      if (!goal) return;
      try {
        var updated = await write('PATCH', '/api/items/' + id, {
          metadata: Object.assign({}, goal.metadata, { untethered: true })
        });
        mergeItem(updated);
        state.identity.orphanGoals = orphans.filter(function (o) { return o.id !== id; });
        render();
        toast('Left untethered');
      } catch (error) { failWrite(error, function () { untether(id); }); }
    }

    // A write that fails only because the session is locked resumes itself once unlocked.
    function failWrite(error, retry) {
      if (error && error.needsUnlock) { state.unlockPrompt = { key: '', error: null, retry: retry }; render(); }
      else toast(error.message);
    }

    // ---------- actions ----------
    function goHome() { state.view = 'home'; state.activeId = null; state.editing = false; render(); }
    function openItem(id) {
      state.view = 'item'; state.activeId = id; state.editing = false; state.backlinks = null;
      render(); window.scrollTo(0, 0);
      fetch('/api/items/' + id + '/backlinks')
        .then(function(r) { return r.json(); })
        .then(function(data) { if (state.activeId === id) { state.backlinks = data.items || []; render(); } })
        .catch(function() {});
    }
    function activeItem() { return state.items.find(function (item) { return item.id === state.activeId; }); }

    function toggleGoal(goal) {
      patchItem(goal.id, { status: goal.status === 'done' ? 'active' : 'done' });
    }

    function toggleTask(task) {
      patchItem(task.id, { status: task.status === 'done' ? 'active' : 'done' });
    }

    async function addSubtask(item, text) {
      var value = text.trim(); if (!value) return;
      try {
        var created = await write('POST', '/api/items', {
          type: 'task', title: value, parent_id: item.id, space: item.space, status: 'active'
        });
        mergeItem(created);
        render();
      } catch (error) { failWrite(error, function () { addSubtask(item, text); }); }
    }

    function filteredItems() {
      var query = state.query.trim().toLowerCase();
      return state.items.filter(function (item) {
        if (state.filterSpace === 'identity' && !isIdentity(item)) return false;
        if (state.filterSpace === 'unsorted' && !isUnsorted(item)) return false;
        if (state.filterSpace !== 'all' && state.filterSpace !== 'identity' && state.filterSpace !== 'unsorted' && spaceOf(item) !== state.filterSpace) return false;
        if (state.filterType && typeOf(item) !== state.filterType) return false;
        if (item.status === 'archived') return false;
        if (query) {
          var hay = (item.title + ' ' + (item.content || '') + ' ' + (item.tags || []).join(' ')).toLowerCase();
          if (hay.indexOf(query) === -1) return false;
        }
        return true;
      });
    }

    // ---------- rendering ----------
    function render() {
      renderNav();
      var main = document.getElementById('main');
      if (state.loading) main.innerHTML = '<div class="placeholder">Loading workspace…</div>';
      else if (state.error) main.innerHTML = '<div class="placeholder">' + esc(state.error) + '</div>';
      else if (state.view === 'item' && activeItem()) main.innerHTML = renderDetail(activeItem());
      else if (state.view === 'identity') main.innerHTML = renderIdentity();
      else main.innerHTML = renderHome();
      document.getElementById('modalRoot').innerHTML =
        state.unlockPrompt ? renderUnlock() : (state.capture ? renderCapture() : '');
      document.getElementById('toastRoot').innerHTML = state.toast ? '<div class="toast">' + esc(state.toast) + '</div>' : '';
      document.getElementById('stamp').innerHTML = '2ND&nbsp;BRAIN&nbsp;·&nbsp;N°' + pad(state.items.length);
      bind();
    }

    function renderNav() {
      var counts = {};
      var identityCount = 0;
      var unsortedCount = 0;
      state.items.forEach(function (item) {
        if (isIdentity(item)) { identityCount++; }
        else if (isUnsorted(item)) { unsortedCount++; }
        else { counts[item.space] = (counts[item.space] || 0) + 1; }
      });

      // Identity is a card, not a nav row — it never shares visual grammar with a space.
      var goalCount = identityItems().filter(function (i) { return i.type === 'goal'; }).length;
      document.getElementById('identityRow').innerHTML =
        '<button class="nav-row' + (state.view === 'identity' ? ' active' : '') + '" id="identityBtn"' +
          ' style="display:block;text-align:left;padding:11px 12px;border:1px solid rgba(196,145,124,.35);border-radius:10px;background:linear-gradient(160deg,rgba(196,145,124,.10),rgba(196,145,124,.02))">' +
          '<span style="display:flex;align-items:center;justify-content:space-between">' +
            '<span class="label"><span class="dot" style="background:' + IDENTITY_COLOR + '"></span><b>Identity</b></span>' +
            '<span class="nav-count">' + identityCount + '</span></span>' +
          '<span style="display:block;font-size:10.5px;color:#9aa6b3;margin-top:3px">' +
            plural(goalCount, 'goal') + ' · ' + plural(Math.max(0, identityCount - goalCount), 'page') + '</span>' +
        '</button>';

      // Spaces — plus the Unsorted bucket: unfiled items are always visible,
      // never nowhere.
      var rows = [{ key: 'all', label: 'All items', dot: '#1e2530', count: state.items.length }].concat(
        SPACE_KEYS.map(function (key) { return { key: key, label: SPACES[key].label, dot: SPACES[key].dot, count: counts[key] || 0 }; }),
        [{ key: 'unsorted', label: UNSORTED_INFO.label, dot: UNSORTED_INFO.dot, count: unsortedCount }]
      );
      document.getElementById('spaceList').innerHTML = rows.map(function (row) {
        var active = state.filterSpace === row.key && state.view === 'home';
        return '<button class="nav-row' + (active ? ' active' : '') + '" data-space="' + row.key + '">' +
          '<span class="label"><span class="dot" style="background:' + row.dot + '"></span>' + esc(row.label) + '</span>' +
          '<span class="nav-count">' + row.count + '</span></button>';
      }).join('');

      document.getElementById('typeList').innerHTML = TYPE_KEYS.map(function (key) {
        var active = state.filterType === key && state.view === 'home';
        return '<button class="nav-row' + (active ? ' active' : '') + '" data-type="' + key + '">' + esc(TYPES[key].label) + 's</button>';
      }).join('');

      var open = state.items.filter(function (item) { return item.status === 'active' || item.status === 'inbox'; }).length;
      var synced = state.lastSync ? 'Synced ' + clock(state.lastSync / 1000) : 'Not synced yet';
      document.getElementById('navFoot').innerHTML =
        'Everything is an item<br>Cap. ' + pad(state.items.length) + ' · Active ' + pad(open) +
        '<br>' + synced + ' · Schema v' + SCHEMA.version;
    }

    // ---------- identity ----------
    function renderIdentity() {
      var tabs = [
        { key: 'cascade', label: 'Cascade' },
        { key: 'constellation', label: 'Constellation' }
      ];
      var body = state.identityTab === 'constellation' ? renderConstellation() : renderCascade();

      return '<div class="home"><section>' +
        '<div class="sec-head" style="align-items:center">' +
          '<div>' +
            '<h2 class="sec" style="color:' + IDENTITY_COLOR + '">◈ Identity</h2>' +
            '<div class="sec-meta" style="text-transform:none;letter-spacing:0;margin-top:4px">' +
              "Who you are, and who you're becoming. Everything below traces here." +
            '</div>' +
          '</div>' +
          '<div class="chips">' + tabs.map(function (tab) {
            return '<button class="chip' + (state.identityTab === tab.key ? ' active' : '') +
              '" data-idtab="' + tab.key + '">' + esc(tab.label) + '</button>';
          }).join('') + '</div>' +
        '</div>' + body +
      '</section></div>';
    }

    function renderConstellation() {
      var W = 860, H = 480, cx = W / 2, cy = H / 2 + 20, R = 190;
      var identityList = identityItems();
      var goals = identityList.filter(function(i) { return i.type === 'goal'; });
      var spaceAngles = {};
      SPACE_KEYS.forEach(function(key, i) {
        spaceAngles[key] = (i / SPACE_KEYS.length) * 2 * Math.PI - Math.PI / 2;
      });

      var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:' + H + 'px" xmlns="http://www.w3.org/2000/svg">';

      // Dashed lines from identity to each space
      SPACE_KEYS.forEach(function(key) {
        var a = spaceAngles[key];
        var nx = cx + R * Math.cos(a), ny = cy + R * Math.sin(a);
        svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + nx + '" y2="' + ny + '" stroke="rgba(30,41,59,.1)" stroke-width="1.5" stroke-dasharray="5,4"/>';
      });

      // Space nodes
      SPACE_KEYS.forEach(function(key) {
        var a = spaceAngles[key];
        var nx = cx + R * Math.cos(a), ny = cy + R * Math.sin(a);
        var info = SPACES[key];
        var count = state.items.filter(function(i) { return i.space === key; }).length;
        svg += '<circle cx="' + nx + '" cy="' + ny + '" r="40" fill="' + info.dot + '" fill-opacity=".1" stroke="' + info.dot + '" stroke-width="1.5" data-space="' + key + '" style="cursor:pointer" class="graph-space"/>';
        svg += '<text x="' + nx + '" y="' + (ny - 5) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="9.5" font-weight="600" fill="#4a5563" letter-spacing=".12em" style="pointer-events:none">' + key.toUpperCase() + '</text>';
        svg += '<text x="' + nx + '" y="' + (ny + 10) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="9" fill="#9aa6b3" style="pointer-events:none">' + count + ' items</text>';
      });

      // Outer ring goal links — same source as Cascade (the identity graph),
      // so the two lenses can never disagree about what is traced.
      var graphLinks = (state.identity && state.identity.links) || {};
      goals.slice(0, 5).forEach(function(goal, gi) {
        var a = (gi / Math.max(goals.length, 1) - 0.5) * 0.8; // small arc near center top
        var gx = cx + 28 * Math.cos(a - Math.PI / 2), gy = cy + 28 * Math.sin(a - Math.PI / 2) - 8;
        (graphLinks[goal.id] || []).forEach(function(rel) {
          if (rel.space && spaceAngles[rel.space] !== undefined) {
            var sa = spaceAngles[rel.space];
            var tx = cx + (R - 45) * Math.cos(sa), ty = cy + (R - 45) * Math.sin(sa);
            svg += '<line x1="' + gx + '" y1="' + gy + '" x2="' + tx + '" y2="' + ty + '" stroke="#c4917c" stroke-width="1" stroke-opacity=".4" stroke-dasharray="3,3"/>';
          }
        });
      });

      // Identity center
      svg += '<circle cx="' + cx + '" cy="' + cy + '" r="58" fill="rgba(196,145,124,.07)" stroke="#c4917c" stroke-width="2"/>';
      svg += '<text x="' + cx + '" y="' + (cy - 14) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10" font-weight="600" fill="#c4917c" letter-spacing=".2em">IDENTITY</text>';
      svg += '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="9" fill="#c4917c">' + identityList.length + ' items</text>';
      svg += '<text x="' + cx + '" y="' + (cy + 20) + '" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="8.5" fill="rgba(196,145,124,.6)">' + goals.length + ' goals</text>';
      svg += '<circle cx="' + cx + '" cy="' + cy + '" r="58" fill="transparent" data-space="identity" style="cursor:pointer" class="graph-space"/>';

      svg += '</svg>';

      if (!identityList.length) {
        return '<div class="placeholder" style="text-transform:none;letter-spacing:0;font-family:Hanken Grotesk,sans-serif;font-size:13.5px">' +
          'Your Identity layer is empty — start with one goal, and the spaces below will have something to point back at.<br>' +
          '<button class="btn-primary" data-capture-identity style="margin-top:16px">Start with one goal</button></div>';
      }
      return '<div class="card" style="overflow:hidden">' + svg + '</div>' +
        '<div class="sec-meta" style="text-transform:none;letter-spacing:0;margin-top:10px">' +
          'Centre = the whole Identity layer. Each spoke is one hop of <code>related</code> out into a space.' +
        '</div>';
    }

    // Cascade — identity goal → related space goal → its child tasks.
    function renderCascade() {
      var links = (state.identity && state.identity.links) || {};
      var orphans = (state.identity && state.identity.orphanGoals) || [];
      var goals = identityItems().filter(function (i) { return i.type === 'goal'; });

      function row(item, bold) {
        var due = item.due_date ? '<span class="sec-meta" style="margin-left:auto">' + esc(formatDue(item.due_date)) + '</span>' : '';
        // ↑ = traces here via parent_id; ↔ = lateral related link.
        var via = item.via ? '<span class="num" title="' + (item.via === 'parent' ? 'traces to (parent)' : 'related (lateral)') + '">' + (item.via === 'parent' ? '↑' : '↔') + '</span>' : '';
        return '<button class="goal-row" data-open="' + esc(item.id) + '" style="width:100%">' +
          '<span class="dot" style="background:' + getSpaceInfo(item).dot + ';flex:none"></span>' + via +
          '<span class="row-title"' + (bold ? ' style="font-weight:600"' : '') + '>' + esc(item.title) + '</span>' +
          '<span class="tag" style="color:' + TYPES[typeOf(item)].color + ';border-color:' + TYPES[typeOf(item)].border + '">' +
            esc(getSpaceInfo(item).label.toLowerCase() + ' · ' + typeOf(item)) + '</span>' + due +
        '</button>';
      }
      function indent(inner) {
        return '<div style="margin-left:20px;border-left:1px solid rgba(30,41,59,.10);padding-left:10px">' + inner + '</div>';
      }

      // Each identity reads as a heading you can collapse — the whole point of the
      // lens is scanning identities, so their branches have to get out of the way.
      var body = goals.length ? goals.map(function (goal) {
        var kids = links[goal.id] || [];
        var open = !state.collapsed[goal.id];
        var head =
          '<div style="display:flex;align-items:center;gap:10px;padding:14px 4px 10px">' +
            '<button data-idfold="' + esc(goal.id) + '" title="' + (open ? 'Collapse' : 'Expand') + '"' +
              ' style="border:0;background:none;cursor:pointer;padding:0;color:#9aa6b3;font-size:11px;' +
              'width:16px;flex:none;transform:rotate(' + (open ? '90' : '0') + 'deg);transition:transform .12s">▶</button>' +
            '<button data-open="' + esc(goal.id) + '" style="border:0;background:none;cursor:pointer;padding:0;' +
              'text-align:left;flex:1;min-width:0">' +
              '<span style="display:block;font-size:19px;font-weight:600;letter-spacing:-.01em;line-height:1.3">' +
                esc(goal.title) + '</span>' +
            '</button>' +
            '<span class="num" style="flex:none">' + plural(kids.length, 'link') + '</span>' +
          '</div>';
        if (!open) return head;
        var branches = kids.map(function (child) {
          var tasks = childrenOf(child.id);
          return row(child) + (tasks.length ? indent(tasks.map(function (t) { return row(t); }).join('')) : '');
        }).join('');
        return head + (branches ? indent(branches) :
          indent('<div class="placeholder" style="padding:10px 0;text-align:left">Nothing in any space points at this yet.</div>'));
      }).join('<div style="height:1px;background:rgba(30,41,59,.07);margin:6px 0"></div>')
        : '<div class="placeholder" style="text-transform:none;letter-spacing:0;font-family:Hanken Grotesk,sans-serif;font-size:13.5px">' +
            'No identity goals yet — nothing to cascade from.<br>' +
            '<button class="btn-primary" data-capture-identity style="margin-top:16px">Start with one goal</button></div>';

      // Fixing an orphan happens inline: pick an identity item from the row,
      // no need to open 17 items one by one. "Leave untethered" is a plain
      // button, and the banner stays informational rather than a scold.
      var identityTargets = identityItems().filter(function (i) { return i.status !== 'archived'; });
      var pickerOptions = '<option value="">link to ↑ …</option>' + identityTargets.map(function (t) {
        return '<option value="' + esc(t.id) + '">' + esc(t.title) + '</option>';
      }).join('');
      var orphanBlock = !orphans.length ? '' :
        '<div class="card" style="margin-top:18px;padding:14px 16px;border-color:rgba(196,145,124,.22);background:rgba(196,145,124,.03)">' +
          '<div style="font-size:12.5px;color:#8a7568;margin-bottom:10px">' +
            orphans.length + ' goal' + (orphans.length === 1 ? " isn't" : "s aren't") + ' traced to Identity yet. ' +
            'Pick where each one traces to, or leave it untethered.</div>' +
          orphans.map(function (o) {
            return '<div style="display:flex;align-items:center;gap:10px;padding:5px 0">' +
              '<button class="linked-row" data-open="' + esc(o.id) + '" style="flex:1;min-width:0">' +
                '<span class="num">' + esc(getSpaceInfo(o).label) + '</span>' + esc(o.title) + '</button>' +
              '<select data-linkpick="' + esc(o.id) + '" style="font-family:IBM Plex Mono,monospace;font-size:9.5px;' +
                'color:#4a5563;border:1px solid rgba(30,41,59,.14);border-radius:7px;padding:5px 6px;background:#fff;max-width:190px">' +
                pickerOptions + '</select>' +
              '<button data-untether="' + esc(o.id) + '" style="font-family:IBM Plex Mono,monospace;font-size:9px;' +
                'letter-spacing:.1em;text-transform:uppercase;color:#7a8794;background:#fff;' +
                'border:1px solid rgba(30,41,59,.14);border-radius:7px;padding:6px 10px;cursor:pointer">Leave untethered</button>' +
            '</div>';
          }).join('') +
        '</div>';

      return '<div class="card">' + body + '</div>' + orphanBlock;
    }

    function renderHome() {
      var visible = filteredItems();
      var query = state.query.trim();
      var goals = ((state.review && state.review.activeGoals) || []).concat(
        state.items.filter(function (item) { return item.type === 'goal' && item.status === 'done'; }).slice(0, 3)
      );
      var showToday = !query && state.filterSpace === 'all' && !state.filterType && goals.length > 0;
      var openGoals = goals.filter(function (goal) { return goal.status !== 'done'; }).length;

      // The review opens with the reason, not the list: one active identity goal on top.
      var anchor = identityItems().filter(function (i) {
        return i.type === 'goal' && i.status === 'active';
      })[0];
      var becauseBlock = !anchor ? '' :
        '<button class="goal-row" data-open="' + esc(anchor.id) + '" ' +
          'style="width:100%;display:block;text-align:left;padding:14px 16px;border-bottom:1px solid rgba(30,41,59,.08)">' +
          '<span style="display:block;font-family:IBM Plex Mono,monospace;font-size:9.5px;letter-spacing:.16em;' +
            'text-transform:uppercase;color:' + IDENTITY_COLOR + '">Today, because</span>' +
          '<span style="display:block;font-size:16px;font-weight:600;margin-top:4px">' + esc(anchor.title) + '</span>' +
        '</button>';

      var todaySection = !showToday ? '' :
        '<section>' +
          '<div class="sec-head"><h2 class="sec">Today — Daily Review</h2>' +
          '<span class="sec-meta">' + todayLine() + ' / ' + pad(openGoals) + ' ACTIVE</span></div>' +
          '<div class="card">' + becauseBlock + goals.map(function (goal, i) {
            var done = goal.status === 'done';
            return '<button class="goal-row" data-goal="' + esc(goal.id) + '">' +
              '<span class="num" style="width:26px">' + pad(i + 1) + '</span>' +
              '<span class="box' + (done ? ' done' : '') + '">' + (done ? '✓' : '') + '</span>' +
              '<span class="row-title' + (done ? ' done' : '') + '">' + esc(goal.title) + '</span>' +
              '<span class="sec-meta">' + esc(getSpaceInfo(goal).label) + '</span></button>';
          }).join('') + '</div>' +
        '</section>';

      var upcoming = (!query && state.filterSpace === 'all' && !state.filterType)
        ? ((state.review && state.review.upcomingTasks) || []) : [];
      var upcomingSection = upcoming.length === 0 ? '' :
        '<section>' +
          '<div class="sec-head"><h2 class="sec">Upcoming Tasks</h2>' +
          '<span class="sec-meta">Next 7 days · ' + upcoming.length + ' due</span></div>' +
          '<div class="card">' + upcoming.map(function(task, i) {
            var done = task.status === 'done';
            var overdue = task.due_date && task.due_date < Date.now() / 1000;
            return '<button class="goal-row" data-open="' + esc(task.id) + '">' +
              '<span class="num" style="width:26px">' + pad(i+1) + '</span>' +
              '<span class="box' + (done ? ' done' : '') + '">' + (done ? '✓' : '') + '</span>' +
              '<span class="row-title' + (done ? ' done' : '') + '">' + esc(task.title) + '</span>' +
              '<span class="sec-meta" style="' + (overdue ? 'color:#b4776f' : '') + '">' + esc(formatDue(task.due_date)) + '</span></button>';
          }).join('') + '</div>' +
        '</section>';

      var heading = query ? 'Search' : state.filterSpace === 'all' ? 'Everything' : state.filterSpace === 'unsorted' ? 'Unsorted' : (SPACES[state.filterSpace] ? SPACES[state.filterSpace].label : state.filterSpace);
      var chips = [{ key: null, label: 'All' }].concat(TYPE_KEYS.map(function (key) { return { key: key, label: TYPES[key].label }; }));

      var feed = visible.length ? visible.map(function (item) {
        var type = typeOf(item);
        // Lineage chip — goals carry their identity ancestor wherever they are shown.
        var ancestor = type === 'goal' ? identityAncestor(item) : null;
        var lineage = type !== 'goal' || isIdentity(item) ? ''
          : ancestor
            ? '<span class="sec-meta" style="color:' + IDENTITY_COLOR + ';text-transform:none;letter-spacing:0">↑ ' + esc(ancestor.title) + '</span>'
            : '<span class="tag" style="border-style:dashed;color:#9aa6b3">+ link to identity</span>';
        return '<button class="feed-card" data-open="' + esc(item.id) + '">' +
          '<span class="num" style="padding-top:3px">' + num(item) + '</span>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="feed-meta">' +
              '<span class="tag" style="color:' + TYPES[type].color + ';border-color:' + TYPES[type].border + '">' + esc(TYPES[type].label) + '</span>' +
              '<span class="sec-meta">' + esc(getSpaceInfo(item).label) + '</span>' +
              lineage +
              '<span style="flex:1"></span>' +
              '<span class="num">' + stamp(item.updated_at) + '</span>' +
            '</div>' +
            '<div class="feed-title">' + esc(item.title) + '</div>' +
            '<div class="feed-snippet">' + esc(snippetOf(item)) + '</div>' +
          '</div></button>';
      }).join('') : '<div class="placeholder">Nothing here yet</div>';

      return '<div class="home">' + todaySection + upcomingSection +
        '<section>' +
          '<div class="sec-head" style="align-items:center">' +
            '<div style="display:flex;align-items:center;gap:8px">' +
              '<h2 class="sec">' + esc(heading) + '</h2>' +
              '<span class="num">' + visible.length + ' items</span></div>' +
            '<div class="chips">' + chips.map(function (chip) {
              var active = state.filterType === chip.key;
              return '<button class="chip' + (active ? ' active' : '') + '" data-chip="' + (chip.key || 'all') + '">' + esc(chip.label) + '</button>';
            }).join('') + '</div>' +
          '</div>' +
          '<div class="feed">' + feed + '</div>' +
        '</section></div>';
    }

    function renderProse(content) {
      var lines = String(content || '').split('\\n');
      var html = '', bullets = [];
      function flush() {
        if (!bullets.length) return;
        html += bullets.map(function (text) {
          var match = text.match(/^(\\*\\*(.+?)\\*\\*)?\\s*(.*)$/);
          var lead = match && match[2] ? '<b style="font-weight:600">' + esc(match[2]) + '</b> ' : '';
          return '<div class="bullet"><span class="dash">—</span><span>' + lead + esc(match ? match[3] : text) + '</span></div>';
        }).join('');
        bullets = [];
      }
      lines.forEach(function (raw) {
        var line = raw.trim();
        if (/^[-*]\\s+/.test(line)) { bullets.push(line.replace(/^[-*]\\s+/, '')); return; }
        flush();
        if (!line) return;
        if (/^#{1,6}\\s+/.test(line)) html += '<h3>' + esc(line.replace(/^#{1,6}\\s+/, '')) + '</h3>';
        else html += '<p>' + esc(line) + '</p>';
      });
      flush();
      return html || '<p style="color:#93a0ae">Empty — hit Edit to start writing.</p>';
    }

    function renderSidebarMeta(item) {
      var tags = item.tags || [], related = item.related || [];
      var backlinks = state.backlinks || [];
      var overdue = item.due_date && item.due_date < Date.now() / 1000 && item.status !== 'done';

      // Every field the model lets you change is editable here. Writes go out on
      // change; nothing is staged, so there is no save button to forget.
      function select(field, options, current) {
        return '<select class="meta-edit" data-field="' + field + '">' + options.map(function (o) {
          return '<option value="' + esc(o.value) + '"' + (o.value === current ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('') + '</select>';
      }
      function field(label, control) {
        return '<div><div class="meta-label">' + label + '</div>' + control + '</div>';
      }

      var spaceOptions = [{ value: 'identity', label: '◈ Identity' }]
        .concat(SPACE_KEYS.map(function (k) { return { value: k, label: SPACES[k].label }; }))
        .concat([{ value: '', label: '— Unsorted —' }]);
      var typeOptions = TYPE_KEYS.map(function (k) { return { value: k, label: TYPES[k].label }; });
      var statusOptions = SCHEMA.statuses.map(function (k) { return { value: k, label: k }; });

      // "Traces to" — the parent that puts this item under an identity or a goal.
      var anchors = state.items.filter(function (c) {
        return c.id !== item.id && (c.space === 'identity' || c.type === 'goal' || c.type === 'page');
      });
      var parentOptions = [{ value: '', label: '— none —' }].concat(anchors.map(function (c) {
        return { value: c.id, label: (c.space === 'identity' ? '◈ ' : '') + c.title };
      }));
      var parentKnown = !item.parent_id || anchors.some(function (c) { return c.id === item.parent_id; });
      if (!parentKnown) parentOptions.push({ value: item.parent_id, label: '(current parent)' });

      return '<aside class="meta">' +
        field('Traces to ↑', select('parent_id', parentOptions, item.parent_id || '') +
          (item.parent_id ? '<button class="linked-row" data-open="' + esc(item.parent_id) + '" style="margin-top:6px">' +
            '<span class="num">↑</span>open parent</button>' : '')) +
        field('Space', select('space', spaceOptions, item.space || '')) +
        field('Type', select('type', typeOptions, typeOf(item))) +
        field('Status', select('status', statusOptions, item.status)) +
        field('Due', '<input class="meta-edit" type="date" data-field="due_date" value="' +
          esc(item.due_date ? isoDate(item.due_date) : '') + '">' +
          (overdue ? '<div class="meta-label" style="color:#b4776f;margin-top:5px">overdue</div>' : '')) +
        field('Tags', '<input class="meta-edit" data-field="tags" value="' + esc(tags.join(', ')) +
          '" placeholder="comma, separated">') +
        (related.length ? field('Linked →', '<div style="display:flex;flex-direction:column;gap:7px">' +
          related.map(function (id) {
            var target = state.items.find(function (candidate) { return candidate.id === id; });
            return '<button class="linked-row" data-open="' + esc(id) + '"><span class="num">→</span>' + esc(target ? target.title : id) + '</button>';
          }).join('') + '</div>') : '') +
        (backlinks.length ? field('Backlinks ←', '<div style="display:flex;flex-direction:column;gap:7px">' +
          backlinks.map(function (bl) {
            return '<button class="linked-row" data-open="' + esc(bl.id) + '"><span class="num">←</span>' + esc(bl.title) + '</button>';
          }).join('') + '</div>') : '') +
      '</aside>';
    }

    function detailHead(item, extra) {
      return '<div class="detail-head">' +
        '<button class="crumb" id="back">← ' + esc(getSpaceInfo(item).label + ' / ' + TYPES[typeOf(item)].label + 's / N°' + num(item)) + '</button>' +
        (extra || '<div class="actions"><button data-act="edit">' + (state.editing ? 'Save' : 'Edit') + '</button><button data-act="archive">Archive</button><button data-act="delete">Delete</button></div>') +
      '</div>';
    }

    function renderDetail(item) {
      var type = typeOf(item);
      var bodyHtml = state.editing
        ? '<textarea class="editor" id="editor">' + esc(item.content || '') + '</textarea>'
        : '<div class="prose">' + renderProse(item.content) + '</div>';
      return '<div class="detail"><div class="detail-main">' + detailHead(item) +
        '<input class="title-edit" data-field="title" value="' + esc(item.title) + '">' +
        '<div class="meta-line">' + esc(TYPES[type].label) + ' · N°' + num(item) + ' · Edited ' + stamp(item.updated_at) + '</div>' +
        bodyHtml +
        renderSubtasks(item) +
        '</div>' + renderSidebarMeta(item) + '</div>';
    }

    // Subtasks are child task items (parent_id = this item), not freeform
    // metadata — the same rows get_children returns.
    function renderSubtasks(item) {
      if (typeOf(item) === 'task') return '';
      var tasks = childTasks(item);
      var done = tasks.filter(function (t) { return t.status === 'done'; }).length;
      var pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
      var progress = !tasks.length ? '' :
        '<div class="progress" style="margin:0 0 14px"><span class="label">' + done + ' / ' + tasks.length + ' done</span>' +
        '<div class="track"><div class="bar" style="width:' + pct + '%"></div></div></div>';
      return '<div style="margin-top:26px">' +
        (tasks.length ? '<div class="group-name">Subtasks</div>' : '') +
        progress +
        tasks.map(function (task) {
          var isDone = task.status === 'done';
          return '<button class="check-row" data-task-toggle="' + esc(task.id) + '">' +
            '<span class="box green' + (isDone ? ' done' : '') + '">' + (isDone ? '✓' : '') + '</span>' +
            '<span class="text' + (isDone ? ' done' : '') + '">' + esc(task.title) + '</span>' +
            (task.due_date ? '<span class="sec-meta">' + esc(formatDue(task.due_date)) + '</span>' : '') +
          '</button>';
        }).join('') +
        '<div class="add-row"><span class="plus">+</span><input data-add-subtask placeholder="' +
          (tasks.length ? 'Add a subtask' : 'Break this down — add a subtask') + '"></div>' +
      '</div>';
    }

    function renderCapture() {
      var capture = state.capture;
      return '<div class="overlay" id="overlay"><div class="modal" id="modal">' +
        '<div class="modal-head"><span class="t">Capture — new item</span><button class="crumb" id="closeCapture">esc</button></div>' +
        '<div class="modal-body">' +
          '<input class="title" id="capTitle" placeholder="Title…" value="' + esc(capture.title) + '" autofocus>' +
          '<div class="field-label">Type</div><div class="pick">' + TYPE_KEYS.map(function (key) {
            return '<button data-cap-type="' + key + '" class="' + (capture.type === key ? 'active' : '') + '">' + esc(TYPES[key].label) + '</button>';
          }).join('') + '</div>' +
          // One inbox, one promote gesture: Identity is the first option here, set apart,
          // rather than a second capture box that forces classification at throw-time.
          '<div class="field-label">Space</div><div class="pick spaces">' +
            '<button data-cap-space="identity" class="' + (capture.space === 'identity' ? 'active' : '') + '"' +
              ' style="border-color:rgba(196,145,124,.5);color:' + IDENTITY_COLOR + '">↑ Identity</button>' +
            SPACE_KEYS.map(function (key) {
              return '<button data-cap-space="' + key + '" class="' + (capture.space === key ? 'active' : '') + '">' + esc(SPACES[key].label) + '</button>';
            }).join('') + '</div>' +
          (capture.type === 'task' ? '<div class="field-label">Due date</div><input type="date" id="capDue" value="' + esc(capture.due || '') + '" style="width:100%;padding:8px 10px;border:1px solid rgba(30,41,59,.12);border-radius:8px;margin-bottom:20px;font-family:IBM Plex Mono,monospace;font-size:12px;outline:none;background:#fff;color:#1e2530"></input>' : '') +
          '<div class="modal-foot">' +
            '<button class="btn-ghost" id="cancelCapture">Cancel</button>' +
            '<button class="btn-primary" id="submitCapture"' + (capture.title.trim() ? '' : ' disabled') + '>Create item</button>' +
          '</div>' +
        '</div></div></div>';
    }

    // ---------- events ----------
    function bind() {
      document.querySelectorAll('[data-space]').forEach(function (element) {
        element.onclick = function () { state.filterSpace = element.dataset.space; state.view = 'home'; render(); };
      });
      document.querySelectorAll('[data-type]').forEach(function (element) {
        element.onclick = function () {
          state.filterType = state.filterType === element.dataset.type && state.view === 'home' ? null : element.dataset.type;
          state.view = 'home'; render();
        };
      });
      document.querySelectorAll('[data-chip]').forEach(function (element) {
        element.onclick = function () {
          var key = element.dataset.chip;
          state.filterType = key === 'all' ? null : (state.filterType === key ? null : key);
          render();
        };
      });
      document.querySelectorAll('[data-open]').forEach(function (element) {
        element.onclick = function () { openItem(element.dataset.open); };
      });
      document.querySelectorAll('[data-goal]').forEach(function (element) {
        element.onclick = function () {
          var goal = state.items.concat((state.review && state.review.activeGoals) || [])
            .find(function (candidate) { return candidate.id === element.dataset.goal; });
          if (goal) toggleGoal(goal);
        };
      });
      var identityBtn = document.getElementById('identityBtn');
      if (identityBtn) identityBtn.onclick = function() { state.view = 'identity'; state.activeId = null; render(); };
      document.querySelectorAll('[data-idtab]').forEach(function (element) {
        element.onclick = function () { state.identityTab = element.dataset.idtab; render(); };
      });
      document.querySelectorAll('[data-idfold]').forEach(function (element) {
        element.onclick = function () {
          var id = element.dataset.idfold;
          state.collapsed[id] = !state.collapsed[id];
          render();
        };
      });
      document.querySelectorAll('[data-untether]').forEach(function (element) {
        element.onclick = function () { untether(element.dataset.untether); };
      });
      document.querySelectorAll('[data-linkpick]').forEach(function (element) {
        element.onchange = function () {
          if (element.value) linkToIdentity(element.dataset.linkpick, element.value);
        };
      });
      document.querySelectorAll('[data-capture-identity]').forEach(function (element) {
        element.onclick = function () {
          state.capture = { title: '', type: 'goal', space: 'identity' };
          render();
        };
      });
      document.querySelectorAll('.graph-space').forEach(function(el) {
        el.onclick = function() {
          var sp = el.dataset.space;
          if (!sp || sp === 'identity') { state.view = 'identity'; state.identityTab = 'cascade'; render(); return; }
          state.filterSpace = sp; state.view = 'home'; render();
        };
      });
      var back = document.getElementById('back');
      if (back) back.onclick = goHome;
      document.querySelectorAll('[data-field]').forEach(function (element) {
        var field = element.dataset.field;
        // Selects and dates commit on change; free text commits on blur or Enter,
        // so a re-render never yanks the cursor mid-word.
        if (element.tagName === 'SELECT' || element.type === 'date') {
          element.onchange = function () { commitField(field, element.value); };
          return;
        }
        element.onblur = function () { commitField(field, element.value); };
        element.onkeydown = function (event) {
          if (event.key === 'Enter') { event.preventDefault(); element.blur(); }
          if (event.key === 'Escape') { element.value = String(activeItem()[field] || ''); element.blur(); }
        };
      });
      document.querySelectorAll('[data-act]').forEach(function (element) {
        element.onclick = function () { itemAction(element.dataset.act); };
      });
      document.querySelectorAll('[data-task-toggle]').forEach(function (element) {
        element.onclick = function () {
          var task = state.items.find(function (candidate) { return candidate.id === element.dataset.taskToggle; });
          if (task) toggleTask(task);
        };
      });
      var addSubtaskInput = document.querySelector('[data-add-subtask]');
      if (addSubtaskInput) addSubtaskInput.onkeydown = function (event) {
        if (event.key !== 'Enter') return;
        addSubtask(activeItem(), addSubtaskInput.value); addSubtaskInput.value = '';
      };
      bindCapture();
      bindUnlock();
    }

    // One field, one PATCH. Empty string means "clear it" for the nullable fields.
    function commitField(field, raw) {
      var item = activeItem();
      if (!item) return;
      var value = raw;
      if (field === 'tags') {
        value = raw.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
        if (value.join(',') === (item.tags || []).join(',')) return;
      } else if (field === 'due_date') {
        value = raw ? Math.floor(new Date(raw + 'T00:00:00').getTime() / 1000) : null;
        if (value === (item.due_date || null)) return;
      } else if (field === 'space') {
        value = raw || null;
        if (value === (item.space || null)) return;
      } else if (field === 'parent_id') {
        value = raw || null;
        if (value === (item.parent_id || null)) return;
        if (value === item.id) { toast('An item cannot be its own parent'); render(); return; }
      } else if (field === 'title') {
        value = raw.trim();
        if (!value) { toast('Title cannot be empty'); render(); return; }
        if (value === item.title) return;
      } else if (value === item[field]) return;

      var updates = {};
      updates[field] = value;
      patchItem(item.id, updates);
      toast(field.replace('_', ' ') + ' updated');
    }

    function itemAction(action) {
      var item = activeItem();
      if (!item) return;
      if (action === 'edit') {
        if (state.editing) {
          var editor = document.getElementById('editor');
          var content = editor ? editor.value : item.content;
          state.editing = false;
          patchItem(item.id, { content: content });
        } else { state.editing = true; render(); setTimeout(function () { var e = document.getElementById('editor'); if (e) e.focus(); }, 0); }
        return;
      }
      if (action === 'archive') { patchItem(item.id, { status: 'archived' }); goHome(); return; }
      if (action === 'delete') {
        if (!confirm('Delete "' + item.title + '"? This cannot be undone.')) return;
        write('DELETE', '/api/items/' + item.id).then(function () {
          state.items = state.items.filter(function (candidate) { return candidate.id !== item.id; });
          goHome(); toast('Item deleted');
        }).catch(function (error) { toast(error.message); });
      }
    }

    function bindCapture() {
      if (!state.capture || state.unlockPrompt) return;
      var overlay = document.getElementById('overlay');
      var modal = document.getElementById('modal');
      overlay.onclick = closeCapture;
      modal.onclick = function (event) { event.stopPropagation(); };
      document.getElementById('closeCapture').onclick = closeCapture;
      document.getElementById('cancelCapture').onclick = closeCapture;
      var title = document.getElementById('capTitle');
      title.oninput = function () {
        state.capture.title = title.value;
        document.getElementById('submitCapture').disabled = !title.value.trim();
      };
      title.onkeydown = function (event) { if (event.key === 'Enter') submitCapture(); };
      title.focus();
      title.setSelectionRange(title.value.length, title.value.length);
      document.querySelectorAll('[data-cap-type]').forEach(function (element) {
        element.onclick = function () { state.capture.type = element.dataset.capType; render(); };
      });
      document.querySelectorAll('[data-cap-space]').forEach(function (element) {
        element.onclick = function () { state.capture.space = element.dataset.capSpace; render(); };
      });
      var dueInput = document.getElementById('capDue');
      if (dueInput) dueInput.oninput = function() { state.capture.due = dueInput.value; };
      document.getElementById('submitCapture').onclick = submitCapture;
    }

    function closeCapture() { state.capture = null; render(); }

    async function submitCapture() {
      var capture = state.capture;
      if (!capture || !capture.title.trim()) return;
      try {
        var payload = {
          title: capture.title.trim(),
          type: capture.type,
          space: capture.space,
          status: capture.type === 'goal' ? 'active' : 'inbox'
        };
        if (capture.type === 'task' && capture.due) {
          payload.due_date = Math.floor(new Date(capture.due).getTime() / 1000);
        }
        var created = await write('POST', '/api/items', payload);
        state.capture = null;
        mergeItem(created);
        state.view = 'home'; state.filterSpace = 'all'; state.filterType = null; state.query = '';
        document.getElementById('search').value = '';
        render();
        refreshIdentity().then(render);
        toast('Captured N°' + num(created));
      } catch (error) { failWrite(error, submitCapture); }
    }

    function renderUnlock() {
      var prompt = state.unlockPrompt;
      return '<div class="overlay" id="unlockOverlay"><div class="modal" id="unlockModal" style="width:420px">' +
        '<div class="modal-head"><span class="t">Unlock workspace</span><button class="crumb" id="closeUnlock">esc</button></div>' +
        '<div class="modal-body">' +
          '<div style="font-size:13.5px;color:#7a8794;line-height:1.6;margin-bottom:18px">Enter your key once — this browser stays signed in.</div>' +
          '<input class="title mono" id="unlockKey" type="password" placeholder="API key" style="font-size:15px" value="' + esc(prompt.key) + '">' +
          (prompt.error ? '<div class="field-label" style="color:#b4776f">' + esc(prompt.error) + '</div>' : '') +
          '<div class="modal-foot"><button class="btn-ghost" id="cancelUnlock">Cancel</button>' +
          '<button class="btn-primary" id="submitUnlock">Unlock</button></div>' +
        '</div></div></div>';
    }

    function bindUnlock() {
      if (!state.unlockPrompt) return;
      var input = document.getElementById('unlockKey');
      input.oninput = function () { state.unlockPrompt.key = input.value; };
      input.onkeydown = function (event) { if (event.key === 'Enter') submitUnlock(); };
      input.focus();
      document.getElementById('unlockOverlay').onclick = closeUnlock;
      document.getElementById('unlockModal').onclick = function (event) { event.stopPropagation(); };
      document.getElementById('closeUnlock').onclick = closeUnlock;
      document.getElementById('cancelUnlock').onclick = closeUnlock;
      document.getElementById('submitUnlock').onclick = submitUnlock;
    }

    function closeUnlock() { state.unlockPrompt = null; render(); }

    async function submitUnlock() {
      var prompt = state.unlockPrompt;
      if (!prompt || !prompt.key.trim()) return;
      try {
        await unlock(prompt.key.trim());
        var retry = prompt.retry;
        state.unlockPrompt = null;
        render();
        if (retry) retry();
      } catch (error) {
        prompt.error = error.message;
        render();
      }
    }

    document.getElementById('brand').onclick = goHome;
    document.getElementById('openCapture').onclick = function () {
      state.capture = { title: '', type: 'idea', space: null };
      render();
    };
    document.getElementById('search').oninput = function (event) {
      state.query = event.target.value;
      state.view = 'home';
      render();
    };
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.unlockPrompt) closeUnlock();
      else if (event.key === 'Escape' && state.capture) closeCapture();
      else if (event.key === 'Escape' && state.view === 'item') goHome();
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); document.getElementById('search').focus();
      }
    });

    // Never show stale state: refresh quietly whenever the window regains
    // focus (e.g. after an agent wrote via MCP), unless mid-edit or mid-modal.
    window.addEventListener('focus', function () {
      if (state.loading || state.editing || state.capture || state.unlockPrompt) return;
      load(true);
    });

    load();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char] ?? char;
  });
}
