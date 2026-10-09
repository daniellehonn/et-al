// Machine-extracted knowledge is proposed, never assumed: an extracted insight
// is a proposal, not a note, until a human accepts it. Extraction runs here with
// a fake model, so this is tested end to end without Workers AI.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { extractFromSource } from "../src/extract";
import { ctx, search } from "../src/store";
import { api, tool, unique } from "./helpers";

const ARTICLE = "A long enough article body. ".repeat(12); // extraction skips anything under 200 chars

/** The real env with Workers AI swapped for a model that returns `output`
 *  (or throws it, if it is an Error). */
function withModel(output: unknown) {
  const calls: unknown[] = [];
  const fake = {
    ...env,
    AI: { run: async (_model: string, input: unknown) => { calls.push(input); if (output instanceof Error) throw output; return output; } },
  };
  return { env: fake as unknown as typeof env, calls };
}

const facts = (...items: Array<Record<string, unknown>>) => JSON.stringify({ facts: items });

/** Capture a source (optionally filed into a note) and run extraction on it. */
async function extract(output: unknown, opts: { text?: string; note_id?: string } = {}) {
  const source = await tool("capture", { title: unique("src"), text: "saved", note_id: opts.note_id });
  const model = withModel(output);
  const created = await extractFromSource(ctx(env, "system"), model.env, source.id, opts.text ?? ARTICLE);
  const proposals = (await api<Array<{ id: string; kind: string; source_id: string; summary: string; payload: string }>>(`/proposals?source_id=${source.id}`));
  return { sourceId: source.id as string, created, calls: model.calls, proposals };
}

describe("the proposal gate", () => {
  it("keeps an insight out of the tree, search and context until it is accepted", async () => {
    const word = unique("fact");
    const home = await api("/notes", "POST", { title: unique("home") });
    const { proposals: [p] } = await extract({ response: facts({ title: `About ${word}`, content: `${word} is durable.` }) }, { note_id: home.id });
    expect(p).toMatchObject({ kind: "insight", summary: `About ${word}` });

    const treeTitles = async () => JSON.stringify(await api("/notes/tree"));
    const searchIds = async () => (await api<Array<{ entity_id: string }>>(`/search?q=${word}`)).map((h) => h.entity_id);
    const contextIds = async () => (await api<{ related: Array<{ entity_id: string }> }>(`/context/${home.id}?q=${word}`)).related.map((h) => h.entity_id);

    expect(await treeTitles()).not.toContain(word);
    expect(await searchIds()).toEqual([]);
    expect(await contextIds()).toEqual([]);

    const accepted = await api(`/proposals/${p.id}/accept`, "POST");
    const note = await api(`/notes/${accepted.result_id}`);
    // Written by the extractor, filed where its source was, and traceable to it.
    expect(note).toMatchObject({ title: `About ${word}`, actor: "system", parent_id: home.id });
    expect(note.source_id).toBeTruthy();

    expect(await treeTitles()).toContain(word);
    expect(await searchIds()).toContain(note.id);
    expect(await contextIds()).toContain(note.id);
  });

  it("creates nothing when rejected, and the source survives", async () => {
    const { sourceId, proposals: [p] } = await extract({ response: facts({ title: "t", content: "c" }) });
    const rejected = await api(`/proposals/${p.id}/reject`, "POST");
    expect(rejected).toMatchObject({ status: "rejected", result_id: null });
    expect((await api(`/sources/${sourceId}`)).id).toBe(sourceId);
  });

  it("takes pending insights with it when a source is deleted, but keeps accepted ones", async () => {
    const { sourceId, proposals } = await extract({ response: facts({ title: "keep", content: "a" }, { title: "drop", content: "b" }) });
    const keep = proposals.find((p) => p.summary === "keep")!;
    const accepted = await api(`/proposals/${keep.id}/accept`, "POST");
    await api(`/sources/${sourceId}`, "DELETE");
    expect(await api(`/proposals?source_id=${sourceId}`)).toEqual([]);
    expect((await api(`/notes/${accepted.result_id}`)).title).toBe("keep");
  });
});

describe("extraction parsing", () => {
  it("reads the older {response} shape, even wrapped in prose and a code fence", async () => {
    const out = { response: "Here you go:\n```json\n" + facts({ title: "a", content: "b" }) + "\n```" };
    expect((await extract(out)).created).toBe(1);
  });

  it("reads the OpenAI-style {choices} shape", async () => {
    expect((await extract({ choices: [{ message: { content: facts({ title: "a", content: "b" }) } }] })).created).toBe(1);
  });

  it("caps a source at three proposals", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ title: `f${i}`, content: `fact ${i}` }));
    expect((await extract({ response: facts(...many) })).created).toBe(3);
  });

  it("skips facts with no content", async () => {
    expect((await extract({ response: facts({ title: "empty", content: "  " }, { title: "ok", content: "x" }) })).created).toBe(1);
  });

  it("falls back to sane defaults for an unknown segment or out-of-range importance", async () => {
    const { proposals: [p] } = await extract({ response: facts({ title: "t", content: "c", segment: "gossip", importance: 7 }) });
    expect(JSON.parse(p.payload)).toMatchObject({ segment: "knowledge", importance: 0.6 });
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
    const { created, calls } = await extract({ response: facts({ title: "a", content: "b" }) }, { text: "Login required." });
    expect(created).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("hybrid search", () => {
  it("finds a note by meaning when no keyword matches, ranked by fusion with keyword hits", async () => {
    const byMeaning = await api("/notes", "POST", { title: "Sourdough starter", body: "Feed it flour and water daily." });
    const byKeyword = await api("/notes", "POST", { title: unique("bread"), body: "bread" });
    const fake = {
      ...env,
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VECTORIZE: { query: async () => ({ matches: [{ id: byMeaning.id }, { id: "note_deleted_since" }] }) },
    } as unknown as typeof env;
    const hits = await search(ctx(fake), "bread");
    const ids = hits.map((h) => h.entity_id);
    expect(ids).toContain(byMeaning.id); // no keyword overlap: only the vector arm finds it
    expect(ids).toContain(byKeyword.id);
    expect(ids).not.toContain("note_deleted_since"); // a stale vector is dropped, not returned
  });

  it("falls back to keywords when the vector arm fails", async () => {
    const word = unique("kw");
    const note = await api("/notes", "POST", { title: word });
    const broken = { ...env, AI: { run: async () => { throw new Error("down"); } }, VECTORIZE: {} } as unknown as typeof env;
    expect((await search(ctx(broken), word)).map((h) => h.entity_id)).toEqual([note.id]);
  });
});
