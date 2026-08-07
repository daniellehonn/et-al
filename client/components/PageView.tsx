"use client";
// One page: cover, icon, title, then the body. Nothing else.
//
// This is the whole point of v8. v7 put a project behind six tabs — Overview,
// Tasks, Documents, Sources, Decisions, Timeline — so reading a project meant
// walking it. Here a project is a thing you scroll, and its tasks and sources
// are collections sitting inline in the body wherever you put them.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, props, type Collection, type Page, type PagePatch } from "@/lib/api";
import { PageEditor } from "./PageEditor";
import { EmojiPicker } from "./EmojiPicker";
import { PageMenu } from "./PageMenu";

export function PageView({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data: page, isLoading, error } = useQuery({ queryKey: ["page", id], queryFn: () => api.get<Page>(`/pages/${id}`) });
  const { data: ancestors } = useQuery({ queryKey: ["ancestors", id], queryFn: () => api.get<Page[]>(`/pages/${id}/ancestors`) });
  const { data: collections } = useQuery({ queryKey: ["collections", id], queryFn: () => api.get<Collection[]>(`/pages/${id}/collections`) });

  if (isLoading) return <div className="et-page-loading">Loading…</div>;
  // A bad or stale id used to sit on "Loading…" forever, which reads as a hang
  // rather than a dead link.
  if (error || !page) return <div className="et-page-loading">That page doesn&rsquo;t exist. It may have been deleted.</div>;

  const save = async (patch: Record<string, unknown>) => {
    await api.patch(`/pages/${id}`, patch);
    qc.invalidateQueries({ queryKey: ["page", id] });
    qc.invalidateQueries({ queryKey: ["tree"] });
  };

  const addCollection = async (role: string | null) => {
    await api.post("/collections", {
      parent_page_id: id,
      title: role ? role[0].toUpperCase() + role.slice(1) : "Untitled",
      role,
    });
    qc.invalidateQueries({ queryKey: ["collections", id] });
    qc.invalidateQueries({ queryKey: ["blocks", id] });
  };

  const hasRole = (role: string) => (collections ?? []).some((c) => c.role === role);
  // Full width by default — a page is for reading your own work, and the
  // narrow measure is the exception you opt into, not the other way round.
  const fullWidth = props(page).full_width !== false;

  return (
    <div className="et-page">
      {page.cover && <div className="et-page-cover" style={{ backgroundImage: `url(${page.cover})` }} />}

      <div className="et-page-inner" data-full={fullWidth || undefined}>
        <div className="et-crumbs">
          {(ancestors ?? []).map((a) => (
            <span key={a.id}><a href={`/page/?id=${a.id}`}>{a.icon ?? "📄"} {a.title || "Untitled"}</a> / </span>
          ))}
        </div>

        <div className="et-page-icon-row">
          <EmojiPicker className="et-page-icon" value={page.icon ?? "📄"} onPick={(e) => save({ icon: e })} />
          {!page.cover && (
            <button className="et-page-cover-btn" onClick={() => {
              const url = prompt("Cover image URL");
              if (url) save({ cover: url });
            }}>Add cover</button>
          )}
          <button className="et-page-cover-btn" onClick={() => save({ properties: { full_width: !fullWidth } })}>
            {fullWidth ? "Narrow width" : "Full width"}
          </button>
          <PageMenu page={page} onChanged={() => qc.invalidateQueries({ queryKey: ["page", id] })} />
        </div>

        <TitleInput title={page.title} onSave={(t) => save({ title: t })} />

        <PatchQueue pageId={id} />
        <ProposalQueue />

        <PageEditor pageId={id} />

        {/* Collections are created here and then live in the body, positioned by
            their block — so this is a creation affordance, not a container. */}
        <div className="et-page-adds">
          {(["tasks", "sources", "insights", "decisions"] as const)
            .filter((r) => !hasRole(r))
            .map((r) => <button key={r} onClick={() => addCollection(r)}>+ {r[0].toUpperCase() + r.slice(1)} database</button>)}
          <button onClick={() => addCollection(null)}>+ Blank database</button>
        </div>
      </div>
      <PageStyles />
    </div>
  );
}

/** Machine-extracted knowledge awaiting review.
 *
 *  Sits beside the patch queue rather than in a separate screen: both are the
 *  same question — something was written for you, do you want it — and splitting
 *  them across two places is how a review queue becomes the thing you avoid. */
function ProposalQueue() {
  const qc = useQueryClient();
  const { data: proposals } = useQuery({
    queryKey: ["proposals"],
    queryFn: () => api.get<Array<{ id: string; title: string; props: Record<string, unknown> }>>("/proposals"),
    refetchInterval: 30000,
  });
  if (!proposals?.length) return null;

  const resolve = async (pid: string, accept: boolean) => {
    await api.post(`/proposals/${pid}/${accept ? "accept" : "reject"}`);
    qc.invalidateQueries({ queryKey: ["proposals"] });
    qc.invalidateQueries({ queryKey: ["rows"] });
  };

  return (
    <div className="et-patches">
      {proposals.map((p) => (
        <div key={p.id} className="et-patch" data-kind="proposal">
          <span className="et-patch-actor">{String(p.props.segment ?? "knowledge")}</span>
          <span className="et-patch-summary">{p.title}</span>
          <button className="et-patch-accept" onClick={() => resolve(p.id, true)}>Keep</button>
          <button className="et-patch-reject" onClick={() => resolve(p.id, false)}>Discard</button>
        </div>
      ))}
    </div>
  );
}

/** The page title. A textarea rather than an input so long titles wrap instead
 *  of scrolling out of sight, auto-growing to fit — Enter commits rather than
 *  inserting a newline, since a title is one line of text however many rows it
 *  takes to show. */
function TitleInput({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = ref.current;
    if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
  };
  useEffect(grow, [title]);
  return (
    <textarea ref={ref} className="et-page-title" defaultValue={title} placeholder="Untitled" rows={1}
      onInput={grow}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.currentTarget as HTMLTextAreaElement).blur(); } }}
      onBlur={(e) => { if (e.target.value !== title) onSave(e.target.value); }} />
  );
}

/** Agent-proposed body changes, awaiting Accept/Reject. Deliberately at the top
 *  of the page rather than in a side panel: a pending patch is a decision the
 *  page is waiting on, and burying it would quietly turn the gate into a
 *  rubber stamp. */
function PatchQueue({ pageId }: { pageId: string }) {
  const qc = useQueryClient();
  const { data: patches } = useQuery({
    queryKey: ["patches", pageId],
    queryFn: () => api.get<PagePatch[]>(`/pages/${pageId}/patches?status=pending`),
    refetchInterval: 8000,
  });
  if (!patches?.length) return null;

  const resolve = async (pid: string, accept: boolean) => {
    await api.post(`/patches/${pid}/resolve`, { accept });
    qc.invalidateQueries({ queryKey: ["patches", pageId] });
    qc.invalidateQueries({ queryKey: ["blocks", pageId] });
  };

  return (
    <div className="et-patches">
      {patches.map((p) => (
        <div key={p.id} className="et-patch">
          <span className="et-patch-actor">{p.actor}</span>
          <span className="et-patch-summary">{p.summary}</span>
          <button className="et-patch-accept" onClick={() => resolve(p.id, true)}>Accept</button>
          <button className="et-patch-reject" onClick={() => resolve(p.id, false)}>Reject</button>
        </div>
      ))}
    </div>
  );
}

function PageStyles() {
  return (
    <style jsx global>{`
      .et-page { flex: 1; min-width: 0; }
      .et-page-loading { padding: 3rem; color: var(--ink-faint); }
      .et-page-cover { height: 11rem; background-size: cover; background-position: center; }
      /* One column, one measure. A page is meant to be read top to bottom. */
      .et-page-inner { max-width: 46rem; margin: 0 auto; padding: 2rem 3rem 6rem; }
      /* Full width: the measure gives way but the gutters stay, so text never
         runs into the window edge. */
      .et-page-inner[data-full] { max-width: none; margin: 0; padding-left: 4rem; padding-right: 4rem; }
      .et-crumbs { font-size: 0.78rem; color: var(--ink-faint); margin-bottom: 0.8rem; }
      .et-crumbs a { color: inherit; text-decoration: none; }
      .et-crumbs a:hover { color: var(--ink); }
      .et-page-icon-row { display: flex; align-items: center; gap: 0.6rem; position: relative; }
      .et-page-icon { font-size: 3rem; background: none; border: none; cursor: pointer; padding: 0; line-height: 1; }
      .et-page-cover-btn { opacity: 0; background: none; border: none; color: var(--ink-faint); font-size: 0.8rem; cursor: pointer; }
      .et-page-inner:hover .et-page-cover-btn, .et-page-inner:hover .et-pagemenu-row { opacity: 1; }
      .et-pagemenu-row { opacity: 0; transition: opacity 0.12s; }
      .et-pagemenu[open] { opacity: 1; }
      .et-page-title { font-size: 2.4rem; font-weight: 700; background: none; border: none; width: 100%; color: inherit; font-family: inherit; padding: 0.4rem 0 1rem; letter-spacing: -0.02em; line-height: 1.15; resize: none; overflow: hidden; display: block; }
      .et-page-title:focus { outline: none; }
      .et-patches { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 1rem; }
      .et-patch { display: flex; align-items: center; gap: 0.6rem; border: 1px solid var(--color-iris); border-radius: 7px; padding: 0.5rem 0.7rem; font-size: 0.85rem; }
      .et-patch-actor { font-size: 0.75rem; color: var(--color-iris); font-weight: 600; }
      .et-patch-summary { flex: 1; min-width: 0; }
      .et-patch-accept, .et-patch-reject { background: none; border: 1px solid var(--rule); border-radius: 5px; font: inherit; font-size: 0.78rem; padding: 0.2rem 0.5rem; cursor: pointer; color: inherit; }
      .et-patch-accept:hover { border-color: var(--color-iris); color: var(--color-iris); }
      /* Proposals read as suggestions, not pending decisions on your own work. */
      .et-patch[data-kind="proposal"] { border-color: var(--color-sage); }
      .et-patch[data-kind="proposal"] .et-patch-actor { color: var(--color-sage); }
      .et-page-adds { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 2.5rem; opacity: 0; transition: opacity 0.15s; }
      .et-page-inner:hover .et-page-adds { opacity: 1; }
      .et-page-adds button { background: none; border: 1px dashed var(--rule); border-radius: 6px; font: inherit; font-size: 0.8rem; color: var(--ink-faint); padding: 0.3rem 0.6rem; cursor: pointer; }
      .et-page-adds button:hover { color: var(--ink); border-color: var(--ink-faint); }
    `}</style>
  );
}
