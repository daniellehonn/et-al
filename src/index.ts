// Worker entrypoint — v6.
//
// The Worker stays exactly where it was (Decision C); what changed underneath is
// that D1 is now canonical rather than a derived index of the R2 vault. Routes
// are thin: validation and business rules live in the store modules.

import { createMcpHandler } from "agents/mcp";
import { createEtAlMcpServer } from "./mcp.ts";
import { SCHEMA_INFO } from "./schema.ts";
import { RESOURCES, readFilters, getHome, getReview } from "./api.ts";
import { runJob, sweepJobs } from "./pipeline.ts";
import type { JobMessage } from "./store/jobs.ts";
import * as store from "./store/index.ts";
import { type Env, ValidationError, NotFoundError } from "./store/index.ts";

export type { Env };

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,x-api-key,authorization",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith("/mcp")) {
        assertMcpAuthorized(request, env);
        return createMcpHandler(createEtAlMcpServer(env))(request, env, ctx);
      }

      if (path === "/health") return json({ ok: true, service: "et-al", schema_version: SCHEMA_INFO.version });
      if (path === "/api/schema") return json(SCHEMA_INFO);

      // ---- session ----
      if (path === "/api/session") {
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
          return json({ authenticated: false }, 200, { "set-cookie": "et_al_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
        }
      }

      // Everything past here is user data.
      const userId = await store.ensureUser(env);

      // ---- bootstrap / maintenance ----
      if (path === "/api/bootstrap" && request.method === "POST") {
        await assertAuthorized(request, env);
        return json({ areas: await store.seedAreas(env, userId) });
      }
      if (path === "/api/reindex" && request.method === "POST") {
        await assertAuthorized(request, env);
        // v6: repairs the search index only. D1 is canonical — this is no longer
        // a disaster-recovery path (Markdown exports are, from Phase 6).
        return json(await store.rebuildSearchIndex(env, userId));
      }

      // ---- processing jobs ----
      if (path === "/api/jobs" && request.method === "GET") {
        return json({
          jobs: await store.listJobs(env, userId, {
            status: url.searchParams.get("status") ?? undefined,
            subject_id: url.searchParams.get("subject_id") ?? undefined,
          }),
        });
      }
      // Manual drain, for when the cron has not fired yet or a queue is absent.
      if (path === "/api/jobs/sweep" && request.method === "POST") {
        await assertAuthorized(request, env);
        return json(await sweepJobs(env));
      }
      const jobRetryMatch = path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
      if (jobRetryMatch && request.method === "POST") {
        await assertAuthorized(request, env);
        const job = await store.resetJob(env, userId, decodeURIComponent(jobRetryMatch[1]));
        return job ? json(job) : json({ error: "Job not found", code: 404 }, 404);
      }

      // ---- capture upload (image / audio / file) ----
      // Binary goes to R2; the capture row records the pointer. Kept separate
      // from POST /api/captures so the JSON path stays simple.
      if (path === "/api/captures/upload" && request.method === "POST") {
        await assertAuthorized(request, env);
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return json({ error: "Expected a 'file' field", code: 400 }, 400);
        const asset = await store.putAsset(env, userId, await file.arrayBuffer(), {
          filename: file.name, contentType: file.type, size: file.size,
        });
        const inputType = file.type.startsWith("image/") ? "image"
          : file.type.startsWith("audio/") ? "audio" : "file";
        return json(await store.createCapture(env, userId, {
          raw_input: String(form.get("note") ?? file.name),
          input_type: inputType,
          asset_id: asset.id,
        }), 201);
      }

      const captureRetryMatch = path.match(/^\/api\/captures\/([^/]+)\/retry$/);
      if (captureRetryMatch && request.method === "POST") {
        await assertAuthorized(request, env);
        return json(await store.resetForRetry(env, userId, decodeURIComponent(captureRetryMatch[1])));
      }

      // ---- asset download ----
      const assetMatch = path.match(/^\/api\/assets\/([^/]+)$/);
      if (assetMatch && request.method === "GET") {
        await assertAuthorized(request, env);
        const { asset, object } = await store.readAsset(env, userId, decodeURIComponent(assetMatch[1]));
        return new Response(object.body, {
          headers: {
            "content-type": asset.content_type ?? "application/octet-stream",
            "content-disposition": `inline; filename="${(asset.filename ?? "file").replace(/"/g, "")}"`,
            "access-control-allow-origin": "*",
          },
        });
      }

      // ---- read surfaces ----
      if (path === "/api/home" && request.method === "GET") return json(await getHome(env, userId));
      if (path === "/api/review" && request.method === "GET") return json(await getReview(env, userId));
      if (path === "/api/search" && request.method === "GET") {
        return json({
          results: await store.search(env, userId, url.searchParams.get("q") ?? "", {
            subject_type: url.searchParams.get("type"),
            limit: Number(url.searchParams.get("limit")) || undefined,
          }),
        });
      }
      if (path === "/api/unresolved" && request.method === "GET") {
        return json({ unresolved: await store.listUnresolved(env, userId) });
      }

      // ---- documents (the writing surface) ----
      const docMatch = path.match(/^\/api\/documents\/([^/]+)$/);
      if (docMatch) {
        const id = decodeURIComponent(docMatch[1]);
        if (request.method === "GET") {
          const doc = await store.getDocument(env, id);
          return doc ? json(doc) : json({ error: "Document not found", code: 404 }, 404);
        }
        if (request.method === "PUT") {
          await assertAuthorized(request, env);
          const body = (await readJson(request)) as { blocks?: unknown[]; subject_type?: string; subject_id?: string; title?: string };
          const doc = await store.getDocument(env, id);
          if (!doc) return json({ error: "Document not found", code: 404 }, 404);
          const blocks = Array.isArray(body.blocks) ? (body.blocks as store.BlockInput[]) : [];
          await store.saveBody(
            env, id, blocks,
            (body.subject_type as store.SubjectType) ?? doc.owner_type,
            body.subject_id ?? doc.owner_id ?? id,
            body.title ?? "",
          );
          return json(await store.getDocument(env, id));
        }
      }

      // ---- relations ----
      if (path === "/api/relations" && request.method === "POST") {
        await assertAuthorized(request, env);
        return json(await store.createRelation(env, userId, await readJson(request)), 201);
      }
      const relMatch = path.match(/^\/api\/relations\/([^/]+)$/);
      if (relMatch && request.method === "DELETE") {
        await assertAuthorized(request, env);
        const ok = await store.deleteRelation(env, userId, decodeURIComponent(relMatch[1]));
        return ok ? json({ ok: true }) : json({ error: "Relation not found", code: 404 }, 404);
      }

      // ---- generic entity CRUD ----
      // /api/{resource}                     GET list, POST create
      // /api/{resource}/{id}                GET, PATCH, DELETE
      // /api/{resource}/{id}/backlinks      GET
      // /api/{resource}/{id}/body           GET (creates the document on demand)
      const parts = path.replace(/^\/api\//, "").split("/");
      const resource = RESOURCES[parts[0]];
      if (resource && path.startsWith("/api/")) {
        const id = parts[1] ? decodeURIComponent(parts[1]) : null;
        const sub = parts[2];

        if (!id) {
          if (request.method === "GET") {
            return json({ [parts[0]]: await resource.list(env, userId, readFilters(url, resource.filters)) });
          }
          if (request.method === "POST") {
            await assertAuthorized(request, env);
            return json(await resource.create(env, userId, await readJson(request)), 201);
          }
        } else if (!sub) {
          if (request.method === "GET") {
            const found = await resource.get(env, userId, id);
            return found ? json(found) : json({ error: "Not found", code: 404 }, 404);
          }
          if (request.method === "PATCH") {
            await assertAuthorized(request, env);
            return json(await resource.update(env, userId, id, await readJson(request)));
          }
          if (request.method === "DELETE") {
            await assertAuthorized(request, env);
            const ok = await resource.remove(env, userId, id);
            if (ok && resource.subjectType) await store.purgeRelationsFor(env, userId, resource.subjectType, id);
            return ok ? json({ ok: true }) : json({ error: "Not found", code: 404 }, 404);
          }
        } else if (sub === "backlinks" && request.method === "GET" && resource.subjectType) {
          return json({ backlinks: await store.getBacklinks(env, userId, resource.subjectType, id) });
        } else if (sub === "relations" && request.method === "GET" && resource.subjectType) {
          return json({ relations: await store.getOutgoing(env, userId, resource.subjectType, id) });
        } else if (sub === "body" && request.method === "GET" && resource.setDocument && resource.subjectType) {
          // Lazily creates the body document the first time it is opened, so an
          // object never carries an empty document it may never use.
          const record = (await resource.get(env, userId, id)) as { body_document_id?: string | null } | null;
          if (!record) return json({ error: "Not found", code: 404 }, 404);
          const documentId = await store.ensureDocument(
            env, userId, record.body_document_id ?? null, resource.subjectType, id,
          );
          if (documentId !== record.body_document_id) await resource.setDocument(env, userId, id, documentId);
          return json(await store.getDocument(env, documentId));
        }
      }

      return json({ error: "Not found", code: 404 }, 404);
    } catch (error) {
      return json(...errorResponse(error));
    }
  },

  /**
   * Queue consumer. Messages are only triggers — the `processing_jobs` row is the
   * record of intent — so a message is acked once its outcome is written, whether
   * that outcome was success or a recorded failure. Retrying at the queue level
   * too would double up with the job's own attempt counter and the cron sweeper.
   */
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await runJob(env, message.body);
        message.ack();
      } catch {
        // runJob records failures itself; reaching here means something outside
        // it broke, so leave the message for redelivery.
        message.retry();
      }
    }
  },

  /**
   * Cron sweeper: the safety net that makes the pipeline durable without relying
   * on the queue. Picks up never-delivered messages, failed jobs with attempts
   * left, and jobs stranded in `running` by an evicted Worker.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepJobs(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env, JobMessage>;

function errorResponse(error: unknown): [unknown, number] {
  if (error instanceof ValidationError) return [{ error: error.message, code: 400 }, 400];
  if (error instanceof NotFoundError) return [{ error: error.message, code: 404 }, 404];
  const message = error instanceof Error ? error.message : "Unknown error";
  if (message === "Unauthorized") return [{ error: message, code: 401 }, 401];
  return [{ error: message, code: 500 }, 500];
}

// ---- auth (unchanged from v5) ----
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
  if (bearer !== expected && (request.headers.get("x-api-key") || "") !== expected) throw new Error("Unauthorized");
}
async function readJson(request: Request): Promise<any> {
  try { return await request.json(); } catch { throw new ValidationError("Invalid JSON body"); }
}
function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...jsonHeaders, ...extraHeaders } });
}
