"use client";
// One note: where it sits, its title, any changes an agent has proposed to it,
// its body, and the tasks and sources that belong to it.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { actorLabel, api, type Note, type Proposal, type ProposalPreview, type Source, type Task } from "@/lib/api";
import { DiffView } from "./ReviewView";
import { NoteEditor } from "./NoteEditor";
import { NoteMenu } from "./NoteMenu";

export function NoteView({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data: note, isLoading, error } = useQuery({ queryKey: ["note", id], queryFn: () => api.get<Note>(`/notes/${id}`) });
  const { data: ancestors } = useQuery({ queryKey: ["ancestors", id], queryFn: () => api.get<Note[]>(`/notes/${id}/ancestors`) });

  if (isLoading) return <div className="et-page-loading">Loading…</div>;
  // A bad or stale id must not sit on "Loading…", which reads as a hang.
  if (error || !note) return <div className="et-page-loading">That note doesn&rsquo;t exist. It may have been moved to the trash.</div>;

  const rename = async (title: string) => {
    await api.patch(`/notes/${id}`, { title });
    qc.invalidateQueries({ queryKey: ["note", id] });
    qc.invalidateQueries({ queryKey: ["tree"] });
  };

  return (
    <div className="et-page">
      <div className="et-page-inner">
        <div className="et-page-top">
          <div className="et-crumbs">
            {(ancestors ?? []).map((a) => (
              <span key={a.id}><a href={`/note/?id=${a.id}`}>{a.title || "Untitled"}</a> / </span>
            ))}
          </div>
          <NoteMenu note={note} />
        </div>

        <TitleInput title={note.title} onSave={rename} />
        {note.actor !== "human" && (
          <div className="et-note-origin">Created by {actorLabel(note.actor)}{note.source_id && <> from a <a href={`/source/?id=${note.source_id}`}>saved source</a></>}</div>
        )}

        <PatchQueue noteId={id} />
        <NoteEditor noteId={id} />
        <NoteTasks noteId={id} />
        <NoteSources noteId={id} />
      </div>
      <NoteStyles />
    </div>
  );
}

/** The note title. A textarea so a long title wraps instead of scrolling out of
 *  sight; Enter commits, since a title is one line however many rows it takes. */
function TitleInput({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = ref.current;
    if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
  };
  useEffect(grow, [title]);
  return (
    <textarea id="et-note-title" ref={ref} className="et-page-title" defaultValue={title} placeholder="Untitled" rows={1} aria-label="Title"
      onInput={grow}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.currentTarget as HTMLTextAreaElement).blur(); } }}
      onBlur={(e) => { if (e.target.value !== title) onSave(e.target.value); }} />
  );
}

/** Agent-proposed edits to this note, waiting on the user. At the top of the
 *  note rather than in a side panel: a pending edit is a decision the note is
 *  waiting on, and burying it would quietly turn the gate into a rubber stamp. */
function PatchQueue({ noteId }: { noteId: string }) {
  const qc = useQueryClient();
  const { data: patches } = useQuery({
    queryKey: ["proposals", noteId],
    queryFn: () => api.get<Proposal[]>(`/proposals?note_id=${noteId}`),
    refetchInterval: 8000,
  });
  if (!patches?.length) return null;

  const resolve = async (pid: string, accept: boolean) => {
    try { await api.post(`/proposals/${pid}/${accept ? "accept" : "reject"}`); }
    catch (e) { alert(e instanceof Error ? e.message : "Could not resolve that edit"); }
    qc.invalidateQueries({ queryKey: ["proposals"] });
    // The editor seeds once per load, so an accepted edit needs a fresh mount.
    if (accept) window.location.reload();
  };

  return (
    <div className="et-patches">
      {patches.map((p) => <PatchCard key={p.id} patch={p} onResolve={(accept) => resolve(p.id, accept)} />)}
    </div>
  );
}

function PatchCard({ patch: p, onResolve }: { patch: Proposal; onResolve: (accept: boolean) => void }) {
  const { data: preview } = useQuery({ queryKey: ["preview", p.id], queryFn: () => api.get<ProposalPreview>(`/proposals/${p.id}/preview`) });
  const stale = preview && "stale" in preview;
  return (
    <div className="et-patch">
      <div className="et-patch-head">
        <span className="et-patch-actor">{actorLabel(p.actor)}</span>
        <span className="et-patch-summary">{p.summary}</span>
        {!stale && <button className="et-patch-accept" onClick={() => onResolve(true)}>Accept</button>}
        <button className="et-patch-reject" onClick={() => onResolve(false)}>Reject</button>
      </div>
      {preview && "diff" in preview && <details className="et-patch-detail" open><summary>The change</summary><DiffView diff={preview.diff} /></details>}
      {stale && <div className="et-patch-stale">No longer applies — the note has changed since this was proposed.</div>}
    </div>
  );
}

function NoteTasks({ noteId }: { noteId: string }) {
  const qc = useQueryClient();
  const { data: tasks } = useQuery({ queryKey: ["tasks", noteId], queryFn: () => api.get<Task[]>(`/notes/${noteId}/tasks`) });
  const [title, setTitle] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["tasks"] }); };

  return (
    <section className="et-note-section">
      <div className="eyebrow">Tasks</div>
      {(tasks ?? []).map((t) => (
        <label key={t.id} className="et-note-task" data-done={t.status === "done"}>
          <input type="checkbox" checked={t.status === "done"}
            onChange={async (e) => { await api.patch(`/tasks/${t.id}`, { status: e.target.checked ? "done" : "todo" }); refresh(); }} />
          <span>{t.title}</span>
        </label>
      ))}
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        await api.post("/tasks", { title: title.trim(), note_id: noteId });
        setTitle("");
        refresh();
      }}>
        <input id={`et-note-task-${noteId}`} className="et-note-add" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="+ Add a task" aria-label="Add a task" />
      </form>
    </section>
  );
}

function NoteSources({ noteId }: { noteId: string }) {
  const { data: sources } = useQuery({ queryKey: ["note-sources", noteId], queryFn: () => api.get<Source[]>(`/notes/${noteId}/sources`) });
  if (!sources?.length) return null;
  return (
    <section className="et-note-section">
      <div className="eyebrow">Sources</div>
      {sources.map((s) => (
        <a key={s.id} className="et-note-source" href={`/source/?id=${s.id}`}>
          <span>{s.title}</span>
          {s.site && <span className="et-note-site">{s.site}</span>}
        </a>
      ))}
    </section>
  );
}

function NoteStyles() {
  return (
    <style jsx global>{`
      .et-page { flex: 1; min-width: 0; }
      .et-page-loading { padding: 3rem; color: var(--ink-faint); }
      .et-page-inner { max-width: 50rem; margin: 0 auto; padding: 2rem 3rem 6rem; }
      @media (max-width: 860px) { .et-page-inner { padding: 3.2rem 1.1rem 5rem; } }
      .et-page-top { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 0.8rem; }
      .et-crumbs { font-size: 0.78rem; color: var(--ink-faint); min-width: 0; }
      .et-crumbs a { color: inherit; text-decoration: none; }
      .et-crumbs a:hover { color: var(--ink); }
      .et-page-title { font-size: 2.4rem; font-weight: 700; background: none; border: none; width: 100%; color: inherit; font-family: inherit; padding: 0.2rem 0 0.6rem; letter-spacing: -0.02em; line-height: 1.15; resize: none; overflow: hidden; display: block; }
      .et-page-title:focus { outline: none; }
      .et-note-origin { font-size: 0.8rem; color: var(--ink-faint); margin: -0.3rem 0 1rem; }
      .et-note-origin a { color: var(--color-iris); }
      .et-patches { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1.2rem; }
      .et-patch { border: 1px solid var(--color-iris); border-radius: 8px; padding: 0.55rem 0.75rem; font-size: 0.86rem; }
      .et-patch-head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
      .et-patch-actor { font-family: var(--font-mono); font-size: 0.74rem; color: var(--color-iris); }
      .et-patch-summary { flex: 1; min-width: 10rem; }
      .et-patch-accept, .et-patch-reject { background: none; border: 1px solid var(--line-strong); border-radius: 5px; font: inherit; font-size: 0.78rem; padding: 0.2rem 0.55rem; cursor: pointer; color: inherit; }
      .et-patch-accept { border-color: var(--color-iris); color: var(--color-iris); }
      .et-patch-detail summary { cursor: pointer; font-size: 0.78rem; color: var(--ink-faint); margin-top: 0.35rem; }
      .et-patch-detail .et-diff { margin-top: 0.4rem; max-height: 20rem; overflow: auto; }
      .et-patch-stale { font-size: 0.8rem; color: var(--ink-faint); margin-top: 0.3rem; }
      .et-note-section { margin-top: 2.5rem; display: flex; flex-direction: column; gap: 0.35rem; }
      .et-note-section .eyebrow { margin-bottom: 0.3rem; }
      .et-note-task { display: flex; gap: 0.55rem; align-items: center; font-size: 0.92rem; cursor: pointer; }
      .et-note-task[data-done="true"] span { color: var(--ink-faint); text-decoration: line-through; }
      .et-note-add { width: 100%; background: none; border: none; border-bottom: 1px dashed var(--line-strong); font: inherit; font-size: 0.9rem; color: var(--ink); padding: 0.35rem 0; }
      .et-note-add:focus { outline: none; border-bottom-color: var(--color-iris); }
      .et-note-source { display: flex; justify-content: space-between; gap: 1rem; padding: 0.4rem 0; border-bottom: 1px solid var(--line); color: var(--ink); text-decoration: none; font-size: 0.9rem; }
      .et-note-site { font-family: var(--font-mono); font-size: 0.74rem; color: var(--ink-faint); flex: none; }
    `}</style>
  );
}
