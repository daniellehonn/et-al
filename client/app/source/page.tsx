"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, linkMeta, type Source, type Workspace } from "@/lib/api";
import { EditableText } from "@/components/Editable";

// /source/?id=src_… — where an @-mention of a saved item lands.
//
// A mention needs a destination that outlives filing decisions: linking straight
// to the original leaves the app (and breaks for captures with no URL), and
// linking to a workspace shelf goes stale the moment the item is refiled. The
// source id never changes, so this page always resolves.
//
// Read from window.location rather than useSearchParams: this route is
// statically exported, and useSearchParams would force a Suspense boundary.
export default function SourcePage() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => { setId(new URLSearchParams(window.location.search).get("id")); }, []);

  const qc = useQueryClient();
  const { data: source, isLoading, error } = useQuery({
    queryKey: ["source", id],
    queryFn: () => api.get<Source>(`/sources/${id}`),
    enabled: !!id,
  });
  const { data: workspaces } = useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<Workspace[]>("/workspaces") });

  const rename = useMutation({
    mutationFn: (title: string) => api.patch(`/sources/${id}`, { title }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["source", id] }); qc.invalidateQueries({ queryKey: ["sources"] }); },
  });

  if (!id) return <Shell><p className="et-src-msg">No source specified.</p></Shell>;
  if (isLoading) return <Shell><p className="et-src-msg">Loading…</p></Shell>;
  if (error || !source) return <Shell><p className="et-src-msg">That source no longer exists. It may have been deleted.</p></Shell>;

  const meta = linkMeta(source);
  const workspace = (workspaces ?? []).find((w) => w.id === source.workspace_id);
  const note = source.raw && source.raw !== source.url && source.raw !== source.title ? source.raw : null;

  return (
    <Shell>
      <div className="eyebrow">Saved source</div>

      <div className="et-srcp-head">
        {meta?.image
          ? <img className="et-srcp-thumb" src={meta.image} alt="" />
          : <span className="et-srcp-thumb" data-fallback>{(meta?.site ?? source.kind).charAt(0).toUpperCase()}</span>}
        <div className="et-srcp-headbody">
          <EditableText as="h1" className="serif et-srcp-title" value={source.title ?? ""}
            placeholder="Name this…" onSave={(t) => rename.mutate(t)} />
          {meta?.site && <div className="et-srcp-site">{meta.site}</div>}
        </div>
      </div>

      {meta?.description && <p className="et-srcp-desc">{meta.description}</p>}
      {note && <p className="et-srcp-note">{note}</p>}

      <div className="et-srcp-actions">
        {source.url && <a className="et-srcp-btn" href={source.url} target="_blank" rel="noopener noreferrer">Open original ↗</a>}
        {workspace
          ? <a className="et-srcp-btn" data-quiet href={`/workspace/?id=${workspace.id}&tab=Sources`}>In {workspace.title}</a>
          : <a className="et-srcp-btn" data-quiet href="/inbox/">Still in the inbox</a>}
      </div>

      <dl className="et-srcp-meta">
        <div><dt className="eyebrow">Kind</dt><dd>{source.kind}</dd></div>
        <div><dt className="eyebrow">Captured</dt><dd>{new Date(source.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</dd></div>
        <div><dt className="eyebrow">Status</dt><dd>{source.status}</dd></div>
      </dl>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="et-srcp">
      {children}
      <style>{`
        .et-srcp { max-width: 42rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
        .et-src-msg { color: var(--ink-faint); font-style: italic; }
        .et-srcp-head { display: flex; gap: 1.1rem; align-items: flex-start; margin: 0.5rem 0 1.2rem; }
        .et-srcp-thumb { width: 6rem; height: 6rem; object-fit: cover; border-radius: 12px; flex: none; border: 1px solid var(--line); background: var(--paper-raised); }
        span.et-srcp-thumb[data-fallback] { display: grid; place-items: center; font-family: var(--font-display); font-size: 2.4rem; color: var(--ink-faint); }
        .et-srcp-headbody { min-width: 0; flex: 1; }
        .et-srcp-title { font-size: 2rem; line-height: 1.15; margin: 0; display: block; }
        .et-srcp-site { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 0.05em; color: var(--color-iris); margin-top: 0.35rem; }
        .et-srcp-desc { color: var(--ink-soft); font-size: 0.95rem; margin: 0 0 0.8rem; }
        .et-srcp-note { color: var(--ink); font-size: 0.92rem; margin: 0 0 0.8rem; padding-left: 0.8rem; border-left: 2px solid var(--line-strong); }
        .et-srcp-actions { display: flex; flex-wrap: wrap; gap: 0.6rem; margin: 1.4rem 0 2rem; }
        .et-srcp-btn { background: var(--color-iris); color: #fff; text-decoration: none; border-radius: 9px; padding: 0.55rem 1.1rem; font-size: 0.92rem; }
        .et-srcp-btn[data-quiet] { background: none; color: var(--ink-soft); border: 1px solid var(--line-strong); }
        .et-srcp-meta { display: flex; flex-wrap: wrap; gap: 2rem; margin: 0; padding-top: 1.2rem; border-top: 1px solid var(--line); }
        .et-srcp-meta dd { margin: 0.2rem 0 0; font-size: 0.9rem; }
        @media (max-width: 860px) {
          .et-srcp { padding: 1.5rem 1.1rem 5rem; }
          .et-srcp-title { font-size: 1.5rem; }
          .et-srcp-thumb { width: 4.5rem; height: 4.5rem; }
          .et-srcp-meta { gap: 1.2rem; }
        }
      `}</style>
    </div>
  );
}
