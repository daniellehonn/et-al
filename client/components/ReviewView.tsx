"use client";
// The review queue: everything an agent or the extractor has proposed, in one
// place. A patch shows the exact diff accepting it would write; an insight shows
// the note it would become. Nothing here is real until it is accepted.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { actorLabel, api, type Proposal, type ProposalPreview } from "@/lib/api";

export function ReviewView() {
  const qc = useQueryClient();
  const { data: proposals, isLoading } = useQuery({ queryKey: ["proposals"], queryFn: () => api.get<Proposal[]>("/proposals"), refetchInterval: 15000 });
  const [focus, setFocus] = useState(0);
  const list = proposals ?? [];

  const resolve = async (id: string, accept: boolean) => {
    try {
      await api.post(`/proposals/${id}/${accept ? "accept" : "reject"}`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not resolve that proposal");
    }
    qc.invalidateQueries({ queryKey: ["proposals"] });
    qc.invalidateQueries({ queryKey: ["tree"] });
  };

  // j/k to move, a to accept, r to reject — a queue is worked through, not read.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]")) return;
      const current = list[Math.min(focus, list.length - 1)];
      if (e.key === "j") setFocus((f) => Math.min(f + 1, list.length - 1));
      else if (e.key === "k") setFocus((f) => Math.max(f - 1, 0));
      else if (e.key === "a" && current) void resolve(current.id, true);
      else if (e.key === "r" && current) void resolve(current.id, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    document.querySelector(`[data-review-index="${focus}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focus]);

  return (
    <div className="et-review">
      <header>
        <div className="eyebrow">Waiting on you</div>
        <h1 className="serif">Review</h1>
        <p className="et-review-sub">What agents and the extractor have proposed. Nothing here is in your notes until you accept it. <span className="et-review-keys"><kbd>j</kbd> <kbd>k</kbd> move · <kbd>a</kbd> accept · <kbd>r</kbd> reject</span></p>
      </header>
      {list.map((p, i) => (
        <ProposalCard key={p.id} proposal={p} index={i} focused={i === Math.min(focus, list.length - 1)}
          onFocus={() => setFocus(i)} onResolve={(accept) => resolve(p.id, accept)} />
      ))}
      {!isLoading && list.length === 0 && <div className="et-empty">Nothing to review.</div>}
      <ReviewStyles />
    </div>
  );
}

function ProposalCard({ proposal: p, index, focused, onFocus, onResolve }: {
  proposal: Proposal; index: number; focused: boolean; onFocus: () => void; onResolve: (accept: boolean) => void;
}) {
  const { data: preview } = useQuery({ queryKey: ["preview", p.id], queryFn: () => api.get<ProposalPreview>(`/proposals/${p.id}/preview`) });
  const stale = preview && "stale" in preview ? preview.stale : null;

  return (
    <article className="et-review-card" data-kind={p.kind} data-focused={focused} data-review-index={index} onClick={onFocus}>
      <div className="et-review-head">
        <span className="et-review-kind">{p.kind === "patch" ? "Edit" : "Insight"}</span>
        <span className="et-review-who">{actorLabel(p.actor)}</span>
        <span className="et-review-what">
          {p.kind === "patch"
            ? <>{p.summary} · <a href={`/note/?id=${p.note_id}`}>{p.note_title || "Untitled"}</a></>
            : <>from <a href={`/source/?id=${p.source_id}`}>{p.source_title || "a saved link"}</a></>}
        </span>
        <span className="et-review-when">{new Date(p.created_at).toLocaleString()}</span>
      </div>

      {!preview && <div className="et-review-loading">Loading…</div>}
      {preview?.kind === "insight" && "insight" in preview && (
        <div className="et-review-insight">
          <div className="et-review-insight-title">{preview.insight.title}</div>
          <p>{preview.insight.content}</p>
        </div>
      )}
      {preview && "diff" in preview && <DiffView diff={preview.diff} />}
      {stale && <div className="et-review-stale">This edit no longer applies — the note has changed since it was proposed ({stale}).</div>}

      <div className="et-review-actions">
        {!stale && <button className="et-review-accept" onClick={(e) => { e.stopPropagation(); onResolve(true); }}>{p.kind === "insight" ? "Keep as a note" : "Accept"}</button>}
        <button className="et-review-reject" onClick={(e) => { e.stopPropagation(); onResolve(false); }}>{p.kind === "insight" ? "Discard" : "Reject"}</button>
      </div>
    </article>
  );
}

/** A line diff, unified: removed lines in red, added in green, and long runs of
 *  unchanged lines folded so the change itself is what you read. */
export function DiffView({ diff }: { diff: Array<{ kind: "same" | "add" | "del"; text: string }> }) {
  const CONTEXT = 2;
  const changed = diff.map((l) => l.kind !== "same");
  const near = (i: number) => changed.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(Boolean);
  const rows: Array<{ kind: string; text: string } | { fold: number }> = [];
  let folded = 0;
  diff.forEach((l, i) => {
    if (l.kind === "same" && !near(i)) { folded++; return; }
    if (folded) { rows.push({ fold: folded }); folded = 0; }
    rows.push(l);
  });
  if (folded) rows.push({ fold: folded });
  if (!changed.some(Boolean)) return <div className="et-diff-none">No change to the text.</div>;

  return (
    <pre className="et-diff">
      {rows.map((r, i) => "fold" in r
        ? <div key={i} className="et-diff-fold">… {r.fold} unchanged line{r.fold === 1 ? "" : "s"}</div>
        : <div key={i} className="et-diff-line" data-kind={r.kind}><span aria-hidden>{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>{r.text || " "}</div>)}
    </pre>
  );
}

function ReviewStyles() {
  return (
    <style jsx global>{`
      .et-review { max-width: 52rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
      @media (max-width: 860px) { .et-review { padding: 3.5rem 1.1rem 5rem; } }
      .et-review h1 { font-size: 2.4rem; margin: 0.3rem 0 0.5rem; }
      .et-review-sub { color: var(--ink-soft); font-size: 0.92rem; margin: 0 0 2rem; }
      .et-review-keys { display: inline-block; margin-left: 0.4rem; color: var(--ink-faint); font-size: 0.8rem; }
      kbd { font-family: var(--font-mono); font-size: 0.72rem; border: 1px solid var(--line-strong); border-bottom-width: 2px; border-radius: 4px; padding: 0 0.3rem; background: var(--paper-raised); }
      .et-review-card { border: 1px solid var(--line); border-radius: 10px; padding: 0.9rem 1rem; margin-bottom: 0.9rem; background: var(--paper-raised); }
      .et-review-card[data-focused="true"] { border-color: var(--color-iris); box-shadow: 0 0 0 1px var(--color-iris); }
      .et-review-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 0.6rem; font-size: 0.86rem; margin-bottom: 0.6rem; }
      .et-review-kind { font-family: var(--font-mono); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; padding: 0.1rem 0.45rem; border-radius: 4px; background: var(--color-iris-soft); color: var(--color-iris); }
      .et-review-card[data-kind="insight"] .et-review-kind { background: color-mix(in srgb, var(--color-sage) 15%, transparent); color: var(--color-sage); }
      .et-review-who { font-family: var(--font-mono); font-size: 0.78rem; color: var(--ink-soft); }
      .et-review-what { flex: 1; min-width: 12rem; }
      .et-review-what a { color: var(--ink); }
      .et-review-when { font-size: 0.74rem; color: var(--ink-faint); }
      .et-review-loading { color: var(--ink-faint); font-size: 0.85rem; }
      .et-review-insight-title { font-weight: 600; }
      .et-review-insight p { margin: 0.3rem 0 0; color: var(--ink-soft); }
      .et-review-stale { border-left: 3px solid var(--color-amber); padding: 0.4rem 0.7rem; font-size: 0.85rem; color: var(--ink-soft); }
      .et-review-actions { display: flex; gap: 0.5rem; margin-top: 0.8rem; }
      .et-review-accept { background: var(--color-iris); color: #fff; border: none; border-radius: 7px; font: inherit; font-size: 0.85rem; padding: 0.35rem 0.9rem; cursor: pointer; }
      .et-review-card[data-kind="insight"] .et-review-accept { background: var(--color-sage); }
      .et-review-reject { background: none; border: 1px solid var(--line-strong); border-radius: 7px; font: inherit; font-size: 0.85rem; padding: 0.35rem 0.9rem; cursor: pointer; color: var(--ink-soft); }
      .et-diff { margin: 0; font-family: var(--font-mono); font-size: 0.78rem; line-height: 1.55; background: var(--paper); border: 1px solid var(--line); border-radius: 7px; padding: 0.4rem 0; overflow-x: auto; }
      .et-diff-line { padding: 0 0.7rem; white-space: pre-wrap; overflow-wrap: anywhere; }
      .et-diff-line span { display: inline-block; width: 1.2rem; color: var(--ink-faint); user-select: none; }
      .et-diff-line[data-kind="add"] { background: color-mix(in srgb, var(--color-sage) 16%, transparent); }
      .et-diff-line[data-kind="add"] span { color: var(--color-sage); }
      .et-diff-line[data-kind="del"] { background: color-mix(in srgb, #c0392b 12%, transparent); text-decoration: line-through; text-decoration-color: color-mix(in srgb, #c0392b 45%, transparent); }
      .et-diff-line[data-kind="del"] span { color: #c0392b; }
      .et-diff-fold { padding: 0.1rem 0.7rem; color: var(--ink-faint); font-style: italic; }
      .et-diff-none { font-size: 0.85rem; color: var(--ink-faint); }
    `}</style>
  );
}
