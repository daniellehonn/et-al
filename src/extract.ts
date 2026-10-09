// Extraction: turn a fetched source into proposed knowledge.
//
// Ported from boop's post-turn `extract.ts`, with the trigger moved. boop
// extracts after every chat turn; et al. extracts after a captured source is
// fetched, which is where its durable material actually arrives.
//
// The important divergence: boop writes memories directly. Nothing here writes.
// Every extracted insight is created as a PROPOSAL and stays invisible to
// search, context assembly and the note tree until a human accepts it.
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
 * `text` is the fetched page, already reduced to prose.
 */
export async function extractFromSource(c: store.Ctx, env: Env, sourceId: string, text: string): Promise<number> {
  if (!env.AI) return 0;
  const source = await store.getSource(c, sourceId);
  if (!source) return 0;
  // Below this there is nothing to extract from — typically a login wall.
  if (text.length < 200) return 0;

  let facts: Fact[] = [];
  try {
    // Overridable by env: Workers AI retires models on a schedule, and a retired
    // model surfaces only as silently empty extraction.
    const model = env.EXTRACT_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const out = (await env.AI.run(model as never, {
      messages: [
        { role: "system", content: PROMPT },
        // Truncated: the tail of a long article is rarely where the durable
        // material is, and this has to stay cheap enough to run on every capture.
        { role: "user", content: `TITLE: ${source.title}\n\n${text.slice(0, 6000)}` },
      ],
    } as never)) as unknown;
    facts = parseFacts(textOf(out));
  } catch (e) {
    // Logged rather than swallowed: a silent failure is indistinguishable from
    // "nothing durable here", which is how past model retirements stayed hidden.
    console.log("[extract] failed", e instanceof Error ? e.message : String(e));
    return 0;
  }

  let created = 0;
  for (const f of facts.slice(0, MAX_PER_SOURCE)) {
    const content = String(f.content ?? "").trim();
    if (!content) continue;
    const segment = (SEGMENTS as readonly string[]).includes(String(f.segment)) ? (f.segment as Segment) : "knowledge";
    const importance = Number.isFinite(f.importance) && f.importance! >= 0 && f.importance! <= 1
      ? f.importance! : SEGMENT_IMPORTANCE[segment];
    // A proposal, not a note: invisible to search, context and the tree until
    // a human accepts it.
    await store.proposeInsight(c, sourceId, { title: String(f.title ?? content).slice(0, 90), content, segment, importance });
    created++;
  }
  return created;
}
