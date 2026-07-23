"use client";

// Knowledge — durable explanations, with mastery made visible.
//
// The one rule this screen protects (spec §5.7): "My explanation" and "Where I
// applied it" are the user's own words. Mastery is advanced by hand, never
// inferred, and generated prose is labeled wherever it appears.

import { useCallback, useEffect, useState } from "react";
import BodyEditor from "@/components/BodyEditor";
import DeleteButton from "@/components/DeleteButton";
import { Connections } from "../projects/page";
import { getNotes, createNote, updateNote, deleteNote, type Note } from "@/lib/api";

const MASTERY = ["captured", "learning", "understood", "applied"] as const;
const NOTE_TYPES = ["concept", "how-to", "reference", "comparison", "question", "mental-model"] as const;

/** The prompts a note is written against (spec Appendix B). */
const TEMPLATE_HINT =
  "Plain-language explanation · How it works · Example · Common mistakes · " +
  "My explanation · Where I applied it · Sources";

export default function KnowledgePage() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [mastery, setMastery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback((m?: string) => {
    getNotes(m ? { mastery: m } : {}).then((r) => setNotes(r.notes)).catch(() => setNotes([]));
  }, []);

  useEffect(() => {
    setSelectedId(new URLSearchParams(window.location.search).get("id"));
    load();
  }, [load]);

  function select(id: string | null) {
    setSelectedId(id);
    window.history.pushState({}, "", id ? `?id=${encodeURIComponent(id)}` : window.location.pathname);
  }

  return (
    <>
      <h1>Knowledge</h1>
      <p style={{ color: "var(--ink-2)", margin: "4px 0 16px" }}>
        Concepts you can explain in your own words — and point at where you used them.
      </p>

      <div className="pick" style={{ marginBottom: 16 }}>
        <button className={mastery === "" ? "on" : ""}
          onClick={() => { setMastery(""); setNotes(null); load(); }}>All</button>
        {MASTERY.map((m) => (
          <button key={m} className={mastery === m ? "on" : ""}
            onClick={() => { setMastery(m); setNotes(null); load(m); }}>{m}</button>
        ))}
      </div>

      <div className="split">
        <div className="list-pane">
          <NewNote onCreated={(n) => { load(mastery || undefined); select(n.id); }} />
          <div className="card">
            {!notes && <><div className="skeleton" /><div className="skeleton" /></>}
            {notes?.length === 0 && (
              <div className="empty">
                <strong>No notes yet</strong>
                A note starts as <em>captured</em> and only advances when you can explain it
                yourself. {TEMPLATE_HINT}
              </div>
            )}
            {notes?.map((n) => (
              <button key={n.id}
                className={`row selectable ${selectedId === n.id ? "selected" : ""}`}
                onClick={() => select(n.id)}>
                <div className="lead">
                  <div className="title">{n.title}</div>
                  <div className="meta">{n.note_type}</div>
                </div>
                <span className={`chip ${n.mastery === "applied" ? "ok" : ""}`}>{n.mastery}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="detail-pane">
          {selectedId
            ? <NoteDetail id={selectedId} notes={notes ?? []} onSaved={() => load(mastery || undefined)}
                onDeleted={() => { select(null); load(mastery || undefined); }}
                onOpenLink={(title) => {
                  const match = (notes ?? []).find((n) => n.title.toLowerCase() === title.toLowerCase());
                  if (match) select(match.id);
                }} />
            : <div className="card"><div className="empty">
                <strong>Select a note</strong>Its explanation and connections live here.
              </div></div>}
        </div>
      </div>
    </>
  );
}

function NewNote({ onCreated }: { onCreated: (n: Note) => void }) {
  const [title, setTitle] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onCreated(await createNote({ title: title.trim() }));
    setTitle("");
  }
  return (
    <form className="capture" style={{ marginBottom: 0 }} onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="New concept…" aria-label="New note" />
      <button className="btn" disabled={!title.trim()}>Add</button>
    </form>
  );
}

function NoteDetail({
  id, notes, onSaved, onDeleted, onOpenLink,
}: { id: string; notes: Note[]; onSaved: () => void; onDeleted: () => void; onOpenLink: (t: string) => void }) {
  const [note, setNote] = useState<Note | null>(null);
  const [tab, setTab] = useState<"Note" | "Connections">("Note");

  useEffect(() => {
    setNote(notes.find((n) => n.id === id) ?? null);
    setTab("Note");
  }, [id, notes]);

  async function patch(body: Partial<Note>) {
    const updated = await updateNote(id, body);
    setNote(updated);
    onSaved();
  }

  if (!note) return <div className="card"><div className="skeleton" /></div>;

  return (
    <>
      <input className="title-field" value={note.title}
        onChange={(e) => setNote({ ...note, title: e.target.value })}
        onBlur={(e) => e.target.value && patch({ title: e.target.value })}
        aria-label="Note title" />

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", margin: "10px 0 14px" }}>
        <div>
          <div className="kicker" style={{ marginBottom: 4 }}>Mastery</div>
          <div className="pick">
            {MASTERY.map((m) => (
              <button key={m} className={note.mastery === m ? "on" : ""}
                onClick={() => patch({ mastery: m })}>{m}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="kicker" style={{ marginBottom: 4 }}>Type</div>
          <div className="pick">
            {NOTE_TYPES.map((t) => (
              <button key={t} className={note.note_type === t ? "on" : ""}
                onClick={() => patch({ note_type: t })}>{t}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <div className="pick">
          {(["Note", "Connections"] as const).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <DeleteButton what="this note"
          onDelete={async () => { await deleteNote(id); onDeleted(); }} />
      </div>

      {tab === "Note" ? (
        <BodyEditor
          resource="notes" subjectType="knowledge_note" id={id} title={note.title}
          linkTargets={notes.map((n) => n.title)}
          onOpenLink={onOpenLink}
        />
      ) : (
        <Connections resource="notes" id={id} />
      )}
    </>
  );
}
