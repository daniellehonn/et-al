import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TYPE_KEYS, SPACE_KEYS, STATUS_KEYS, UNSORTED } from "./markdown.ts";
import {
  SCHEMA_INFO, type Env,
  listPages, searchPages, getPage, getPageByPath, createPage, updatePage, deletePage,
  getBacklinks, getChildren, listUnresolved, reindex,
} from "./store.ts";

const SPACE_FILTERS = [...SPACE_KEYS, UNSORTED] as const;

function mcpJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createEtAlMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "et-al", version: "0.2.0" });

  server.registerTool("get_schema", {
    description: "Canonical et al. schema (v4): storage model, type/space/status enums, and link semantics ([[Title]] wikilinks; frontmatter parent = hierarchy; inline = lateral). Call before writing if unsure.",
    inputSchema: {},
  }, async () => mcpJson(SCHEMA_INFO));

  server.registerTool("list_pages", {
    description: "List vault pages filtered by type, space, status, or parent (normalized title). space 'unsorted' = pages not yet filed.",
    inputSchema: {
      type: z.enum(TYPE_KEYS).optional(),
      space: z.enum(SPACE_FILTERS).optional(),
      status: z.enum(STATUS_KEYS).optional(),
      parent: z.string().optional().describe("Filter to children of this page title"),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, async (input) => mcpJson({ pages: await listPages(env, input) }));

  server.registerTool("get_page", {
    description: "Get one page by id (or by path) including its markdown body, frontmatter, and links.",
    inputSchema: { id: z.string().optional(), path: z.string().optional() },
  }, async ({ id, path }) => {
    const page = path ? await getPageByPath(env, path) : id ? await getPage(env, id) : null;
    return mcpJson(page ?? { error: "Page not found", code: 404 });
  });

  server.registerTool("create_page", {
    description: "Create a markdown page in the vault. Body is markdown and may contain [[Title]] wikilinks. Omit space for the Unsorted bucket. parent must be an existing page title (hierarchy); use inline [[links]] for lateral association.",
    inputSchema: {
      title: z.string().min(1),
      type: z.enum(TYPE_KEYS).default("idea"),
      space: z.enum(SPACE_KEYS).optional().describe("Omit for unsorted"),
      status: z.enum(STATUS_KEYS).optional(),
      tags: z.array(z.string()).optional(),
      parent: z.string().optional().describe("Existing page title this traces to (hierarchy)"),
      due: z.union([z.number(), z.string()]).optional(),
      body: z.string().optional().describe("Markdown body; [[Title]] links become backlinks"),
    },
  }, async (input) => mcpJson(await createPage(env, input)));

  server.registerTool("update_page", {
    description: "Update a page by id. Renaming rewrites [[old title]] in every page that links here. Invalid enums/parent error instead of silently coercing.",
    inputSchema: {
      id: z.string().min(1),
      title: z.string().min(1).optional(),
      type: z.enum(TYPE_KEYS).optional(),
      space: z.enum(SPACE_KEYS).nullable().optional().describe("null moves to unsorted"),
      status: z.enum(STATUS_KEYS).optional(),
      tags: z.array(z.string()).optional(),
      parent: z.string().nullable().optional(),
      due: z.union([z.number(), z.string()]).nullable().optional(),
      body: z.string().optional(),
    },
  }, async ({ id, ...updates }) => {
    const page = await updatePage(env, id, updates);
    return mcpJson(page ?? { error: "Page not found", code: 404 });
  });

  server.registerTool("delete_page", {
    description: "Delete a page. Pages that linked to it become unresolved links (click-to-create), not dangling references.",
    inputSchema: { id: z.string().min(1) },
  }, async ({ id }) => mcpJson({ ok: await deletePage(env, id) }));

  server.registerTool("search_pages", {
    description: "Full-text search across page titles and bodies. Optional type/space/status filters.",
    inputSchema: {
      query: z.string().min(1),
      type: z.enum(TYPE_KEYS).optional(),
      space: z.enum(SPACE_FILTERS).optional(),
      status: z.enum(STATUS_KEYS).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, async ({ query, ...filters }) => mcpJson({ pages: await searchPages(env, query, filters) }));

  server.registerTool("get_backlinks", {
    description: "Every page that links to this one, with the surrounding line as context and whether the link is a parent (hierarchy) or inline (lateral) reference.",
    inputSchema: { id: z.string().min(1) },
  }, async ({ id }) => mcpJson({ backlinks: await getBacklinks(env, id) }));

  server.registerTool("get_children", {
    description: "Pages whose frontmatter parent link resolves to this page (the hierarchy beneath it).",
    inputSchema: {
      id: z.string().min(1),
      type: z.enum(TYPE_KEYS).optional(),
      status: z.enum(STATUS_KEYS).optional(),
    },
  }, async ({ id, ...filters }) => mcpJson({ children: await getChildren(env, id, filters) }));

  server.registerTool("list_unresolved_links", {
    description: "Titles referenced by [[wikilinks]] that have no page yet — the vault's growth edges. Each can be turned into a page.",
    inputSchema: {},
  }, async () => mcpJson({ unresolved: await listUnresolved(env) }));

  server.registerTool("reindex_vault", {
    description: "Rebuild the entire D1 index by re-reading every markdown file in the R2 vault. The bucket is the source of truth; run this if the index and files ever disagree.",
    inputSchema: {},
  }, async () => mcpJson(await reindex(env)));

  return server;
}
