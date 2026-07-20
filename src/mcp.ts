import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TYPE_KEYS, STATUS_KEYS } from "./markdown.ts";
import {
  SCHEMA_INFO, type Env,
  listPages, searchPages, getPage, getPageByPath, createPage, updatePage, deletePage,
  getBacklinks, getChildren, listUnresolved, reindex,
  listSpaces, getSpace, createSpace, updateSpace, deleteSpace,
} from "./store.ts";

function mcpJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createEtAlMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "et-al", version: "0.3.0" });

  server.registerTool("get_schema", {
    description: "Canonical et al. schema (v5): storage model, type/status enums, and the three structures — folder (area, the space path), parent (goal breakdown), [[wikilink]] (lateral). Spaces are folders, not an enum. Call before writing if unsure.",
    inputSchema: {},
  }, async () => mcpJson(SCHEMA_INFO));

  // ---- spaces (folders) ----
  server.registerTool("list_spaces", {
    description: "The full space (folder) tree with page counts. Spaces nest arbitrarily; a space's path is its identity (e.g. 'career/internships').",
    inputSchema: {},
  }, async () => mcpJson({ spaces: await listSpaces(env) }));

  server.registerTool("get_space", {
    description: "Get one space's metadata and overview note (from its _space.md) by path.",
    inputSchema: { path: z.string().min(1) },
  }, async ({ path }) => mcpJson((await getSpace(env, path)) ?? { error: "Space not found", code: 404 }));

  server.registerTool("create_space", {
    description: "Create a space (folder) or subspace. Give either a full `path`, or a `parent_path` + `name`. Writes a _space.md with metadata + optional overview note.",
    inputSchema: {
      path: z.string().optional(),
      parent_path: z.string().optional().describe("Parent folder for a subspace; omit for a top-level space"),
      name: z.string().optional(),
      color: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      sort: z.number().int().nullable().optional(),
      overview: z.string().optional().describe("Markdown overview note for the space"),
    },
  }, async (input) => mcpJson(await createSpace(env, input)));

  server.registerTool("update_space", {
    description: "Update a space's metadata or overview note by path.",
    inputSchema: {
      path: z.string().min(1),
      name: z.string().optional(),
      color: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      sort: z.number().int().nullable().optional(),
      overview: z.string().optional(),
    },
  }, async ({ path, ...rest }) => mcpJson(await updateSpace(env, path, rest)));

  server.registerTool("delete_space", {
    description: "Delete an empty space. Refuses if it still contains pages or subspaces.",
    inputSchema: { path: z.string().min(1) },
  }, async ({ path }) => mcpJson(await deleteSpace(env, path)));

  // ---- pages ----
  server.registerTool("list_pages", {
    description: "List pages, optionally within a space (folder). Pass recursive=true to include subspaces. Filter by type/status/parent-goal.",
    inputSchema: {
      space_path: z.string().optional().describe("Folder to list; '' or omit for the whole vault"),
      recursive: z.boolean().optional().describe("Include subspaces of space_path"),
      type: z.enum(TYPE_KEYS).optional(),
      status: z.enum(STATUS_KEYS).optional(),
      parent: z.string().optional().describe("Only children of this parent-goal title"),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, async ({ space_path, ...rest }) => mcpJson({ pages: await listPages(env, { space: space_path ?? null, ...rest }) }));

  server.registerTool("get_page", {
    description: "Get one page by id (or path) including its markdown body and links.",
    inputSchema: { id: z.string().optional(), path: z.string().optional() },
  }, async ({ id, path }) => {
    const page = path ? await getPageByPath(env, path) : id ? await getPage(env, id) : null;
    return mcpJson(page ?? { error: "Page not found", code: 404 });
  });

  server.registerTool("create_page", {
    description: "Create a markdown page inside a space folder (space_path, e.g. 'career/internships'). Body is markdown with [[Title]] wikilinks. `parent` is a goal title this page breaks down (must exist). Omit space_path to place at the vault root.",
    inputSchema: {
      title: z.string().min(1),
      type: z.enum(TYPE_KEYS).default("idea"),
      space_path: z.string().optional().describe("Destination folder; auto-created if missing"),
      status: z.enum(STATUS_KEYS).optional(),
      tags: z.array(z.string()).optional(),
      parent: z.string().optional().describe("Existing goal title this page is a subtask/note of"),
      due: z.union([z.number(), z.string()]).optional(),
      body: z.string().optional(),
    },
  }, async (input) => mcpJson(await createPage(env, input)));

  server.registerTool("update_page", {
    description: "Update a page by id. Changing space_path moves it between folders; renaming rewrites [[old title]] everywhere it's linked. Invalid enums/parent error instead of silently coercing.",
    inputSchema: {
      id: z.string().min(1),
      title: z.string().min(1).optional(),
      type: z.enum(TYPE_KEYS).optional(),
      space_path: z.string().nullable().optional().describe("Move to this folder; '' = vault root"),
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
    description: "Full-text search across page titles and bodies. Optional space_path (+recursive), type, status filters.",
    inputSchema: {
      query: z.string().min(1),
      space_path: z.string().optional(),
      recursive: z.boolean().optional(),
      type: z.enum(TYPE_KEYS).optional(),
      status: z.enum(STATUS_KEYS).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, async ({ query, space_path, ...rest }) => mcpJson({ pages: await searchPages(env, query, { space: space_path ?? null, ...rest }) }));

  server.registerTool("get_backlinks", {
    description: "Every page linking to this one, with context and whether it's a parent (goal breakdown) or inline (lateral) link.",
    inputSchema: { id: z.string().min(1) },
  }, async ({ id }) => mcpJson({ backlinks: await getBacklinks(env, id) }));

  server.registerTool("get_children", {
    description: "Pages whose `parent` goal-link resolves to this page — the subtasks/notes/pages that break this goal down.",
    inputSchema: { id: z.string().min(1), type: z.enum(TYPE_KEYS).optional(), status: z.enum(STATUS_KEYS).optional() },
  }, async ({ id, ...filters }) => mcpJson({ children: await getChildren(env, id, filters) }));

  server.registerTool("list_unresolved_links", {
    description: "Titles referenced by [[wikilinks]] with no page yet — the vault's growth edges.",
    inputSchema: {},
  }, async () => mcpJson({ unresolved: await listUnresolved(env) }));

  server.registerTool("reindex_vault", {
    description: "Rebuild the entire D1 index by re-reading every markdown file in the R2 vault. The bucket is the source of truth; run if the index and files disagree.",
    inputSchema: {},
  }, async () => mcpJson(await reindex(env)));

  return server;
}
