// Assets — binary payloads in R2.
//
// R2's new role in v6: it holds bytes (uploads, and later Markdown exports), and
// D1 holds the record describing them. The `assets` row is canonical; the object
// is the payload it points at.

import { desc, eq, and } from "drizzle-orm";
import { assets } from "../schema.ts";
import { type Env, getDb, now, newId, NotFoundError } from "./db.ts";

export interface AssetDoc {
  id: string;
  r2_key: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  created_at: number;
}

function view(row: typeof assets.$inferSelect): AssetDoc {
  return {
    id: row.id, r2_key: row.r2Key, filename: row.filename,
    content_type: row.contentType, size_bytes: row.sizeBytes, created_at: row.createdAt,
  };
}

/** Keeps the original filename readable in the key without letting it escape the prefix. */
function safeName(filename: string | null): string {
  const base = (filename ?? "file").split(/[/\\]/).pop() ?? "file";
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
}

export async function putAsset(
  env: Env, userId: string,
  body: ArrayBuffer | ReadableStream, meta: { filename?: string | null; contentType?: string | null; size?: number | null },
): Promise<AssetDoc> {
  const id = newId();
  const key = `assets/${id}/${safeName(meta.filename ?? null)}`;
  await env.VAULT.put(key, body, {
    httpMetadata: meta.contentType ? { contentType: meta.contentType } : undefined,
  });
  const row = {
    id, userId, r2Key: key,
    filename: meta.filename ?? null,
    contentType: meta.contentType ?? null,
    sizeBytes: meta.size ?? null,
    createdAt: now(),
  };
  await getDb(env).insert(assets).values(row);
  return view(row as typeof assets.$inferSelect);
}

export async function getAsset(env: Env, userId: string, id: string): Promise<AssetDoc | null> {
  const rows = await getDb(env).select().from(assets)
    .where(and(eq(assets.id, id), eq(assets.userId, userId))).limit(1);
  return rows[0] ? view(rows[0]) : null;
}

/** Streams the payload back. Ownership is checked before R2 is touched. */
export async function readAsset(env: Env, userId: string, id: string): Promise<{ asset: AssetDoc; object: R2ObjectBody }> {
  const asset = await getAsset(env, userId, id);
  if (!asset) throw new NotFoundError(`Asset not found: ${id}`);
  const object = await env.VAULT.get(asset.r2_key);
  if (!object) throw new NotFoundError(`Asset payload missing: ${asset.r2_key}`);
  return { asset, object };
}

export async function listAssets(env: Env, userId: string, limit = 100): Promise<AssetDoc[]> {
  const rows = await getDb(env).select().from(assets)
    .where(eq(assets.userId, userId)).orderBy(desc(assets.createdAt)).limit(limit);
  return rows.map(view);
}

/** Deletes the record and its payload; spec §6.8 requires real deletion. */
export async function deleteAsset(env: Env, userId: string, id: string): Promise<boolean> {
  const asset = await getAsset(env, userId, id);
  if (!asset) return false;
  await env.VAULT.delete(asset.r2_key);
  await getDb(env).delete(assets).where(and(eq(assets.id, id), eq(assets.userId, userId)));
  return true;
}
