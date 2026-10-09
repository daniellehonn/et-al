// The trust model: agents write facts directly and attributed, propose prose,
// and never approve or destroy anything. Each rule here has a test that fails
// if the rule breaks.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, bodyText, eventActors, noteWithBody, request, rpc, tool, unique } from "./helpers";

const propose = (note_id: string, ops: unknown[], client?: string) =>
  tool<{ id: string; status: string; actor: string }>("propose_note_patch", { note_id, ops, summary: "edit" }, client);

describe("the MCP surface", () => {
  it("offers no tool that writes a body, resolves a proposal, or deletes a note", async () => {
    const { result } = await rpc("tools/list");
    const names: string[] = result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("propose_note_patch");
    for (const banned of ["accept_proposal", "reject_proposal", "delete_note", "write_blocks", "set_blocks"]) {
      expect(names).not.toContain(banned);
    }
    // Anything that touches a body or a proposal may only read it or propose.
    for (const n of names.filter((n) => /block|body|proposal|patch/.test(n))) expect(n).toMatch(/^(get_|list_|propose_)/);
  });

  it("refuses a tool it does not list", async () => {
    const out = await rpc("tools/call", { name: "accept_proposal", arguments: { id: "x" } });
    expect(out.error?.message).toMatch(/unknown tool/);
  });

  it("creates an agent's note with an empty body, even when it sends one", async () => {
    const note = await tool("create_note", { title: unique(), body: "smuggled prose" });
    expect(await bodyText(note.id)).toBe("");
  });

  it("names the field at fault when an agent sends bad input", async () => {
    await expect(tool("create_task", { title: "" })).rejects.toThrow(/^create_task: title:/);
  });
});

describe("attribution", () => {
  it("stamps an agent's write with ai:<client>, and defaults the client to claude", async () => {
    const a = await tool("create_note", { title: unique() }, "cursor");
    const b = await tool("create_note", { title: unique() });
    expect([a.actor, b.actor]).toEqual(["ai:cursor", "ai:claude"]);
    expect(await eventActors(a.id)).toEqual([{ actor: "ai:cursor", action: "create" }]);
  });

  it("stamps a REST write as human", async () => {
    const note = await api("/notes", "POST", { title: unique() });
    expect(note.actor).toBe("human");
    expect((await eventActors(note.id))[0].actor).toBe("human");
  });
});

describe("patches", () => {
  it("leave the body untouched until the user accepts", async () => {
    const note = await noteWithBody("Original text");
    const patch = await propose(note.id, [{ op: "replace_content", content: "Agent text" }]);
    expect(patch).toMatchObject({ status: "pending", actor: "ai:claude" });
    expect(await bodyText(note.id)).toBe("Original text");

    expect((await api(`/proposals/${patch.id}/accept`, "POST")).status).toBe("accepted");
    expect(await bodyText(note.id)).toBe("Agent text");
    const actions = (await eventActors(patch.id)).map((e) => `${e.actor}:${e.action}`);
    expect(actions).toEqual(["ai:claude:propose", "human:accept"]);
  });

  it("are written under the agent's name once accepted, not the reviewer's", async () => {
    const note = await noteWithBody("Mine");
    const patch = await propose(note.id, [{ op: "replace_content", content: "Theirs" }], "cursor");
    await api(`/proposals/${patch.id}/accept`, "POST");
    const blocks = await api<Array<{ actor: string }>>(`/notes/${note.id}/blocks`);
    expect(blocks.map((b) => b.actor)).toEqual(["ai:cursor"]);
  });

  it("change nothing when rejected", async () => {
    const note = await noteWithBody("Keep me");
    const patch = await propose(note.id, [{ op: "replace_content", content: "Replace me" }]);
    expect((await api(`/proposals/${patch.id}/reject`, "POST")).status).toBe("rejected");
    expect(await bodyText(note.id)).toBe("Keep me");
  });

  it("cannot be resolved twice", async () => {
    const note = await noteWithBody("Once");
    const patch = await propose(note.id, [{ op: "replace_content", content: "Twice" }]);
    await api(`/proposals/${patch.id}/accept`, "POST");
    const again = await request(`/api/proposals/${patch.id}/reject`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  it("keep the version they replace, and who wrote it", async () => {
    const note = await noteWithBody("Before");
    const [block] = await api(`/notes/${note.id}/blocks`);
    const patch = await propose(note.id, [{ op: "update", id: block.id, content: { text: "After" } }]);
    await api(`/proposals/${patch.id}/accept`, "POST");
    expect(await bodyText(note.id)).toBe("After");
    const [rev] = await api<Array<{ id: string; content_json: string; actor: string }>>(`/notes/${note.id}/history`);
    expect(JSON.parse(rev.content_json).text).toBe("Before");
    expect(rev.actor).toBe("human");

    // And can be undone from that history.
    await api(`/revisions/${rev.id}/restore`, "POST");
    expect(await bodyText(note.id)).toBe("Before");
  });

  it("cannot reach a block on a different note", async () => {
    const mine = await noteWithBody("Mine");
    const other = await noteWithBody("Other");
    const [block] = await api(`/notes/${mine.id}/blocks`);
    await expect(propose(other.id, [{ op: "update", id: block.id, content: { text: "hijacked" } }])).rejects.toThrow(/is not on note/);
    expect(await bodyText(mine.id)).toBe("Mine");
  });

  it("apply all of their ops or none of them", async () => {
    const note = await noteWithBody("- one\n- two");
    const [first, second] = await api(`/notes/${note.id}/blocks`);
    const patch = await propose(note.id, [
      { op: "update", id: first.id, content: { text: "ONE" } },
      { op: "delete", id: second.id },
    ]);
    // The second block goes away before the patch is reviewed.
    await api(`/notes/${note.id}/blocks`, "POST", { ops: [{ op: "delete", id: second.id }] });
    const res = await request(`/api/proposals/${patch.id}/accept`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await bodyText(note.id)).toBe("one");
  });

  it("are rejected up front when malformed, not when accepted", async () => {
    const note = await noteWithBody("x");
    await expect(propose(note.id, [{ op: "explode" }])).rejects.toThrow(/invalid patch/);
  });

  it("are never indexed, so pending prose cannot be found", async () => {
    const word = unique("pending");
    const note = await noteWithBody("plain");
    await propose(note.id, [{ op: "replace_content", content: `secret ${word}` }]);
    expect(await api(`/search?q=${word}`)).toEqual([]);
    const { results } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM search_fts WHERE entity_type = 'proposal'`).all<{ n: number }>();
    expect(results[0].n).toBe(0);
  });
});
