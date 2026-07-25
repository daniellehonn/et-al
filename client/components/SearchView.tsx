"use client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, hitHref, type SearchHit } from "@/lib/api";

// Full-text search across every entity. FTS returns snippets with [term] markers
// we render as highlights. Keyword-first; semantic ranking is deferred.
const TYPE_LABEL: Record<string, string> = {
  document: "Document", task: "Task", insight: "Insight", source: "Source", decision: "Decision",
};

export function SearchView() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const { data, isFetching } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.get<SearchHit[]>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 0,
  });

  const grouped = new Map<string, SearchHit[]>();
  for (const h of data ?? []) (grouped.get(h.entity_type) ?? grouped.set(h.entity_type, []).get(h.entity_type)!).push(h);

  return (
    <div className="et-search-page">
      <input autoFocus className="et-search-input serif" value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Search everything…" aria-label="Search" />

      {debounced && (
        <div className="et-search-meta eyebrow">
          {isFetching ? "Searching…" : `${data?.length ?? 0} result${(data?.length ?? 0) === 1 ? "" : "s"} for "${debounced}"`}
        </div>
      )}

      {[...grouped.entries()].map(([type, hits]) => (
        <section key={type} className="et-search-group">
          <div className="eyebrow et-search-group-label">{TYPE_LABEL[type] ?? type} · {hits.length}</div>
          {hits.map((h) => {
            const href = hitHref(h);
            const inner = (
              <>
                <div className="et-hit-title">{h.title || "(untitled)"}</div>
                <div className="et-hit-snippet">{renderSnippet(h.snippet)}</div>
              </>
            );
            return href
              ? <a key={`${h.entity_type}-${h.entity_id}`} href={href} className="et-hit et-hit-link">{inner}</a>
              : <div key={`${h.entity_type}-${h.entity_id}`} className="et-hit">{inner}</div>;
          })}
        </section>
      ))}

      {debounced && !isFetching && (data?.length ?? 0) === 0 && (
        <div className="et-empty">Nothing matches. Try a different term.</div>
      )}
      {!debounced && <div className="et-search-hint">Search across documents, tasks, insights, sources, and decisions.</div>}

      <style>{`
        .et-search-page { max-width: 46rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
        .et-search-input { width: 100%; background: none; border: none; border-bottom: 2px solid var(--line-strong); font-size: 2rem; color: var(--ink); padding: 0.4rem 0; }
        .et-search-input:focus { outline: none; border-bottom-color: var(--color-iris); }
        .et-search-input::placeholder { color: var(--line-strong); }
        .et-search-meta { margin: 1rem 0 1.5rem; }
        .et-search-group { margin-bottom: 1.8rem; }
        .et-search-group-label { margin-bottom: 0.6rem; }
        .et-hit { display: block; padding: 0.6rem 0; border-bottom: 1px solid var(--line); text-decoration: none; color: inherit; }
        .et-hit-link { cursor: pointer; }
        .et-hit-link:hover .et-hit-title { color: var(--color-iris); }
        .et-hit-title { font-size: 0.98rem; }
        .et-hit-snippet { font-size: 0.85rem; color: var(--ink-soft); margin-top: 0.15rem; }
        .et-hit-snippet mark { background: var(--color-iris-soft); color: var(--ink); padding: 0 0.1em; border-radius: 2px; }
        .et-search-hint, .et-empty { color: var(--ink-faint); font-style: italic; margin-top: 1.5rem; }
      `}</style>
    </div>
  );
}

// FTS snippet() wraps matches in [ ]; turn those into <mark>.
function renderSnippet(snippet: string): React.ReactNode {
  const parts = snippet.split(/(\[[^\]]*\])/g);
  return parts.map((p, i) =>
    p.startsWith("[") && p.endsWith("]") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>,
  );
}
