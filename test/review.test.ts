// Reviewing a proposal: the preview a person approves is exactly what gets
// written, and a patch the note has moved on from says so instead of misleading.
import { describe, expect, it } from "vitest";
import { bodyLines, toBody } from "../src/store";
import { api, noteWithBody, request, tool } from "./helpers";

type Preview = { kind: string; before?: string[]; after?: string[]; diff?: Array<{ kind: string; text: string }>; stale?: string };

const currentLines = async (noteId: string) => bodyLines(toBody(await api(`/notes/${noteId}/blocks`)));

describe("patch preview", () => {
  it("shows a line diff of the change", async () => {
    const note = await noteWithBody("# Plan\n- keep\n- old");
    const [, , old] = await api(`/notes/${note.id}/blocks`);
    const patch = await tool("propose_note_patch", { note_id: note.id, summary: "s", ops: [{ op: "update", id: old.id, content: { text: "new" } }] });
    const preview = await api<Preview>(`/proposals/${patch.id}/preview`);
    expect(preview.diff).toEqual([
      { kind: "same", text: "# Plan" },
      { kind: "same", text: "- keep" },
      { kind: "del", text: "- old" },
      { kind: "add", text: "- new" },
    ]);
  });

  it.each([
    ["a rewrite", (_: string[]) => [{ op: "replace_content", content: "# New\n- x\n  - y\n- [ ] z" }]],
    ["an insert, an update and a move", (ids: string[]) => [
      { op: "insert", after: ids[0], type: "bullet", content: { text: "inserted" } },
      { op: "update", id: ids[1], content: { text: "updated" } },
      { op: "move", id: ids[2], parent: ids[0] },
    ]],
  ])("previews exactly what accepting %s writes", async (_label, makeOps) => {
    const note = await noteWithBody("- one\n- two\n- three");
    const ids = (await api<Array<{ id: string }>>(`/notes/${note.id}/blocks`)).map((b) => b.id);
    const patch = await tool("propose_note_patch", { note_id: note.id, summary: "s", ops: makeOps(ids) });
    const preview = await api<Preview>(`/proposals/${patch.id}/preview`);
    expect(preview.before).toEqual(await currentLines(note.id));
    await api(`/proposals/${patch.id}/accept`, "POST");
    expect(await currentLines(note.id)).toEqual(preview.after);
  });

  it("reports a patch the note has moved on from as stale, and will not apply it", async () => {
    const note = await noteWithBody("- target");
    const [block] = await api(`/notes/${note.id}/blocks`);
    const patch = await tool("propose_note_patch", { note_id: note.id, summary: "s", ops: [{ op: "update", id: block.id, content: { text: "edited" } }] });
    await api(`/notes/${note.id}/blocks`, "POST", { ops: [{ op: "delete", id: block.id }] });
    expect((await api<Preview>(`/proposals/${patch.id}/preview`)).stale).toMatch(/not on this note/);
    expect((await request(`/api/proposals/${patch.id}/accept`, { method: "POST" })).status).toBe(400);
  });
});
