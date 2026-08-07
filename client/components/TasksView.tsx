"use client";
// The task system: everything open, grouped by section.
//
// Separate from the page tree on purpose. A page holds the durable thing — a
// tracker, an implementation plan, notes — and hanging a task list off each one
// splits "what do I actually do next" across the whole workspace. Tasks live in
// one collection; the link back to the page a task came from is a property on
// the task, not ownership.
//
// Within a section, ordering answers "what is most pressing" rather than making
// the choice: overdue first, then soonest due, then priority. You pick.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Page, type RoleRow } from "@/lib/api";

interface Group { section: string; tasks: RoleRow[] }

const DAY = 86_400_000;

function dueLabel(ts: unknown): { text: string; tone: "overdue" | "soon" | "later" } | null {
  const n = Number(ts);
  if (!n) return null;
  const days = Math.floor((n - Date.now()) / DAY);
  if (days < 0) return { text: `${-days}d overdue`, tone: "overdue" };
  if (days === 0) return { text: "today", tone: "soon" };
  if (days === 1) return { text: "tomorrow", tone: "soon" };
  if (days <= 7) return { text: `${days}d`, tone: "soon" };
  return { text: new Date(n).toLocaleDateString(undefined, { month: "short", day: "numeric" }), tone: "later" };
}

export function TasksView() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | null>(null);

  const { data: groups, isLoading } = useQuery({
    queryKey: ["tasks-by-section"],
    queryFn: () => api.get<Group[]>("/tasks/by-section"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tasks-by-section"] });
    qc.invalidateQueries({ queryKey: ["home"] });
  };

  const complete = async (id: string) => {
    // Optimistic: the row disappears on click. It is leaving the list either
    // way, so waiting on the round-trip only makes the click feel slow.
    qc.setQueryData<Group[]>(["tasks-by-section"], (old) =>
      (old ?? []).map((g) => ({ ...g, tasks: g.tasks.filter((t) => t.id !== id) })));
    await api.patch(`/tasks/${id}`, { status: "done" });
    refresh();
  };

  const add = async (section: string, title: string) => {
    if (!title.trim()) return;
    await api.post("/tasks", { title: title.trim(), section: section || undefined });
    refresh();
  };

  if (isLoading) return <div className="et-tv-empty">Loading…</div>;

  const total = (groups ?? []).reduce((n, g) => n + g.tasks.length, 0);

  return (
    <div className="et-tv">
      <div className="et-tv-head">
        <h1>Tasks</h1>
        <span className="et-tv-count">{total} open</span>
      </div>

      {total === 0 && <p className="et-tv-empty">Nothing open. Add something below, or create tasks from a page.</p>}

      {(groups ?? []).map((g) => (
        <section key={g.section || "_none"} className="et-tv-section">
          <div className="et-tv-section-head">
            <span className="et-tv-section-name">{g.section || "unsectioned"}</span>
            <span className="et-tv-section-count">{g.tasks.length}</span>
          </div>

          {g.tasks.map((t) => {
            const due = dueLabel(t.props.due_date);
            return (
              <div key={t.id} className="et-tv-row">
                <button className="et-tv-check" aria-label="Complete" onClick={() => complete(t.id)} />
                <a className="et-tv-title" href={`/page/?id=${t.id}`}>{t.title || "Untitled"}</a>
                {t.props.source_page ? <SourceChip pageId={String(t.props.source_page)} /> : null}
                {due && <span className="et-tv-due" data-tone={due.tone}>{due.text}</span>}
              </div>
            );
          })}

          {adding === g.section ? (
            <input
              className="et-tv-add-input" autoFocus placeholder="What needs doing?"
              onKeyDown={(e) => {
                if (e.key === "Escape") setAdding(null);
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value;
                  (e.target as HTMLInputElement).value = "";
                  void add(g.section, v);
                }
              }}
              onBlur={() => setAdding(null)}
            />
          ) : (
            <button className="et-tv-add" onClick={() => setAdding(g.section)}>+ Add</button>
          )}
        </section>
      ))}

      <TasksStyles />
    </div>
  );
}

/** Where a task came from. Reads the page live so a rename shows through. */
function SourceChip({ pageId }: { pageId: string }) {
  const { data } = useQuery({
    queryKey: ["page", pageId],
    queryFn: () => api.get<Page>(`/pages/${pageId}`),
  });
  if (!data) return null;
  return <a className="et-tv-src" href={`/page/?id=${pageId}`}>{data.icon ?? "📄"} {data.title || "Untitled"}</a>;
}

function TasksStyles() {
  return (
    <style jsx global>{`
      .et-tv { max-width: 46rem; margin: 0 auto; padding: 2.5rem 3rem 6rem; }
      .et-tv-head { display: flex; align-items: baseline; gap: 0.7rem; margin-bottom: 1.8rem; }
      .et-tv-head h1 { font-size: 2.2rem; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
      .et-tv-count { font-size: 0.85rem; color: var(--ink-faint); }
      .et-tv-empty { color: var(--ink-faint); font-size: 0.9rem; }
      .et-tv-section { margin-bottom: 1.9rem; }
      .et-tv-section-head { display: flex; align-items: center; gap: 0.5rem; padding-bottom: 0.4rem;
        border-bottom: 1px solid var(--rule); margin-bottom: 0.3rem; }
      .et-tv-section-name { font-family: var(--font-mono); font-size: 0.7rem; text-transform: uppercase;
        letter-spacing: 0.07em; color: var(--ink-faint); }
      .et-tv-section-count { font-size: 0.7rem; color: var(--line-strong); }
      .et-tv-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.38rem 0; min-width: 0; }
      .et-tv-check { flex: none; width: 15px; height: 15px; border: 1.5px solid var(--line-strong);
        border-radius: 4px; background: none; cursor: pointer; padding: 0; }
      .et-tv-check:hover { border-color: var(--color-sage); background: var(--color-sage); }
      .et-tv-title { flex: 1; min-width: 0; font-size: 0.92rem; color: inherit; text-decoration: none;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .et-tv-title:hover { color: var(--color-iris); }
      .et-tv-src { flex: none; font-size: 0.73rem; color: var(--ink-faint); text-decoration: none;
        max-width: 11rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .et-tv-src:hover { color: var(--ink-soft); }
      .et-tv-due { flex: none; font-family: var(--font-mono); font-size: 0.68rem; padding: 0.1rem 0.4rem;
        border-radius: 4px; color: var(--ink-faint); }
      .et-tv-due[data-tone="overdue"] { color: var(--color-rust, #b4462e); background: rgba(180,70,46,.12); }
      .et-tv-due[data-tone="soon"] { color: var(--color-amber); background: rgba(217,138,61,.14); }
      .et-tv-add { background: none; border: none; font: inherit; font-size: 0.82rem; color: var(--line-strong);
        cursor: pointer; padding: 0.3rem 0; }
      .et-tv-add:hover { color: var(--color-iris); }
      .et-tv-add-input { width: 100%; border: none; border-bottom: 1px solid var(--color-iris); background: none;
        font: inherit; font-size: 0.92rem; color: inherit; padding: 0.35rem 0; }
      .et-tv-add-input:focus { outline: none; }
    `}</style>
  );
}
