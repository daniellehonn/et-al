import { createMcpHandler } from "agents/mcp";
import { createEtAlMcpServer } from "./mcp.ts";
import { renderApp } from "./ui.ts";
import {
  SCHEMA_INFO, type Env,
  listPages, searchPages, getPage, getPageByPath, createPage, updatePage, deletePage,
  getBacklinks, getChildren, listUnresolved, reindex, migrateFromLegacyD1,
} from "./store.ts";

export type { Env };

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,x-api-key,authorization",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/mcp")) {
        assertMcpAuthorized(request, env);
        return createMcpHandler(createEtAlMcpServer(env))(request, env, ctx);
      }

      if (url.pathname === "/") return htmlResponse(renderApp(env.APP_NAME ?? "et al.", SCHEMA_INFO));
      if (url.pathname === "/health") return json({ ok: true, service: "et-al", schema_version: SCHEMA_INFO.version });
      if (url.pathname === "/api/schema") return json(SCHEMA_INFO);

      if (url.pathname === "/api/session") {
        if (request.method === "GET") return json({ authenticated: await isAuthorized(request, env) });
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

      // ---- Pages (source of truth: R2 vault; served via the index) ----
      if (url.pathname === "/api/pages" && request.method === "GET") {
        return json({ pages: await listPages(env, readListOptions(url)) });
      }
      if (url.pathname === "/api/pages" && request.method === "POST") {
        await assertAuthorized(request, env);
        return json(await createPage(env, await readJson(request)), 201);
      }
      if (url.pathname === "/api/search" && request.method === "GET") {
        const query = url.searchParams.get("q")?.trim() ?? "";
        return json({ pages: await searchPages(env, query, readListOptions(url)) });
      }
      if (url.pathname === "/api/unresolved" && request.method === "GET") {
        return json({ unresolved: await listUnresolved(env) });
      }
      if (url.pathname === "/api/identity/graph" && request.method === "GET") {
        return json(await getIdentityGraph(env));
      }

      if (url.pathname === "/api/reindex" && request.method === "POST") {
        await assertAuthorized(request, env);
        return json(await reindex(env));
      }
      if (url.pathname === "/api/migrate-from-d1" && request.method === "POST") {
        await assertAuthorized(request, env);
        return json(await migrateFromLegacyD1(env));
      }

      const childrenMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/children$/);
      if (childrenMatch && request.method === "GET") {
        return json({ children: await getChildren(env, decodeURIComponent(childrenMatch[1]), readListOptions(url)) });
      }
      const backlinksMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/backlinks$/);
      if (backlinksMatch && request.method === "GET") {
        return json({ backlinks: await getBacklinks(env, decodeURIComponent(backlinksMatch[1])) });
      }
      const pageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
      if (pageMatch) {
        const id = decodeURIComponent(pageMatch[1]);
        if (request.method === "GET") {
          const page = await getPage(env, id);
          return page ? json(page) : json({ error: "Page not found", code: 404 }, 404);
        }
        if (request.method === "PATCH") {
          await assertAuthorized(request, env);
          const page = await updatePage(env, id, await readJson(request));
          return page ? json(page) : json({ error: "Page not found", code: 404 }, 404);
        }
        if (request.method === "DELETE") {
          await assertAuthorized(request, env);
          const ok = await deletePage(env, id);
          return ok ? json({ ok: true }) : json({ error: "Page not found", code: 404 }, 404);
        }
      }

      return json({ error: "Not found", code: 404 }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = message === "Unauthorized" ? 401 : message.startsWith("Invalid") ? 400 : 500;
      return json({ error: message, code: status }, status);
    }
  },
} satisfies ExportedHandler<Env>;

// Identity graph for the Cascade/Constellation views — derived from the index.
// A page traces to identity via its parent link OR any inline link to an
// identity page. Every lens reads this one payload, so they cannot disagree.
async function getIdentityGraph(env: Env) {
  const identity = await listPages(env, { space: "identity", limit: 200 });
  const identityIds = new Set(identity.map((p) => p.id));

  const links: Record<string, Array<Record<string, unknown>>> = {};
  const traced = new Set<string>();
  for (const anchor of identity) {
    const backlinks = await getBacklinks(env, anchor.id);
    for (const bl of backlinks) {
      if (bl.space === "identity") continue; // identity-to-identity isn't a spoke
      (links[anchor.id] ??= []).push({ ...bl, via: bl.kind === "parent" ? "parent" : "related" });
      traced.add(bl.id);
    }
  }

  // Space goals with no trace to identity — the orphan callout.
  const goals = await listPages(env, { type: "goal", status: "active", limit: 200 });
  const orphanGoals = goals.filter((g) => g.space !== "identity" && !traced.has(g.id) && !identityIds.has(g.id));

  return { schema_version: SCHEMA_INFO.version, identity, links, orphanGoals };
}

function readListOptions(url: URL) {
  return {
    type: url.searchParams.get("type"),
    space: url.searchParams.get("space"),
    status: url.searchParams.get("status"),
    parent: url.searchParams.get("parent"),
    limit: toInt(url.searchParams.get("limit")),
    offset: toInt(url.searchParams.get("offset")),
  };
}
function toInt(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// ---- auth (unchanged from v3) ----
function apiKeyOf(env: Env): string { return env.ET_AL_API_KEY || env.SECOND_BRAIN_API_KEY || "dev-key"; }
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
  if (readCookie(request, "et_al_session") === (await sessionToken(env))) return;
  throw new Error("Unauthorized");
}
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  try { await assertAuthorized(request, env); return true; } catch { return false; }
}
function assertMcpAuthorized(request: Request, env: Env) {
  const expected = apiKeyOf(env);
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const apiKey = request.headers.get("x-api-key") || "";
  if (bearer !== expected && apiKey !== expected) throw new Error("Unauthorized");
}

async function readJson(request: Request): Promise<any> {
  try { return await request.json(); } catch { throw new Error("Invalid JSON body"); }
}
function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...jsonHeaders, ...extraHeaders } });
}
function htmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" } });
}
