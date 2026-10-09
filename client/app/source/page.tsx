"use client";
// /source/?id=… — one saved source: what it is, where it came from, where it is
// filed, and what has been suggested from it.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { actorLabel, api, type Note, type Proposal, type Source } from "@/lib/api";

export default function SourcePage() {
  // Read from window.location: this route is statically exported, and
  // useSearchParams would force a Suspense boundary for no gain.
  const [id, setId] = useState<string | null>(null);
  useEffect(() => setId(new URLSearchParams(window.location.search).get("id")), []);

  const { data: source, error } = useQuery({ queryKey: ["source", id], queryFn: () => api.get<Source>(`/sources/${id}`), enabled: !!id });
  const { data: filedIn } = useQuery({
    queryKey: ["note", source?.note_id], queryFn: () => api.get<Note>(`/notes/${source!.note_id}`), enabled: !!source?.note_id,
  });
  const { data: pending } = useQuery({
    queryKey: ["proposals", "source", id], queryFn: () => api.get<Proposal[]>(`/proposals?source_id=${id}`), enabled: !!id,
  });

  if (error) return <div className="et-source et-empty">That source doesn&rsquo;t exist. It may have been deleted.</div>;
  if (!source) return null;

  return (
    <div className="et-source">
      <div className="eyebrow">Saved {new Date(source.created_at).toLocaleDateString()} by {actorLabel(source.actor)}</div>
      <h1 className="serif">{source.title || source.url}</h1>
      {source.image && <img className="et-source-img" src={source.image} alt="" />}
      {source.description && <p className="et-source-desc">{source.description}</p>}
      {source.text && <p className="et-source-text">{source.text}</p>}
      {source.url && <a className="et-source-link" href={source.url} target="_blank" rel="noopener noreferrer">{source.url}</a>}
      {source.fetch_status === "failed" && <p className="et-source-desc">Couldn&rsquo;t read the link: {source.fetch_error}</p>}
      <dl>
        <dt>Filed in</dt>
        <dd>{filedIn ? <a href={`/note/?id=${filedIn.id}`}>{filedIn.title || "Untitled"}</a> : "Not filed yet"}</dd>
        <dt>Waiting for review</dt>
        <dd>{pending?.length ? <a href="/inbox/">{pending.length} suggestion{pending.length === 1 ? "" : "s"} in the inbox</a> : "Nothing"}</dd>
      </dl>
      <style>{`
        .et-source { max-width: 44rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
        @media (max-width: 860px) { .et-source { padding: 3.5rem 1.1rem 5rem; } }
        .et-source h1 { font-size: 2.2rem; margin: 0.4rem 0 1rem; overflow-wrap: anywhere; }
        .et-source-img { max-width: 100%; border-radius: 10px; border: 1px solid var(--line); margin-bottom: 1rem; }
        .et-source-desc, .et-source-text { color: var(--ink-soft); }
        .et-source-link { font-family: var(--font-mono); font-size: 0.8rem; color: var(--color-iris); overflow-wrap: anywhere; }
        .et-source dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1.2rem; margin-top: 2rem; font-size: 0.9rem; }
        .et-source dt { color: var(--ink-faint); }
        .et-source dd { margin: 0; }
        .et-source dd a { color: var(--color-iris); }
      `}</style>
    </div>
  );
}
