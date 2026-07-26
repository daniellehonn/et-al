"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Insight, type Workspace } from "@/lib/api";
import { EditableText, DeleteButton } from "./Editable";

// Knowledge: the insights an agent distilled from sources — the nodes of the
// graph. A browsable board for now; the node-link graph visualization is a
// later phase. Insights are grouped by workspace.
export function KnowledgeView() {
  const qc = useQueryClient();
  const { data: insights, isLoading } = useQuery({ queryKey: ["insights"], queryFn: () => api.get<Insight[]>("/insights") });
  const { data: workspaces } = useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<Workspace[]>("/workspaces") });
  const [filter, setFilter] = useState("");
  const patch = useMutation({
    mutationFn: ({ iid, body }: { iid: string; body: Partial<Insight> }) => api.patch(`/insights/${iid}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["insights"] }),
  });
  const del = useMutation({
    mutationFn: (iid: string) => api.del(`/insights/${iid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["insights"] }),
  });

  const byId = new Map((workspaces ?? []).map((w) => [w.id, w.title]));
  const shown = (insights ?? []).filter((i) =>
    !filter || i.title.toLowerCase().includes(filter.toLowerCase()) || i.body.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="et-know-page">
      <header className="et-know-head">
        <div className="eyebrow">A graph of understanding</div>
        <h1 className="serif">Knowledge</h1>
        <p className="et-know-sub">Insights distilled from what you&apos;ve saved — not a folder of summaries. Ask an agent to <em>digest</em> a source into connected insights.</p>
      </header>

      <input className="et-know-filter" value={filter} onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter insights…" aria-label="Filter insights" />

      <div className="et-know-grid">
        {shown.map((i) => (
          <article key={i.id} className="et-insight" data-ai={!!i.is_ai}>
            <div className="et-insight-titlerow">
              <EditableText className="et-insight-title" value={i.title} onSave={(title) => patch.mutate({ iid: i.id, body: { title } })} />
              <DeleteButton onDelete={() => del.mutate(i.id)} confirm label="Delete insight" />
            </div>
            <EditableText multiline className="et-insight-body" value={i.body} onSave={(body) => patch.mutate({ iid: i.id, body: { body } })} />
            <div className="et-insight-foot eyebrow">
              {i.workspace_id ? byId.get(i.workspace_id) ?? "—" : "unfiled"}
              {i.is_ai ? " · distilled by agent" : ""}
            </div>
          </article>
        ))}
      </div>

      {!isLoading && shown.length === 0 && (
        <div className="et-empty">{filter ? "No insights match." : "No insights yet. They appear when saved material becomes tested knowledge."}</div>
      )}

      <style>{`
        .et-know-page { max-width: 58rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
        .et-know-head h1 { font-size: 2.4rem; margin: 0.3rem 0 0.5rem; }
        .et-know-sub { color: var(--ink-soft); font-size: 0.92rem; max-width: 40rem; margin: 0 0 1.6rem; }
        .et-know-sub em { font-family: var(--font-mono); font-style: normal; font-size: 0.9em; color: var(--ink); }
        .et-know-filter { width: 100%; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 9px; padding: 0.6rem 0.9rem; font: inherit; color: var(--ink); margin-bottom: 1.8rem; }
        .et-know-filter:focus { outline: none; border-color: var(--color-iris); }
        .et-know-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
        .et-insight { background: var(--paper-raised); border: 1px solid var(--line); border-radius: 12px; padding: 1.1rem; display: flex; flex-direction: column; gap: 0.4rem; }
        .et-insight[data-ai="true"] { border-left: 2px solid color-mix(in srgb, var(--color-iris) 50%, transparent); }
        .et-insight-titlerow { display: flex; align-items: flex-start; gap: 0.4rem; }
        .et-insight-title { font-weight: 500; font-size: 0.98rem; flex: 1; }
        .et-insight-body { font-size: 0.88rem; color: var(--ink-soft); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
        .et-insight-foot { color: var(--ink-faint); margin-top: 0.2rem; }
        .et-empty { color: var(--ink-faint); font-style: italic; margin-top: 1.5rem; }
      `}</style>
    </div>
  );
}
