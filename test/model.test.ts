// The rest of the model: the note tree and its trash, tasks, and capture.
import { describe, expect, it } from "vitest";
import { api, bodyText, request, unique } from "./helpers";

const note = (title = unique(), parent_id?: string) => api("/notes", "POST", { title, parent_id });

describe("notes", () => {
  it("refuses a move that would put a note inside itself", async () => {
    const parent = await note();
    const child = await note(unique(), parent.id);
    const res = await request(`/api/notes/${parent.id}/move`, { method: "POST", body: JSON.stringify({ parent_id: child.id }) });
    expect(res.status).toBe(400);
  });

  it("trashes a whole subtree and brings it back", async () => {
    const parent = await note();
    const child = await note(unique(), parent.id);
    await api(`/notes/${parent.id}`, "DELETE");
    expect((await request(`/api/notes/${child.id}`)).status).toBe(404);
    expect((await api<Array<{ id: string }>>("/trash")).map((n) => n.id)).toContain(parent.id);
    expect((await api<Array<{ id: string }>>("/trash")).map((n) => n.id)).not.toContain(child.id);

    await api(`/notes/${parent.id}/restore`, "POST");
    expect((await api(`/notes/${child.id}`)).parent_id).toBe(parent.id);
  });

  it("restores to the root when its old parent is still in the trash", async () => {
    const parent = await note();
    const child = await note(unique(), parent.id);
    await api(`/notes/${child.id}`, "DELETE");
    await api(`/notes/${parent.id}`, "DELETE");
    expect((await api(`/notes/${child.id}/restore`, "POST")).parent_id).toBeNull();
  });

  it("only deletes permanently from the trash, and unlinks what pointed at it", async () => {
    const doomed = await note();
    const task = await api("/tasks", "POST", { title: unique(), note_id: doomed.id });
    expect((await request(`/api/trash/${doomed.id}`, { method: "DELETE" })).status).toBe(400);
    await api(`/notes/${doomed.id}`, "DELETE");
    await api(`/trash/${doomed.id}`, "DELETE");
    expect((await request(`/api/notes/${doomed.id}`)).status).toBe(404);
    const tasks = await api<Array<{ id: string; note_id: string | null }>>("/tasks");
    expect(tasks.find((t) => t.id === task.id)?.note_id).toBeNull();
  });

  it("keeps block identity when the editor sends the whole body back", async () => {
    const n = await api("/notes", "POST", { title: unique(), body: "- a\n- b" });
    const [a, b] = await api<Array<{ id: string; version: number }>>(`/notes/${n.id}/blocks`);
    const body = [
      { id: a.id, parent_block_id: null, type: "bullet", content: { text: "a" }, position: 1 },
      { id: b.id, parent_block_id: null, type: "bullet", content: { text: "b, edited" }, position: 2 },
      { id: "blk_new", parent_block_id: null, type: "paragraph", content: { text: "c" }, position: 3 },
    ];
    const after = await api<Array<{ id: string; version: number }>>(`/notes/${n.id}/blocks`, "PUT", { blocks: body });
    expect(after.map((x) => [x.id, x.version])).toEqual([[a.id, 1], [b.id, 2], ["blk_new", 1]]);
    expect(await bodyText(n.id)).toBe("a\nb, edited\nc");
  });
});

describe("tasks", () => {
  it("records when a task is done, and forgets it when reopened", async () => {
    const t = await api("/tasks", "POST", { title: unique() });
    const done = await api(`/tasks/${t.id}`, "PATCH", { status: "done" });
    expect(done.completed_at).toBeTypeOf("number");
    expect((await api(`/tasks/${t.id}`, "PATCH", { status: "todo" })).completed_at).toBeNull();
  });

  it("nests subtasks and deletes them with their parent", async () => {
    const parent = await api("/tasks", "POST", { title: unique() });
    const sub = await api("/tasks", "POST", { title: unique(), parent_id: parent.id });
    const tree = await api<Array<{ id: string; subtasks: Array<{ id: string }> }>>("/tasks");
    expect(tree.find((t) => t.id === parent.id)?.subtasks.map((s) => s.id)).toEqual([sub.id]);
    await api(`/tasks/${parent.id}`, "DELETE");
    const ids = JSON.stringify(await api("/tasks"));
    expect(ids).not.toContain(parent.id);
    expect(ids).not.toContain(sub.id);
  });

  it("rejects a task with no title as a 400 naming the field", async () => {
    const res = await request("/api/tasks", { method: "POST", body: JSON.stringify({ title: "" }) });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/^title:/);
  });
});

describe("capture", () => {
  it("pulls the link out of a share sheet's text and keeps the rest as the note", async () => {
    const s = await api("/share", "POST", { text: "worth reading https://example.com/post later" });
    expect(s).toMatchObject({ url: "https://example.com/post", text: "worth reading https://example.com/post later", status: "inbox", fetch_status: "pending" });
  });

  it("does not repeat a link that was the whole of the text", async () => {
    const s = await api("/share", "POST", { url: "https://example.com/a", text: "https://example.com/a" });
    expect(s).toMatchObject({ url: "https://example.com/a", text: null });
  });

  it("demotes prose a share sheet put in the url field", async () => {
    const s = await api("/share", "POST", { url: "just a thought" });
    expect(s).toMatchObject({ url: null, text: "just a thought", fetch_status: null });
  });

  it("clears a source from the inbox when it is filed into a note", async () => {
    const n = await note();
    const s = await api("/capture", "POST", { text: unique("thought") });
    expect((await api<Array<{ id: string }>>("/inbox")).map((x) => x.id)).toContain(s.id);
    await api(`/sources/${s.id}`, "PATCH", { note_id: n.id });
    expect((await api<Array<{ id: string }>>("/inbox")).map((x) => x.id)).not.toContain(s.id);
    expect((await api<Array<{ id: string }>>(`/notes/${n.id}/sources`)).map((x) => x.id)).toEqual([s.id]);
  });

  it("refuses to capture nothing", async () => {
    expect((await request("/api/capture", { method: "POST", body: "{}" })).status).toBe(400);
  });
});
