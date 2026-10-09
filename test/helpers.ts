// Black-box helpers: tests talk to the Worker over HTTP, the way the web app and
// agents do, so they keep passing when the store underneath is rewritten.
import { SELF, env } from "cloudflare:test";

export const KEY = "test-key";
const BASE = "https://et-al.test";

type Auth = "key" | "bearer" | "cookie" | "wrong" | "none";

function authHeaders(auth: Auth): Record<string, string> {
  switch (auth) {
    case "key": return { "x-api-key": KEY };
    case "bearer": return { Authorization: `Bearer ${KEY}` };
    case "cookie": return { Cookie: `et_al_session=${KEY}` };
    case "wrong": return { "x-api-key": "not-the-key" };
    case "none": return {};
  }
}

/** A raw request to the Worker. */
export function request(path: string, init: RequestInit & { auth?: Auth } = {}): Promise<Response> {
  const { auth = "key", headers, ...rest } = init;
  return SELF.fetch(`${BASE}${path}`, {
    ...rest,
    headers: { "content-type": "application/json", ...authHeaders(auth), ...(headers as Record<string, string>) },
  });
}

/** A REST call as the signed-in human; throws on a non-2xx so failures are loud. */
export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await request(`/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} /api${path} → ${res.status} ${await res.text()}`);
  return res.json<T>();
}

/** One JSON-RPC call to /mcp. */
export async function rpc(method: string, params: unknown = {}, client?: string) {
  const res = await request("/mcp", {
    method: "POST",
    auth: "bearer",
    headers: client ? { "x-mcp-client": client } : {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json<{ result?: any; error?: { code: number; message: string } }>();
}

/** Call an MCP tool as an agent and return its decoded result; throws on a tool error. */
export async function tool<T = any>(name: string, args: Record<string, unknown> = {}, client?: string): Promise<T> {
  const out = await rpc("tools/call", { name, arguments: args }, client);
  if (out.error) throw new Error(`${name}: ${out.error.message}`);
  return JSON.parse(out.result.content[0].text) as T;
}

/** A page's body as plain text, in document order. */
export async function bodyText(pageId: string): Promise<string> {
  const blocks = await api<Array<{ content_json: string }>>(`/pages/${pageId}/blocks`);
  return blocks.map((b) => JSON.parse(b.content_json).text ?? "").join("\n");
}

/** Who wrote the events for an entity, oldest first. Read straight from D1:
 *  the event log is the audit trail, so the test checks what was persisted. */
export async function eventActors(entityId: string): Promise<Array<{ actor: string; action: string }>> {
  const { results } = await env.DB
    .prepare(`SELECT actor, action FROM event WHERE entity_id = ? ORDER BY created_at, rowid`)
    .bind(entityId)
    .all<{ actor: string; action: string }>();
  return results;
}

/** A unique word, so tests sharing one database never match each other's rows. */
export const unique = (prefix = "w") => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
