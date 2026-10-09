// Background work, run off the request path by the queue consumer.
//
// Ingest fetches a captured link once and uses that one response twice: its
// <head> gives the source a face (title, site, description, image) and its text
// is indexed and handed to the extractor. Everything here is best-effort: a
// link that will not fetch is still a perfectly good capture, so failure is
// recorded on the source rather than thrown.
import type { Env } from "./schema";
import * as store from "./store";
import { extractFromSource } from "./extract";

const USER_AGENT = "Mozilla/5.0 (compatible; et-al/1.0; +https://et-al.daniellehonnn.workers.dev)";
const MAX_BYTES = 100_000;

export async function ingestSource(c: store.Ctx, env: Env, sourceId: string): Promise<void> {
  const src = await store.getSource(c, sourceId);
  if (!src?.url) return;
  const fail = (error: string) =>
    c.db.prepare(`UPDATE source SET fetch_status = 'failed', fetch_error = ?, updated_at = ? WHERE id = ?`).bind(error, Date.now(), sourceId).run();

  let target: URL;
  try { target = new URL(src.url); } catch { await fail("not a valid URL"); return; }
  if (target.protocol !== "http:" && target.protocol !== "https:") { await fail("only http(s) links are fetched"); return; }
  const site = target.hostname.replace(/^www\./, "");

  let html: string;
  try {
    // A bare fetch sends no User-Agent, and many sites — Wikipedia among them —
    // answer that with a short error page instead of the content.
    const res = await fetch(target.toString(), {
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) { await fail(`the site answered ${res.status}`); return; }
    html = (await res.text()).slice(0, MAX_BYTES);
  } catch (e) {
    await fail(e instanceof Error && e.name === "TimeoutError" ? "timed out" : "could not reach the site");
    return;
  }

  const meta = await readMeta(html, target);
  // Only take the fetched title if nobody wrote one: a bare pasted link is
  // titled with its URL, which counts as unwritten.
  const title = src.title && src.title !== src.url ? src.title : (usefulTitle(meta.title, site) ?? src.title);
  await c.db
    .prepare(`UPDATE source SET title = ?, site = ?, description = ?, image = ?, fetch_status = 'fetched', fetch_error = NULL, updated_at = ? WHERE id = ?`)
    .bind(title, meta.site ?? site, meta.description ?? null, meta.image ?? null, Date.now(), sourceId)
    .run();
  const text = readable(html);
  await store.reindexSource(c, sourceId, text);

  // Propose knowledge from what was just fetched. Last, and isolated: a failure
  // here must not undo a capture that already succeeded.
  try { await extractFromSource(c, env, sourceId, text); }
  catch (e) { console.log("[extract] threw", e instanceof Error ? e.message : String(e)); }
}

/** Index a note by meaning, so search can find it phrased differently. */
export async function embedNote(c: store.Ctx, env: Env, noteId: string): Promise<void> {
  if (!env.AI || !env.VECTORIZE) return;
  const note = await store.getNote(c, noteId);
  if (!note || note.trashed_at) return;
  const out = (await env.AI.run(store.EMBEDDING_MODEL as never, { text: [`${note.title}\n\n${await store.noteText(c, noteId)}`] } as never)) as unknown as { data: number[][] };
  const vector = out?.data?.[0];
  if (vector) await env.VECTORIZE.upsert([{ id: noteId, values: vector }]);
}

/** Strip fetched HTML down to prose. Script and style bodies in particular are
 *  pure noise that would dominate the index and the extractor's window. */
export function readable(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Reject a fetched title that only names the platform. Login-walled feeds serve
// a JS shell to any anonymous fetch — Instagram returns <title>Instagram</title>
// on every reel — so taking it would label every saved item identically and lose
// the URL, which at least identifies the thing. Better to keep the link and let
// the human name it.
function usefulTitle(title: string | undefined, site: string): string | undefined {
  if (!title) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const t = norm(title);
  // The site as given ("Instagram") and its bare hostname token ("instagram").
  return t && t !== norm(site) && t !== norm(site.split(".")[0]) ? title : undefined;
}

// Read OpenGraph/meta tags out of fetched HTML with HTMLRewriter.
async function readMeta(html: string, target: URL): Promise<{ title?: string; description?: string; image?: string; site?: string }> {
  const out: { title?: string; description?: string; image?: string; site?: string } = {};
  try {

    // og:* wins over twitter:* wins over the bare tags, so only fill a blank.
    const set = (k: keyof typeof out, v: string | null, force = false) => {
      const t = v?.trim().replace(/\s+/g, " ").slice(0, 400);
      if (t && (force || !out[k])) out[k] = t;
    };

    // <title> arrives in arbitrary text chunks, so accumulate separately and
    // only commit once the element closes — set() refuses to overwrite.
    let titleBuf = "";
    await new HTMLRewriter()
      .on("meta", {
        element(el) {
          const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? "").toLowerCase();
          const content = el.getAttribute("content");
          // force=true for og:*: it outranks a <title> we may already have taken.
          if (key === "og:title" || key === "twitter:title") set("title", content, key === "og:title");
          else if (key === "og:description" || key === "twitter:description" || key === "description") set("description", content, key === "og:description");
          else if (key === "og:image" || key === "twitter:image") set("image", content);
          else if (key === "og:site_name") set("site", content, true);
        },
      })
      .on("title", {
        text(t) {
          titleBuf += t.text;
          if (t.lastInTextNode) { set("title", titleBuf); titleBuf = ""; }
        },
      })
      .transform(new Response(html, { headers: { "content-type": "text/html" } }))
      .arrayBuffer();
  } catch { /* malformed markup — the capture survives regardless */ }

  // Resolve a relative og:image against the page it came from.
  if (out.image) { try { out.image = new URL(out.image, target).toString(); } catch { delete out.image; } }
  return out;
}

