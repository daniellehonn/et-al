// Machine-extracted knowledge is proposed, never assumed: an extracted insight
// stays out of every read path until a human accepts it. Extraction runs here
// with a fake model, so the gate is tested end to end without Workers AI.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { extractFromSource } from "../src/extract";
import { ctx } from "../src/store";
import { api, tool, unique } from "./helpers";

const ARTICLE = "A long enough article body. ".repeat(12); // extraction skips anything under 200 chars

/** An env whose model returns `output` (or throws it, if it is an Error). */
function withModel(output: unknown) {
  const calls: unknown[] = [];
  const fake = {
    ...env,
    AI: { run: async (_model: string, input: unknown) => { calls.push(input); if (output instanceof Error) throw output; return output; } },
  };
  return { env: fake as unknown as typeof env, calls };
}

const facts = (...items: Array<Record<string, unknown>>) => JSON.stringify({ facts: items });

/** A page with one captured source on it. */
async function sourceOnPage() {
  const owner = await api("/pages", "POST", { title: unique("owner") });
  const source = await tool("capture", { kind: "note", title: unique("src"), raw: "saved", page_id: owner.id });
  return { ownerId: owner.id as string, sourceId: source.id as string };
}

async function extract(output: unknown, text = ARTICLE) {
  const { ownerId, sourceId } = await sourceOnPage();
  const model = withModel(output);
  const created = await extractFromSource(ctx(env, "system"), model.env, sourceId, text);
  return { ownerId, sourceId, created, calls: model.calls };
}

const proposalsFor = async (sourceId: string) =>
  (await tool<Array<{ id: string; title: string; props: Record<string, unknown> }>>("list_proposals"))
    .filter((p) => p.props.source_id === sourceId);

describe("the proposal gate", () => {
  it("hides a proposal from insights, search and context until a human accepts it", async () => {
    const word = unique("fact");
    const { ownerId, sourceId } = await extract({ response: facts({ title: `About ${word}`, content: `${word} is durable.` }) });

    const [proposal] = await proposalsFor(sourceId);
    expect(proposal.title).toContain(word);
    expect(proposal.props).toMatchObject({ proposed: true, is_ai: true });

    const insightIds = async () => (await tool<Array<{ id: string }>>("list_insights", { page_id: ownerId })).map((i) => i.id);
    const searchIds = async () => (await api<Array<{ entity_id: string }>>(`/search?q=${word}`)).map((h) => h.entity_id);
    const contextIds = async () =>
      (await tool<{ related: Array<{ entity_id: string }> }>("build_context", { page_id: ownerId, query: word })).related.map((h) => h.entity_id);

    expect(await insightIds()).not.toContain(proposal.id);
    expect(await searchIds()).not.toContain(proposal.id);
    expect(await contextIds()).not.toContain(proposal.id);

    await api(`/proposals/${proposal.id}/accept`, "POST");

    expect(await insightIds()).toContain(proposal.id);
    expect(await searchIds()).toContain(proposal.id);
    expect(await contextIds()).toContain(proposal.id);
    expect(await proposalsFor(sourceId)).toEqual([]);
  });

  it("deletes a rejected proposal and leaves its source alone", async () => {
    const { sourceId } = await extract({ response: facts({ title: "t", content: "c" }) });
    const [proposal] = await proposalsFor(sourceId);
    await api(`/proposals/${proposal.id}/reject`, "POST");
    expect(await proposalsFor(sourceId)).toEqual([]);
    expect((await api(`/sources/${sourceId}`)).id).toBe(sourceId);
  });

  it.todo("finds an accepted insight by meaning — the vector arm of search still reads the v7 `insight` table");
});

describe("extraction parsing", () => {
  it("reads the older {response} shape, even wrapped in prose and a code fence", async () => {
    const out = { response: "Here you go:\n```json\n" + facts({ title: "a", content: "b" }) + "\n```" };
    expect((await extract(out)).created).toBe(1);
  });

  it("reads the OpenAI-style {choices} shape", async () => {
    const out = { choices: [{ message: { content: facts({ title: "a", content: "b" }) } }] };
    expect((await extract(out)).created).toBe(1);
  });

  it("caps a source at three proposals", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ title: `f${i}`, content: `fact ${i}` }));
    expect((await extract({ response: facts(...many) })).created).toBe(3);
  });

  it("skips facts with no content", async () => {
    expect((await extract({ response: facts({ title: "empty", content: "  " }, { title: "ok", content: "x" }) })).created).toBe(1);
  });

  it("falls back to sane defaults for an unknown segment or out-of-range importance", async () => {
    const { sourceId } = await extract({ response: facts({ title: "t", content: "c", segment: "gossip", importance: 7 }) });
    const [p] = await proposalsFor(sourceId);
    expect(p.props).toMatchObject({ segment: "knowledge", importance: 0.6 });
  });

  it.each([
    ["malformed JSON", { response: "{facts: [oops" }],
    ["no JSON at all", { response: "Nothing durable here." }],
    ["an empty list", { response: facts() }],
    ["a model error", new Error("model retired")],
  ])("creates nothing, and does not throw, on %s", async (_label, out) => {
    expect((await extract(out)).created).toBe(0);
  });

  it("does not call the model for a body too short to extract from", async () => {
    const { created, calls } = await extract({ response: facts({ title: "a", content: "b" }) }, "Login required.");
    expect(created).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
