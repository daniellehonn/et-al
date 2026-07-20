import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
  DB: D1Database;
  ET_AL_API_KEY?: string;
  SECOND_BRAIN_API_KEY?: string;
  APP_NAME?: string;
}

type ItemType = "page" | "goal" | "idea" | "task" | "link";
type ItemSpace = "school" | "career" | "learning" | "projects" | "life" | "saved";
// What the API and MCP tools accept for a space: a real space, or the "identity"
// keyword, which is stored as NULL (the identity layer sits above the spaces).
type SpaceInput = ItemSpace | "identity";
// space is null for items in the identity layer
type ItemStatus = "active" | "paused" | "done" | "archived" | "inbox";
type ListOptions = {
  type: string | null;
  space: string | null; // "identity" is a virtual filter that maps to WHERE space IS NULL
  status: string | null;
  parent_id: string | null;
  limit: number;
  offset: number;
};

interface Item {
  id: string;
  type: ItemType;
  title: string;
  space: ItemSpace | null; // null = identity layer
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

const TYPES = new Set<ItemType>(["page", "goal", "idea", "task", "link"]);
const SPACES = new Set<ItemSpace>(["school", "career", "learning", "projects", "life", "saved"]);
const STATUSES = new Set<ItemStatus>(["active", "paused", "done", "archived", "inbox"]);

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
      if (url.pathname === "/health") return json({ ok: true, service: "et-al" });

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
    "list_items",
    {
      description: "List et al. items filtered by type, space, status, parent_id, limit, and offset.",
      inputSchema: {
        type: z.enum(["page", "goal", "idea", "task", "link"]).optional(),
        space: z.enum(["identity", "school", "career", "learning", "projects", "life", "saved"]).optional(),
        status: z.enum(["active", "paused", "done", "archived", "inbox"]).optional(),
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
      description: "Create a new et al. item. Use dump/inbox for messy capture when structure is unclear. Use task type with due_date for actionable to-dos. Use identity space for profile data (skills, experiences).",
      inputSchema: {
        type: z.enum(["page", "goal", "idea", "task", "link"]).default("idea"),
        title: z.string().min(1),
        space: z.enum(["identity", "school", "career", "learning", "projects", "life", "saved"]).optional(),
        status: z.enum(["active", "paused", "done", "archived", "inbox"]).optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        content: z.string().optional(),
        related: z.array(z.string()).optional(),
        parent_id: z.string().optional().describe("Parent item ID — use to nest tasks under pages or notes under goals"),
        due_date: z.number().int().optional().describe("Unix timestamp deadline, primarily for tasks"),
      },
    },
    async (input) => mcpJson(await createItem(env.DB, input)),
  );

  server.registerTool(
    "update_item",
    {
      description: "Partially update an existing et al. item by ID.",
      inputSchema: {
        id: z.string().min(1),
        type: z.enum(["page", "goal", "idea", "task", "link"]).optional(),
        title: z.string().min(1).optional(),
        space: z.enum(["identity", "school", "career", "learning", "projects", "life", "saved"]).optional(),
        status: z.enum(["active", "paused", "done", "archived", "inbox"]).optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        content: z.string().optional(),
        related: z.array(z.string()).optional(),
        parent_id: z.string().nullable().optional().describe("Set to null to remove parent"),
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
      description: "Search et al. items across title, content, and tags. Optional filters narrow the result set.",
      inputSchema: {
        query: z.string().min(1),
        type: z.enum(["page", "goal", "idea", "task", "link"]).optional(),
        space: z.enum(["identity", "school", "career", "learning", "projects", "life", "saved"]).optional(),
        status: z.enum(["active", "paused", "done", "archived", "inbox"]).optional(),
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
      description: "Update status, space, tags, or related IDs for multiple items at once.",
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).max(50),
        status: z.enum(["active", "paused", "done", "archived", "inbox"]).optional(),
        space: z.enum(["identity", "school", "career", "learning", "projects", "life", "saved"]).optional(),
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
      description: "List items that are direct children of a given parent item (by parent_id). Useful for getting tasks under a page, or notes under a goal.",
      inputSchema: {
        parent_id: z.string().min(1),
        type: z.enum(["page", "goal", "idea", "task", "link"]).optional(),
        status: z.enum(["active", "paused", "done", "archived", "inbox"]).optional(),
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
        space: z.enum(["identity", "school", "career", "learning", "projects", "life", "saved"]),
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
    limit: clampNumber(String(input.limit ?? ""), 1, 100, 30),
    offset: clampNumber(String(input.offset ?? ""), 0, 10000, 0),
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
    if (options.space === "identity") {
      clauses.push("space IS NULL");
    } else {
      if (!SPACES.has(options.space as ItemSpace)) throw new Error("Invalid space");
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
    if (options.space === "identity") {
      clauses.push("items.space IS NULL");
    } else {
      if (!SPACES.has(options.space as ItemSpace)) throw new Error("Invalid space");
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

async function createItem(db: D1Database, payload: unknown): Promise<ItemResponse> {
  const input = parseCreatePayload(payload);
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
  // "identity" is accepted here and normalized to NULL by parseUpdatePayload.
  updates: Partial<{ status: ItemStatus; space: SpaceInput; tags: string[]; related: string[] }>,
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
    WHERE status = 'inbox' OR type = 'dump'
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

// One round trip for the whole Identity home screen. Every lens (Core, Constellation,
// Cascade) reads from this, so fanning out per-item /backlinks calls would be an N+1.
async function getIdentityGraph(db: D1Database) {
  const identity = await db.prepare(`
    SELECT * FROM items
    WHERE space IS NULL AND status != 'archived'
    ORDER BY type = 'goal' DESC, updated_at DESC
  `).all<Item>();

  // Space items pointing back up at any identity item — ring 2 of the constellation.
  const inbound = await db.prepare(`
    SELECT DISTINCT items.*, je.value AS identity_id
    FROM items, json_each(items.related) je
    WHERE items.space IS NOT NULL
      AND items.status != 'archived'
      AND je.value IN (SELECT id FROM items WHERE space IS NULL)
    ORDER BY items.updated_at DESC
  `).all<Item & { identity_id: string }>();

  // Space goals with no identity ancestor at all — the orphan callout.
  const orphanGoals = await db.prepare(`
    SELECT * FROM items
    WHERE type = 'goal' AND space IS NOT NULL
      AND status NOT IN ('done', 'archived')
      AND json_extract(metadata, '$.untethered') IS NOT 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(items.related) je
        WHERE je.value IN (SELECT id FROM items WHERE space IS NULL)
      )
    ORDER BY updated_at DESC
  `).all<Item>();

  const links: Record<string, ItemResponse[]> = {};
  for (const row of inbound.results ?? []) {
    (links[row.identity_id] ??= []).push(serializeItem(row));
  }

  return {
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

async function summarizeSpace(db: D1Database, space: SpaceInput, recentLimit: number) {
  // The identity layer is space IS NULL, so it needs a different predicate.
  const result = space === "identity"
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
  if (type === "goal" && /\b(life|career|identity|purpose|vision|brand)\b/.test(text)) return null; // identity layer
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
  const type = readEnum(payload.type, TYPES, "idea");
  // null space = identity layer; "identity" keyword also maps to null
  const rawSpace = payload.space;
  const space: ItemSpace | null =
    rawSpace === "identity" || rawSpace === null || rawSpace === undefined
      ? null
      : SPACES.has(rawSpace as ItemSpace) ? (rawSpace as ItemSpace) : null;
  const status = readEnum(payload.status, STATUSES, type === "goal" ? "active" : "inbox");

  return {
    type,
    title: title || "Untitled capture",
    space,
    status,
    tags: readTags(payload.tags),
    metadata: readObject(payload.metadata),
    content: readString(payload.content, ""),
    related: readStringArray(payload.related),
    parent_id: typeof payload.parent_id === "string" && payload.parent_id ? payload.parent_id : null,
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
  if ("type" in payload) out.type = readEnum(payload.type, TYPES, "idea");
  if ("title" in payload) out.title = readString(payload.title, "").trim() || "Untitled capture";
  if ("space" in payload) {
    const s = payload.space;
    out.space = (s === "identity" || s === null) ? null : (SPACES.has(s as ItemSpace) ? s as ItemSpace : null);
  }
  if ("status" in payload) out.status = readEnum(payload.status, STATUSES, "inbox");
  if ("tags" in payload) out.tags = readTags(payload.tags);
  if ("metadata" in payload) out.metadata = readObject(payload.metadata);
  if ("content" in payload) out.content = readString(payload.content, "");
  if ("related" in payload) out.related = readStringArray(payload.related);
  if ("parent_id" in payload) out.parent_id = typeof payload.parent_id === "string" && payload.parent_id ? payload.parent_id : null;
  if ("due_date" in payload) out.due_date = readDueDate(payload.due_date);
  return out;
}

function readDueDate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value) {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? Math.floor(ts / 1000) : null;
  }
  return null;
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

function readTags(value: unknown): string[] {
  return readStringArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean);
}

function readEnum<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? value as T : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: string | null, min: number, max: number, fallback: number): number {
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
    var SPACES = {
      school:   { label: 'School',   dot: '#7c93ab' },
      career:   { label: 'Career',   dot: '#b1a07c' },
      learning: { label: 'Learning', dot: '#6f8fa8' },
      projects: { label: 'Projects', dot: '#7ca88f' },
      life:     { label: 'Life',     dot: '#c48b8b' },
      saved:    { label: 'Saved',    dot: '#8a7cab' }
    };
    var TYPES = {
      page: { label: 'Page', color: '#7c93ab', border: 'rgba(124,147,171,.35)' },
      goal: { label: 'Goal', color: '#93a3b6', border: 'rgba(147,163,182,.35)' },
      idea: { label: 'Idea', color: '#7ca88f', border: 'rgba(124,168,143,.35)' },
      task: { label: 'Task', color: '#c4917c', border: 'rgba(196,145,124,.35)' },
      link: { label: 'Link', color: '#b1a07c', border: 'rgba(177,160,124,.35)' }
    };
    var TYPE_KEYS = ['page', 'goal', 'idea', 'task', 'link'];
    var SPACE_KEYS = ['school', 'career', 'learning', 'projects', 'life', 'saved'];
    var IDENTITY_COLOR = '#c4917c';

    var state = {
      view: 'home', activeId: null, filterSpace: 'all', filterType: null, query: '',
      items: [], review: null, loading: true, error: null, editing: false, capture: null, toast: null,
      authed: false, unlockPrompt: null, backlinks: null,
      // Core is the default lens: you land on your own words, not on a diagram
      // you have already absorbed. The last-used lens survives a re-render.
      identity: null, identityTab: 'core'
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
      return sp ? SPACES[sp] : { label: 'Identity', dot: IDENTITY_COLOR };
    }
    function isIdentity(item) { return !item.space; }
    function identityItems() { return (state.identity && state.identity.identity) || state.items.filter(isIdentity); }
    // The lineage chip: the identity item this one explicitly points back up at.
    function identityAncestor(item) {
      if (!item || isIdentity(item)) return null;
      var pool = identityItems();
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
    function checklistOf(item) {
      var list = item.metadata && item.metadata.checklist;
      return Array.isArray(list) ? list : null;
    }
    function toast(message) {
      state.toast = message;
      render();
      clearTimeout(toast.timer);
      toast.timer = setTimeout(function () { state.toast = null; render(); }, 2200);
    }

    // ---------- data ----------
    async function load() {
      state.loading = true; state.error = null; render();
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
      } catch (error) {
        state.error = error && error.message ? error.message : 'The workspace could not be loaded.';
      } finally {
        state.loading = false; render();
      }
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
      } catch (error) { failWrite(error, function () { patchItem(id, updates); }); }
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

    function toggleCheck(item, index) {
      var list = (checklistOf(item) || []).map(function (entry, i) {
        return i === index ? { text: entry.text, done: !entry.done } : entry;
      });
      var metadata = Object.assign({}, item.metadata, { checklist: list });
      patchItem(item.id, { metadata: metadata });
    }

    function addCheck(item, text) {
      var value = text.trim(); if (!value) return;
      var list = (checklistOf(item) || []).concat([{ text: value, done: false }]);
      patchItem(item.id, { metadata: Object.assign({}, item.metadata, { checklist: list }) });
    }

    function addThought(item, text) {
      var value = text.trim(); if (!value) return;
      var line = '[' + clock(Date.now() / 1000) + '] ' + value;
      var content = item.content ? line + '\\n' + item.content : line;
      patchItem(item.id, { content: content });
    }

    function filteredItems() {
      var query = state.query.trim().toLowerCase();
      return state.items.filter(function (item) {
        if (state.filterSpace === 'identity' && !isIdentity(item)) return false;
        if (state.filterSpace !== 'all' && state.filterSpace !== 'identity' && spaceOf(item) !== state.filterSpace) return false;
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
      state.items.forEach(function (item) {
        if (isIdentity(item)) { identityCount++; }
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

      // Spaces
      var rows = [{ key: 'all', label: 'All items', dot: '#1e2530', count: state.items.length }].concat(
        SPACE_KEYS.map(function (key) { return { key: key, label: SPACES[key].label, dot: SPACES[key].dot, count: counts[key] || 0 }; })
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
      document.getElementById('navFoot').innerHTML =
        'Everything is an item<br>Cap. ' + pad(state.items.length) + ' · Active ' + pad(open) + '<br>CF free tier · v2';
    }

    // ---------- identity ----------
    function renderIdentity() {
      var tabs = [
        { key: 'core', label: 'Core' },
        { key: 'constellation', label: 'Constellation' },
        { key: 'cascade', label: 'Cascade' }
      ];
      var body = state.identityTab === 'constellation' ? renderConstellation()
        : state.identityTab === 'cascade' ? renderCascade()
        : renderIdentityCore();

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

    // Core — the written self. The lens you open to remember.
    function renderIdentityCore() {
      var all = identityItems();
      var goals = all.filter(function (i) { return i.type === 'goal'; });
      var pages = all.filter(function (i) { return i.type !== 'goal'; });

      function group(title, list, empty) {
        return '<div class="sec-head" style="margin-top:18px"><h2 class="sec">' + title + '</h2>' +
          '<span class="sec-meta">' + list.length + '</span></div>' +
          (list.length ? '<div class="feed">' + list.map(function (item) {
            return '<button class="feed-card" data-open="' + esc(item.id) + '">' +
              '<span class="num" style="padding-top:3px">' + num(item) + '</span>' +
              '<div style="flex:1;min-width:0">' +
                '<div class="feed-title">' + esc(item.title) + '</div>' +
                '<div class="feed-snippet">' + esc(snippetOf(item)) + '</div>' +
              '</div></button>';
          }).join('') + '</div>' : '<div class="placeholder">' + empty + '</div>');
      }

      return group('Goals', goals, 'No identity goals yet — start with one thing you want to become') +
        group('Pages', pages, 'No identity pages yet — values, skills, how you present yourself');
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

      // Outer ring goal links — draw lines from identity goals to relevant spaces via related items
      goals.slice(0, 5).forEach(function(goal, gi) {
        var a = (gi / Math.max(goals.length, 1) - 0.5) * 0.8; // small arc near center top
        var gx = cx + 28 * Math.cos(a - Math.PI / 2), gy = cy + 28 * Math.sin(a - Math.PI / 2) - 8;
        (goal.related || []).forEach(function(relId) {
          var rel = state.items.find(function(i) { return i.id === relId; });
          if (rel && rel.space) {
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
        return '<div class="placeholder">Your Identity layer is empty — start with one goal, ' +
          'and the spaces below will have something to point back at.</div>';
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
        return '<button class="goal-row" data-open="' + esc(item.id) + '" style="width:100%">' +
          '<span class="dot" style="background:' + getSpaceInfo(item).dot + ';flex:none"></span>' +
          '<span class="row-title"' + (bold ? ' style="font-weight:600"' : '') + '>' + esc(item.title) + '</span>' +
          '<span class="tag" style="color:' + TYPES[typeOf(item)].color + ';border-color:' + TYPES[typeOf(item)].border + '">' +
            esc(getSpaceInfo(item).label.toLowerCase() + ' · ' + typeOf(item)) + '</span>' + due +
        '</button>';
      }
      function indent(inner) {
        return '<div style="margin-left:20px;border-left:1px solid rgba(30,41,59,.10);padding-left:10px">' + inner + '</div>';
      }

      var body = goals.length ? goals.map(function (goal) {
        var branches = (links[goal.id] || []).map(function (child) {
          var tasks = childrenOf(child.id);
          return row(child) + (tasks.length ? indent(tasks.map(function (t) { return row(t); }).join('')) : '');
        }).join('');
        return row(goal, true) + (branches ? indent(branches) :
          indent('<div class="placeholder" style="padding:10px 0;text-align:left">Nothing in any space points at this yet.</div>'));
      }).join('') : '<div class="placeholder">No identity goals yet — nothing to cascade from.</div>';

      var orphanBlock = !orphans.length ? '' :
        '<div class="card" style="margin-top:18px;border-color:rgba(196,145,124,.35);background:rgba(196,145,124,.05)">' +
          '<div style="font-size:12.5px;color:#8a6b5c;margin-bottom:8px">' +
            '<b>' + orphans.length + ' space goal' + (orphans.length === 1 ? " isn't" : "s aren't") + ' traced to Identity.</b> ' +
            'Link them, or mark one untethered to stop it asking.</div>' +
          orphans.map(function (o) {
            return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0">' +
              '<button class="linked-row" data-open="' + esc(o.id) + '" style="flex:1">' +
                '<span class="num">' + esc(getSpaceInfo(o).label) + '</span>' + esc(o.title) + '</button>' +
              '<button class="chip" data-untether="' + esc(o.id) + '">fine untethered</button>' +
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

      var heading = query ? 'Search' : state.filterSpace === 'all' ? 'Everything' : state.filterSpace === 'identity' ? 'Identity' : (SPACES[state.filterSpace] ? SPACES[state.filterSpace].label : state.filterSpace);
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
      var parent = item.parent_id ? state.items.find(function(c) { return c.id === item.parent_id; }) : null;
      var backlinks = state.backlinks || [];
      var overdue = item.due_date && item.due_date < Date.now() / 1000 && item.status !== 'done';
      var si = getSpaceInfo(item);
      return '<aside class="meta">' +
        (item.parent_id ? '<div><div class="meta-label">Parent</div>' +
          '<button class="linked-row" data-open="' + esc(item.parent_id) + '"><span class="num">↑</span>' +
          esc(parent ? parent.title : item.parent_id) + '</button></div>' : '') +
        '<div><div class="meta-label">Space</div><div class="meta-value"><span class="dot" style="background:' + si.dot + '"></span>' + esc(si.label) + '</div></div>' +
        '<div><div class="meta-label">Type</div><div class="meta-value">' + esc(TYPES[typeOf(item)].label) + '</div></div>' +
        '<div><div class="meta-label">Status</div><div class="meta-value">' + esc(item.status) + '</div></div>' +
        (item.due_date ? '<div><div class="meta-label">Due</div><div class="meta-value" style="color:' + (overdue ? '#b4776f' : '#4a5563') + ';font-family:IBM Plex Mono,monospace;font-size:11px">' + esc(formatDue(item.due_date)) + '</div></div>' : '') +
        (tags.length ? '<div><div class="meta-label">Tags</div><div style="display:flex;flex-wrap:wrap;gap:6px">' +
          tags.map(function (tag) { return '<span class="tag-pill">' + esc(tag) + '</span>'; }).join('') + '</div></div>' : '') +
        (related.length ? '<div><div class="meta-label">Linked →</div><div style="display:flex;flex-direction:column;gap:7px">' +
          related.map(function (id) {
            var target = state.items.find(function (candidate) { return candidate.id === id; });
            return '<button class="linked-row" data-open="' + esc(id) + '"><span class="num">→</span>' + esc(target ? target.title : id) + '</button>';
          }).join('') + '</div></div>' : '') +
        (backlinks.length ? '<div><div class="meta-label">Backlinks ←</div><div style="display:flex;flex-direction:column;gap:7px">' +
          backlinks.map(function(bl) {
            return '<button class="linked-row" data-open="' + esc(bl.id) + '"><span class="num">←</span>' + esc(bl.title) + '</button>';
          }).join('') + '</div></div>' : '') +
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
      if (type === 'dump') return renderDump(item);
      if (checklistOf(item)) return renderChecklist(item);
      var bodyHtml = state.editing
        ? '<textarea class="editor" id="editor">' + esc(item.content || '') + '</textarea>'
        : '<div class="prose">' + renderProse(item.content) + '</div>';
      return '<div class="detail"><div class="detail-main">' + detailHead(item) +
        '<h1 class="detail-title">' + esc(item.title) + '</h1>' +
        '<div class="meta-line">' + esc(TYPES[type].label) + ' · N°' + num(item) + ' · Edited ' + stamp(item.updated_at) + '</div>' +
        bodyHtml +
        (checklistOf(item) ? '' : '<div class="add-row" style="margin-top:20px"><span class="plus">+</span><input data-add-check placeholder="Turn this into a checklist"></div>') +
        '</div>' + renderSidebarMeta(item) + '</div>';
    }

    function renderDump(item) {
      var lines = String(item.content || '').split('\\n').filter(function (line) { return line.trim(); });
      var thoughts = lines.map(function (line) {
        var match = line.match(/^\\[(\\d{2}:\\d{2})\\]\\s*(.*)$/);
        return { time: match ? match[1] : '', text: match ? match[2] : line.trim() };
      });
      return '<div class="detail"><div class="detail-main" style="max-width:720px">' + detailHead(item,
        '<span class="sec-meta">' + thoughts.length + ' thoughts</span>') +
        '<h1 class="detail-title">' + esc(item.title) + '</h1>' +
        '<div class="dump-input"><span class="dot" style="background:#8a7cab;width:8px;height:8px"></span>' +
        '<input data-add-thought placeholder="Dump a thought…"><span class="kbd">↵ Enter</span></div>' +
        '<div class="group-name">Thoughts</div>' +
        (thoughts.length ? thoughts.map(function (thought) {
          return '<div class="thought"><span class="time">' + esc(thought.time) + '</span><p>' + esc(thought.text) + '</p></div>';
        }).join('') : '<div class="placeholder">Nothing dumped yet</div>') +
        '</div>' + renderSidebarMeta(item) + '</div>';
    }

    function renderChecklist(item) {
      var list = checklistOf(item) || [];
      var done = list.filter(function (entry) { return entry.done; }).length;
      var pct = list.length ? Math.round((done / list.length) * 100) : 0;
      return '<div class="detail"><div class="detail-main" style="max-width:700px">' + detailHead(item) +
        '<h1 class="detail-title">' + esc(item.title) + '</h1>' +
        '<div class="progress"><span class="label">' + done + ' / ' + list.length + ' done</span>' +
        '<div class="track"><div class="bar" style="width:' + pct + '%"></div></div></div>' +
        list.map(function (entry, index) {
          return '<button class="check-row" data-check="' + index + '">' +
            '<span class="box green' + (entry.done ? ' done' : '') + '">' + (entry.done ? '✓' : '') + '</span>' +
            '<span class="text' + (entry.done ? ' done' : '') + '">' + esc(entry.text) + '</span></button>';
        }).join('') +
        '<div class="add-row"><span class="plus">+</span><input data-add-check placeholder="Add item"></div>' +
        '</div>' + renderSidebarMeta(item) + '</div>';
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
      document.querySelectorAll('[data-untether]').forEach(function (element) {
        element.onclick = function () { untether(element.dataset.untether); };
      });
      document.querySelectorAll('.graph-space').forEach(function(el) {
        el.onclick = function() {
          var sp = el.dataset.space;
          if (!sp || sp === 'identity') { state.view = 'identity'; state.identityTab = 'core'; render(); return; }
          state.filterSpace = sp; state.view = 'home'; render();
        };
      });
      var back = document.getElementById('back');
      if (back) back.onclick = goHome;
      document.querySelectorAll('[data-act]').forEach(function (element) {
        element.onclick = function () { itemAction(element.dataset.act); };
      });
      document.querySelectorAll('[data-check]').forEach(function (element) {
        element.onclick = function () { toggleCheck(activeItem(), Number(element.dataset.check)); };
      });
      var addCheckInput = document.querySelector('[data-add-check]');
      if (addCheckInput) addCheckInput.onkeydown = function (event) {
        if (event.key !== 'Enter') return;
        addCheck(activeItem(), addCheckInput.value); addCheckInput.value = '';
      };
      var addThoughtInput = document.querySelector('[data-add-thought]');
      if (addThoughtInput) addThoughtInput.onkeydown = function (event) {
        if (event.key !== 'Enter') return;
        addThought(activeItem(), addThoughtInput.value); addThoughtInput.value = '';
      };
      bindCapture();
      bindUnlock();
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
