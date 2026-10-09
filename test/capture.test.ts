// The capture pipeline: idempotent saves, background ingest against a site,
// and a queue that retries and then gives up visibly.
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ingestSource } from "../src/ingest";
import { ctx } from "../src/store";
import { api, request, tool, unique } from "./helpers";

const post = (path: string, body: unknown, key?: string) =>
  request(`/api${path}`, { method: "POST", body: JSON.stringify(body), headers: key ? { "idempotency-key": key } : {} }).then((r) => r.json<any>());

afterEach(() => vi.restoreAllMocks());

describe("idempotent capture", () => {
  it("returns the first source when a capture is retried with the same key", async () => {
    const key = unique("key");
    const first = await post("/capture", { text: "once" }, key);
    const again = await post("/share", { text: "once" }, key);
    expect(again.id).toBe(first.id);
    expect(again.already_captured).toBe(true);
    expect(first.already_captured).toBeUndefined();
  });

  it("keeps two captures with different keys apart", async () => {
    const a = await post("/capture", { text: "same words" }, unique("k"));
    const b = await post("/capture", { text: "same words" }, unique("k"));
    expect(a.id).not.toBe(b.id);
  });

  it("returns the waiting copy of a link saved twice, but saves it again once dealt with", async () => {
    const url = `https://example.com/${unique()}`;
    const first = await post("/capture", { url });
    expect((await post("/share", { text: `again ${url}` })).id).toBe(first.id);
    await api(`/sources/${first.id}`, "PATCH", { status: "done" });
    expect((await post("/capture", { url })).id).not.toBe(first.id);
  });

  it("takes a key over MCP too", async () => {
    const key = unique("mcp");
    const a = await tool("capture", { text: "from an agent", key });
    const b = await tool("capture", { text: "from an agent", key });
    expect(b.id).toBe(a.id);
  });
});

/** Answer every outbound fetch with `respond`. */
function site(respond: (url: string) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => respond(String(input instanceof Request ? input.url : input)));
}

const page = (head: string, body = "") =>
  new Response(`<html><head>${head}</head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });

describe("ingest", () => {
  it("gives a link its title, site, description and image, and indexes the page", async () => {
    const word = unique("prose");
    site(() => page(
      `<title>Fallback</title><meta property="og:title" content="The Real Title"><meta property="og:description" content="What it is about"><meta property="og:image" content="/cover.png">`,
      `<p>Body text with ${word} in it.</p><script>noise()</script>`,
    ));
    const src = await post("/capture", { url: "https://www.example.org/article" });
    await ingestSource(ctx(env, "system"), env, src.id);
    const after = await api(`/sources/${src.id}`);
    expect(after).toMatchObject({
      title: "The Real Title", site: "example.org", description: "What it is about",
      image: "https://www.example.org/cover.png", fetch_status: "fetched", fetch_error: null,
    });
    expect((await api<Array<{ entity_id: string }>>(`/search?q=${word}`)).map((h) => h.entity_id)).toContain(src.id);
  });

  it("keeps a title the person wrote, and ignores one that only names the platform", async () => {
    site(() => page(`<title>Instagram</title>`));
    const named = await post("/capture", { url: `https://instagram.com/p/${unique()}`, title: "Mine" });
    const bare = await post("/capture", { url: `https://instagram.com/p/${unique()}` });
    for (const s of [named, bare]) await ingestSource(ctx(env, "system"), env, s.id);
    expect((await api(`/sources/${named.id}`)).title).toBe("Mine");
    expect((await api(`/sources/${bare.id}`)).title).toBe(bare.url);
  });

  it.each([
    ["an error status", () => new Response("gone", { status: 404 }), "the site answered 404"],
    ["an unreachable site", () => { throw new TypeError("network down"); }, "could not reach the site"],
  ])("records why when the fetch hits %s, and can be retried", async (_label, respond, reason) => {
    site(respond as () => Response);
    const src = await post("/capture", { url: `https://example.com/${unique()}` });
    await ingestSource(ctx(env, "system"), env, src.id);
    expect(await api(`/sources/${src.id}`)).toMatchObject({ fetch_status: "failed", fetch_error: reason });
    expect(await api(`/sources/${src.id}/retry`, "POST")).toMatchObject({ fetch_status: "pending", fetch_error: null });
  });

  it("refuses to retry a source with no link", async () => {
    const src = await post("/capture", { text: "just words" });
    expect((await request(`/api/sources/${src.id}/retry`, { method: "POST" })).status).toBe(400);
  });
});

describe("the queue", () => {
  /** env whose D1 throws on the write that marks a fetch successful. */
  function brokenAfterFetch() {
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => {
          if (sql.includes("fetch_status = 'fetched'")) throw new Error("disk full");
          return target.prepare(sql);
        };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return { ...env, DB: db } as typeof env;
  }

  async function run(job: unknown, attempts: number, e = env) {
    const batch = createMessageBatch("et-al-jobs", [{ id: "m1", timestamp: Date.now(), attempts, body: job }]);
    const exec = createExecutionContext();
    await worker.queue(batch as never, e, exec);
    return getQueueResult(batch, exec);
  }

  it("retries a job that throws while attempts remain", async () => {
    site(() => page("<title>t</title>"));
    const src = await post("/capture", { url: `https://example.com/${unique()}` });
    const result = await run({ type: "ingest_source", source_id: src.id }, 1, brokenAfterFetch());
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m1"]);
    expect((await api(`/sources/${src.id}`)).fetch_status).toBe("pending");
  });

  it("gives up on the last attempt and marks the source failed, not pending forever", async () => {
    site(() => page("<title>t</title>"));
    const src = await post("/capture", { url: `https://example.com/${unique()}` });
    const result = await run({ type: "ingest_source", source_id: src.id }, 3, brokenAfterFetch());
    expect(result.retryMessages).toEqual([]);
    expect(result.explicitAcks).toEqual(["m1"]);
    expect(await api(`/sources/${src.id}`)).toMatchObject({ fetch_status: "failed", fetch_error: "something went wrong reading it" });
  });
});
