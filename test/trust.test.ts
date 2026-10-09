// The trust model: agents write facts directly and attributed, propose prose,
// and never approve anything. These are the rules DESIGN.md calls the spine.
import { describe, expect, it } from "vitest";
import { api, bodyText, eventActors, rpc, tool, unique } from "./helpers";

async function pageWithBody(text: string) {
  const page = await api("/pages", "POST", { title: unique("page") });
  await api(`/pages/${page.id}/blocks`, "POST", { ops: [{ op: "replace_content", content: text }] });
  return page as { id: string };
}

describe("the MCP surface", () => {
  it("offers no tool that writes a page body, deletes a page, or approves anything", async () => {
    const { result } = await rpc("tools/list");
    const names: string[] = result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("propose_page_patch");
    expect(names).not.toContain("delete_page");
    expect(names).not.toContain("accept_proposal");
    expect(names).not.toContain("reject_proposal");
    // Any tool that touches blocks may only read them.
    for (const n of names.filter((n) => n.includes("block"))) expect(n).toMatch(/^get_/);
  });

  it("refuses to run a tool it does not list", async () => {
    const out = await rpc("tools/call", { name: "accept_proposal", arguments: { id: "x" } });
    expect(out.error?.message).toMatch(/unknown tool/);
  });
});

describe("attribution", () => {
  it("stamps an agent's write with ai:<client>", async () => {
    const page = await tool("create_page", { title: unique() }, "cursor");
    expect(page.actor).toBe("ai:cursor");
    expect(await eventActors(page.id)).toEqual([{ actor: "ai:cursor", action: "create" }]);
  });

  it("defaults the client to claude", async () => {
    const page = await tool("create_page", { title: unique() });
    expect(page.actor).toBe("ai:claude");
  });

  it("stamps a REST write as human", async () => {
    const page = await api("/pages", "POST", { title: unique() });
    expect(page.actor).toBe("human");
    expect((await eventActors(page.id))[0].actor).toBe("human");
  });
});

describe("page patches", () => {
  it("leaves the body untouched until a human accepts", async () => {
    const page = await pageWithBody("Original text");
    const patch = await tool("propose_page_patch", {
      page_id: page.id, summary: "rewrite", ops: [{ op: "replace_content", content: "Agent text" }],
    });
    expect(patch).toMatchObject({ status: "pending", actor: "ai:claude" });
    expect(await bodyText(page.id)).toBe("Original text");

    const resolved = await api(`/patches/${patch.id}/resolve`, "POST", { accept: true });
    expect(resolved.status).toBe("accepted");
    expect(await bodyText(page.id)).toBe("Agent text");
    const actions = (await eventActors(page.id)).map((e) => `${e.actor}:${e.action}`);
    expect(actions).toContain("ai:claude:patch_proposed");
    expect(actions).toContain("human:patch_accepted");
  });

  it("changes nothing when rejected", async () => {
    const page = await pageWithBody("Keep me");
    const patch = await tool("propose_page_patch", {
      page_id: page.id, summary: "rewrite", ops: [{ op: "replace_content", content: "Replace me" }],
    });
    expect((await api(`/patches/${patch.id}/resolve`, "POST", { accept: false })).status).toBe("rejected");
    expect(await bodyText(page.id)).toBe("Keep me");
  });

  it("cannot be resolved twice", async () => {
    const page = await pageWithBody("Once");
    const patch = await tool("propose_page_patch", {
      page_id: page.id, summary: "s", ops: [{ op: "replace_content", content: "Twice" }],
    });
    await api(`/patches/${patch.id}/resolve`, "POST", { accept: true });
    await expect(api(`/patches/${patch.id}/resolve`, "POST", { accept: false })).rejects.toThrow(/already accepted/);
  });

  it("keeps the previous version of a block it updates", async () => {
    const page = await pageWithBody("Before");
    const [block] = await api(`/pages/${page.id}/blocks`);
    const patch = await tool("propose_page_patch", {
      page_id: page.id, summary: "edit", ops: [{ op: "update", id: block.id, content: { text: "After" } }],
    });
    await api(`/patches/${patch.id}/resolve`, "POST", { accept: true });
    expect(await bodyText(page.id)).toBe("After");
    const history = await api<Array<{ content_json?: string }>>(`/pages/${page.id}/history`);
    expect(JSON.stringify(history)).toContain("Before");
  });

  it("rejects a malformed patch up front instead of failing on accept", async () => {
    const page = await pageWithBody("x");
    await expect(tool("propose_page_patch", {
      page_id: page.id, summary: "bad", ops: [{ op: "explode" }],
    })).rejects.toThrow(/invalid page ops/);
  });
});
