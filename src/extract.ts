// Extraction: turn a fetched source into proposed knowledge.
//
// Ported from boop's post-turn `extract.ts`, with the trigger moved. boop
// extracts after every chat turn; et al. extracts after a captured source is
// fetched, which is where its durable material actually arrives.
//
// The important divergence: boop writes memories directly. Nothing here writes.
// Every extracted insight is created as a PROPOSAL and stays invisible to
// search, context assembly and the knowledge shelf until a human accepts it.
// That is the invariant the whole system rests on — machine-written knowledge
// is reviewed, not assumed — and it is also what bounds volume, since the
// ceiling is what you accept rather than what a model produces.
import type { Env } from "./schema";
import * as store from "./store";

// A hard cap per source. Without one, a long article yields a dozen marginal
// facts and the review queue becomes the thing you avoid rather than the thing
// that protects you.
const MAX_PER_SOURCE = 3;

const SEGMENTS = ["identity", "correction", "relationship", "preference", "project", "knowledge", "context"] as const;
type Segment = (typeof SEGMENTS)[number];

// boop's per-segment defaults. Kept even though decay is not implemented yet:
// recording importance now means the memory lifecycle can be added later
// without re-reading every source.
const SEGMENT_IMPORTANCE: Record<Segment, number> = {
  identity: 0.85, correction: 0.80, relationship: 0.75,
  preference: 0.70, project: 0.65, knowledge: 0.60, context: 0.40,
};

const PROMPT = `You extract durable knowledge from something the user saved.

Return STRICT JSON only:
{"facts":[{"title":"short label","content":"one or two sentences","segment":"knowledge|project|preference|relationship|identity|context","importance":0.0-1.0}]}

Rules:
- Prefer fewer, higher-quality facts. Two good ones beat six thin ones.
- At most ${MAX_PER_SOURCE}.
- Extract what is worth remembering months from now, not a summary of the page.
- Skip anything transient, promotional, or navigational.
- "knowledge" for facts about the world; "project" for ongoing work; "preference" for how the user likes things; "context" for current situation.
- If nothing is durable, return {"facts":[]}. An empty answer is correct and expected.

Respond with ONLY the JSON object.`;

interface Fact { title?: string; content?: string; segment?: string; importance?: number }

/** Strip a fetched page down to prose.
 *
 *  A fetch returns raw HTML; script and style bodies in particular are pure
 *  noise that would dominate the model's window and push the actual article
 *  out of it. */
function readable(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Workers AI returns two different shapes depending on the model: the older
 *  `{response}` and an OpenAI-style `{choices:[{message:{content}}]}`. Reading
 *  only the first silently yielded nothing when the model was swapped. */
function textOf(out: unknown): string {
  const o = out as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
  if (typeof o?.response === "string") return o.response;
  const c = o?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

/** Models wrap JSON in prose or fences often enough that this is not optional. */
function parseFacts(raw: string): Fact[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { facts?: Fact[] };
    return Array.isArray(parsed.facts) ? parsed.facts : [];
  } catch {
    return [];
  }
}

/**
 * Propose insights from a source that has just been fetched.
 *
 * Best-effort throughout: extraction failing must never stop a capture from
 * being kept. A source with no proposals is a normal outcome, not an error.
 */
export async function extractFromSource(
  c: store.Ctx, env: Env, sourceId: string, fetchedText?: string,
): Promise<number> {
  if (!env.AI) return 0;

  const page = await store.getPage(c, sourceId);
  if (!page) return 0;
  // The fetched text is passed in rather than read back: ingest indexes the
  // fetch for search but deliberately does not store 100KB of markup as blocks,
  // so the page body is empty at this point.
  const raw = fetchedText ?? (await store.bodyText(c, sourceId));
  const body = readable(raw);
  // Below this there is nothing to extract from — a bare link whose fetch
  // returned a login wall, typically.
  if (body.length < 200) return 0;

  let facts: Fact[] = [];
  try {
    // Overridable by env: Workers AI deprecates models on a schedule, and the
    // previous choice here was retired on 2026-05-30 — which surfaced only as
    // silently empty extraction until the error was logged.
    const model = env.EXTRACT_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const out = (await env.AI.run(model as never, {
      messages: [
        { role: "system", content: PROMPT },
        // Truncated: the tail of a long article is rarely where the durable
        // material is, and the whole point is to stay cheap enough to run on
        // every capture.
        { role: "user", content: `TITLE: ${page.title}\n\n${body.slice(0, 6000)}` },
      ],
    } as never)) as unknown;
    facts = parseFacts(textOf(out));
  } catch (e) {
    // Logged rather than swallowed: a silent extraction failure is
    // indistinguishable from "nothing durable here", which is exactly how the
    // deprecated-model and response-shape bugs stayed hidden.
    console.log("[extract] failed", e instanceof Error ? e.message : String(e));
    return 0;
  }

  // The owning page is where the insight belongs — the source sits in that
  // page's Sources collection, so its knowledge belongs on the same page.
  const owner = await ownerPageOf(c, sourceId);
  if (!owner) return 0;
  const col = await store.ensureRoleCollection(c, owner, "insights");

  let created = 0;
  for (const f of facts.slice(0, MAX_PER_SOURCE)) {
    const content = String(f.content ?? "").trim();
    if (!content) continue;
    const segment = (SEGMENTS as readonly string[]).includes(String(f.segment)) ? (f.segment as Segment) : "knowledge";
    const importance = Number.isFinite(f.importance) && f.importance! >= 0 && f.importance! <= 1
      ? f.importance! : SEGMENT_IMPORTANCE[segment];

    const insight = await store.createPage(c, {
      collection_id: col.id,
      title: String(f.title ?? content).slice(0, 90),
      properties: {
        source_id: sourceId,
        is_ai: true,
        // The gate. Nothing reads a proposed insight until this clears.
        proposed: true,
        segment,
        importance,
      },
    });
    await store.writeBlocks(c, insight.id, [{ op: "replace_content", content }]);
    created++;
  }

  if (created) {
    await store.logEvent(c, "propose", "page", sourceId, { insights: created, from: page.title });
  }
  return created;
}

/** Which page owns the collection this source sits in. */
async function ownerPageOf(c: store.Ctx, sourceId: string): Promise<string | null> {
  const row = await store.first<{ parent_page_id: string | null }>(
    c,
    `SELECT col.parent_page_id FROM page p JOIN collection col ON p.collection_id = col.id WHERE p.id = ?`,
    sourceId,
  );
  return row?.parent_page_id ?? null;
}
