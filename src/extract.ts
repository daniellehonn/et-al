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
import type { Env, InsightPayload } from "./schema";
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

const FACTS_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      maxItems: MAX_PER_SOURCE,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          segment: { type: "string", enum: ["knowledge", "project", "preference", "relationship", "identity", "context"] },
          importance: { type: "number" },
        },
        required: ["title", "content", "segment", "importance"],
      },
    },
  },
  required: ["facts"],
};

interface Fact { title?: string; content?: string; segment?: string; importance?: number }

/** Workers AI returns two different shapes depending on the model: the older
 *  `{response}` and an OpenAI-style `{choices:[{message:{content}}]}`. Reading
 *  only the first silently yielded nothing when the model was swapped. */
function textOf(out: unknown): string {
  const o = out as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
  // In JSON mode the reply can arrive already parsed.
  if (o?.response && typeof o.response === "object") return JSON.stringify(o.response);
  if (typeof o?.response === "string") return o.response;
  const c = o?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : c && typeof c === "object" ? JSON.stringify(c) : "";
}

/** Models wrap JSON in prose or fences often enough that this is not optional.
 *  Returns null when there is no parsable answer at all, as distinct from a
 *  parsed answer with no facts in it. */
function parseFacts(raw: string): Fact[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { facts?: Fact[] };
    return Array.isArray(parsed.facts) ? parsed.facts : null;
  } catch {
    return null;
  }
}

/** How an extraction went. "none" is a real answer — the model looked and found
 *  nothing durable. "unparsable" and "error" are failures that would otherwise
 *  look exactly like "none", which is why they are told apart. */
export type ExtractOutcome = "facts" | "none" | "unparsable" | "error" | "skipped";

/**
 * Ask the model for the durable facts in a piece of text, normalised and capped,
 * and say how it went. Never throws: an extraction failing must never stop a
 * capture from being kept. The eval scores this function, so it measures
 * exactly what runs on capture.
 */
export async function extractFactsDetailed(env: Env, title: string, text: string): Promise<{ facts: InsightPayload[]; outcome: ExtractOutcome; raw?: string }> {
  // Below this there is nothing to extract from — typically a login wall.
  if (!env.AI || text.length < 200) return { facts: [], outcome: "skipped" };
  let raw: string;
  try {
    // Overridable by env: Workers AI retires models on a schedule, and a retired
    // model surfaces only as silently empty extraction.
    const model = env.EXTRACT_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const out = (await env.AI.run(model as never, {
      // Room for three facts in JSON. Workers AI's default output budget is
      // small enough to cut a full answer off mid-object.
      max_tokens: 1024,
      // Constrained decoding. Asked politely for JSON, the model got it wrong
      // on about a third of real articles — a stray brace, an unescaped quote
      // copied from the page — and every fact in that reply was lost. The eval
      // found it; a schema makes the reply valid by construction.
      response_format: { type: "json_schema", json_schema: FACTS_SCHEMA },
      messages: [
        { role: "system", content: PROMPT },
        // Truncated: the tail of a long article is rarely where the durable
        // material is, and this has to stay cheap enough to run on every capture.
        { role: "user", content: `TITLE: ${title}\n\n${text.slice(0, 6000)}` },
      ],
    } as never)) as unknown;
    raw = textOf(out);
  } catch (e) {
    // Logged rather than swallowed: a silent failure is indistinguishable from
    // "nothing durable here", which is how past model retirements stayed hidden.
    console.log("[extract] failed", e instanceof Error ? e.message : String(e));
    return { facts: [], outcome: "error", raw: e instanceof Error ? e.message : String(e) };
  }
  const parsed = parseFacts(raw);
  if (parsed === null) {
    console.log("[extract] unparsable reply", raw.slice(0, 200));
    return { facts: [], outcome: "unparsable", raw };
  }
  const facts = parsed.slice(0, MAX_PER_SOURCE).flatMap((f) => {
    const content = String(f.content ?? "").trim();
    if (!content) return [];
    const segment = (SEGMENTS as readonly string[]).includes(String(f.segment)) ? (f.segment as Segment) : "knowledge";
    const importance = Number.isFinite(f.importance) && f.importance! >= 0 && f.importance! <= 1
      ? f.importance! : SEGMENT_IMPORTANCE[segment];
    return [{ title: String(f.title ?? content).slice(0, 90), content, segment, importance }];
  });
  return { facts, outcome: facts.length ? "facts" : "none", raw };
}

export async function extractFacts(env: Env, title: string, text: string): Promise<InsightPayload[]> {
  return (await extractFactsDetailed(env, title, text)).facts;
}

/** Propose insights from a source that has just been fetched. `text` is the
 *  fetched page, already reduced to prose. Returns how many were proposed. */
export async function extractFromSource(c: store.Ctx, env: Env, sourceId: string, text: string): Promise<number> {
  const source = await store.getSource(c, sourceId);
  if (!source) return 0;
  const facts = await extractFacts(env, source.title, text);
  // Proposals, not notes: invisible to search, context and the tree until a
  // human accepts them.
  for (const f of facts) await store.proposeInsight(c, sourceId, f);
  return facts.length;
}
