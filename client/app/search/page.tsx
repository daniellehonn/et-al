"use client";

// Search — hybrid across every entity type.
//
// Results report WHICH layers matched (keyword, semantic, or both). That is not
// decoration: when a result appears that shares no words with the query, saying
// "semantic" is the difference between the search looking broken and looking
// clever.

import { useState } from "react";
import { search, type SearchHit } from "@/lib/api";

const TYPES = [
  ["", "All"], ["project", "Projects"], ["knowledge_note", "Notes"],
  ["project_log", "Logs"], ["tool", "Tools"], ["source", "Sources"], ["content_item", "Content"],
] as const;

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(event?: React.FormEvent, overrideType?: string) {
    event?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await search(q.trim(), (overrideType ?? type) || undefined);
      setHits(r.results);
    } finally { setBusy(false); }
  }

  return (
    <>
      <h1>Search</h1>
      <p style={{ color: "var(--ink-2)", margin: "4px 0 16px" }}>
        Keyword and meaning together — it can find the right idea even when the words differ.
      </p>

      <form className="capture" onSubmit={run}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search everything…" aria-label="Search" autoFocus />
        <button className="btn primary" disabled={busy || !q.trim()}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

      <div className="pick" style={{ marginBottom: 16 }}>
        {TYPES.map(([value, label]) => (
          <button key={value} className={type === value ? "on" : ""}
            onClick={() => { setType(value); if (q.trim()) run(undefined, value); }}>{label}</button>
        ))}
      </div>

      {hits && (
        <div className="card">
          {hits.length === 0 ? (
            <div className="empty">
              <strong>No results</strong>
              Try fewer words, or remove the type filter. Newly written text is indexed
              for meaning in the background, so it may take a moment.
            </div>
          ) : hits.map((h) => (
            <a className="row" key={h.subject_id} href={hrefFor(h)}>
              <div className="lead">
                <div className="title">{h.title || "(untitled)"}</div>
                {h.snippet && <div className="meta">{h.snippet}</div>}
              </div>
              <span className="chip">{h.subject_type.replace(/_/g, " ")}</span>
              {h.matched?.includes("semantic") && (
                <span className="chip ok" title="Matched by meaning, not just words">
                  {h.matched.includes("keyword") ? "both" : "meaning"}
                </span>
              )}
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function hrefFor(hit: SearchHit): string {
  const map: Record<string, string> = {
    project: "/projects/", knowledge_note: "/knowledge/", content_item: "/content/",
    tool: "/library/", source: "/library/", project_log: "/projects/",
  };
  const base = map[hit.subject_type] ?? "/";
  return ["project", "knowledge_note", "content_item"].includes(hit.subject_type)
    ? `${base}?id=${encodeURIComponent(hit.subject_id)}`
    : base;
}
