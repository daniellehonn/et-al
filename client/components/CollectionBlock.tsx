"use client";
// An inline collection: Notion's database-in-a-page. The collection is owned by
// the page; a block of type 'collection' decides where in the body it appears,
// which is what lets prose and databases interleave in one scroll.
//
// Rows are pages. Clicking one opens it, because that is the difference this
// rewrite was for — in v7 a task was a row you could only inspect.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  api, collectionSchema, props,
  type Collection, type CollectionView, type Page, type PropertyDef,
} from "@/lib/api";

export function CollectionBlock({ collectionId }: { collectionId: string }) {
  const qc = useQueryClient();
  const [viewId, setViewId] = useState<string | null>(null);

  const { data: collection } = useQuery({
    queryKey: ["collection", collectionId],
    queryFn: () => api.get<Collection>(`/collections/${collectionId}`),
    enabled: !!collectionId,
  });
  const { data: views } = useQuery({
    queryKey: ["views", collectionId],
    queryFn: () => api.get<CollectionView[]>(`/collections/${collectionId}/views`),
    enabled: !!collectionId,
  });
  const { data: rows } = useQuery({
    queryKey: ["rows", collectionId],
    queryFn: () => api.get<Page[]>(`/collections/${collectionId}/rows`),
    enabled: !!collectionId,
  });

  if (!collectionId) return null;
  if (!collection) return <div className="et-col-loading">Loading…</div>;

  const schema = collectionSchema(collection);
  const view = views?.find((v) => v.id === viewId) ?? views?.[0] ?? null;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["rows", collectionId] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  const addRow = async () => {
    await api.post("/pages", { collection_id: collectionId, title: "" });
    refresh();
  };

  return (
    <div className="et-col">
      <div className="et-col-head">
        <span className="et-col-title">{collection.icon} {collection.title}</span>
        <div className="et-col-views">
          {(views ?? []).map((v) => (
            <button key={v.id} className="et-col-view" data-active={v.id === view?.id}
              onClick={() => setViewId(v.id)}>{v.name}</button>
          ))}
        </div>
        <button className="et-col-add" onClick={addRow}>+ New</button>
      </div>

      {view?.type === "board"
        ? <BoardView rows={rows ?? []} schema={schema} groupBy={view.group_by ?? "status"} onChange={refresh} />
        : <TableView rows={rows ?? []} schema={schema} onChange={refresh} />}

      {rows?.length === 0 && <div className="et-col-empty">Empty — click New to add a row.</div>}
      <CollectionStyles />
    </div>
  );
}

function openPage(id: string) {
  window.location.href = `/page/?id=${id}`;
}

/** A property cell. Editing writes the property back immediately: unlike a page
 *  body, a property is a fact rather than co-owned prose, so it needs no gate. */
function Cell({ row, def, onChange }: { row: Page; def: PropertyDef; onChange: () => void }) {
  const value = props(row)[def.key];
  const save = async (v: unknown) => {
    await api.patch(`/pages/${row.id}`, { properties: { [def.key]: v } });
    onChange();
  };

  if (def.type === "checkbox") {
    return <input type="checkbox" checked={!!value} onChange={(e) => save(e.target.checked)} />;
  }
  if (def.type === "select" && def.options?.length) {
    return (
      <select className="et-cell-select" value={String(value ?? "")} onChange={(e) => save(e.target.value || null)}>
        <option value="">—</option>
        {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (def.type === "date") {
    const asDate = typeof value === "number" ? new Date(value).toISOString().slice(0, 10) : "";
    return (
      <input type="date" className="et-cell-input" defaultValue={asDate}
        onBlur={(e) => save(e.target.value ? new Date(e.target.value).getTime() : null)} />
    );
  }
  if (def.type === "url") {
    return value
      ? <a className="et-cell-link" href={String(value)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{String(value).replace(/^https?:\/\//, "").slice(0, 40)}</a>
      : <span className="et-cell-empty">—</span>;
  }
  return (
    <input className="et-cell-input" defaultValue={value == null ? "" : String(value)}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        if (raw === String(value ?? "")) return;
        save(def.type === "number" ? (raw === "" ? null : Number(raw)) : raw || null);
      }} />
  );
}

function TitleCell({ row, onChange }: { row: Page; onChange: () => void }) {
  return (
    <div className="et-cell-title">
      <input className="et-cell-input" defaultValue={row.title} placeholder="Untitled"
        onBlur={(e) => { if (e.target.value !== row.title) api.patch(`/pages/${row.id}`, { title: e.target.value }).then(onChange); }} />
      <button className="et-open-btn" title="Open as a page" onClick={() => openPage(row.id)}>open</button>
    </div>
  );
}

function TableView({ rows, schema, onChange }: { rows: Page[]; schema: PropertyDef[]; onChange: () => void }) {
  return (
    <div className="et-col-scroll">
      <table className="et-col-table">
        <thead>
          <tr>
            <th>Name</th>
            {schema.map((d) => <th key={d.key}>{d.name}</th>)}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><TitleCell row={r} onChange={onChange} /></td>
              {schema.map((d) => <td key={d.key}><Cell row={r} def={d} onChange={onChange} /></td>)}
              <td>
                <button className="et-row-del" title="Delete row"
                  onClick={async () => { await api.del(`/pages/${r.id}`); onChange(); }}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Board view. Columns come from the grouping property's options where it has
 *  them, so an empty status column still shows up — a board that hid its empty
 *  lanes would make "nothing is blocked" indistinguishable from "no such lane". */
function BoardView({ rows, schema, groupBy, onChange }: { rows: Page[]; schema: PropertyDef[]; groupBy: string; onChange: () => void }) {
  const def = schema.find((d) => d.key === groupBy);
  const fromData = [...new Set(rows.map((r) => String(props(r)[groupBy] ?? "")))];
  const lanes = def?.options?.length ? [...def.options, ...fromData.filter((v) => v && !def.options!.includes(v))] : fromData;

  return (
    <div className="et-board">
      {lanes.map((lane) => {
        const inLane = rows.filter((r) => String(props(r)[groupBy] ?? "") === lane);
        return (
          <div key={lane || "—"} className="et-board-lane">
            <div className="et-board-lane-head">{lane || "No " + (def?.name ?? groupBy)} <span>{inLane.length}</span></div>
            {inLane.map((r) => (
              <div key={r.id} className="et-board-card" onClick={() => openPage(r.id)}>
                <div className="et-board-card-title">{r.title || "Untitled"}</div>
                {schema.filter((d) => d.key !== groupBy).slice(0, 2).map((d) => {
                  const v = props(r)[d.key];
                  return v == null || v === "" ? null : <div key={d.key} className="et-board-card-prop">{d.name}: {String(v)}</div>;
                })}
              </div>
            ))}
            {/* Adding into a lane presets the grouping property — the reason to
                use a board rather than a table in the first place. */}
            <button className="et-board-add" onClick={async () => {
              await api.post("/pages", { collection_id: rows[0]?.collection_id, title: "", properties: { [groupBy]: lane || null } });
              onChange();
            }}>+</button>
          </div>
        );
      })}
    </div>
  );
}

function CollectionStyles() {
  return (
    <style jsx global>{`
      .et-col { border: 1px solid var(--rule); border-radius: 8px; margin: 0.9rem 0; overflow: hidden; }
      .et-col-head { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--rule); }
      .et-col-title { font-weight: 600; font-size: 0.92rem; }
      .et-col-views { display: flex; gap: 0.2rem; margin-left: 0.4rem; }
      .et-col-view { background: none; border: none; font: inherit; font-size: 0.82rem; color: var(--ink-faint); padding: 0.2rem 0.5rem; border-radius: 5px; cursor: pointer; }
      .et-col-view[data-active="true"] { background: var(--surface-2); color: var(--ink); }
      .et-col-add { margin-left: auto; background: none; border: none; font: inherit; font-size: 0.82rem; color: var(--color-iris); cursor: pointer; }
      .et-col-empty { padding: 0.8rem; color: var(--ink-faint); font-size: 0.85rem; }
      .et-col-loading { padding: 0.6rem; color: var(--ink-faint); font-size: 0.85rem; }
      /* The table scrolls inside its own box; the page body must never scroll sideways. */
      .et-col-scroll { overflow-x: auto; }
      .et-col-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
      .et-col-table th { text-align: left; font-weight: 500; color: var(--ink-faint); font-size: 0.78rem; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--rule); white-space: nowrap; }
      .et-col-table td { padding: 0.15rem 0.45rem; border-bottom: 1px solid var(--rule); vertical-align: middle; }
      .et-cell-title { display: flex; align-items: center; gap: 0.3rem; min-width: 12rem; }
      .et-cell-input { background: none; border: 1px solid transparent; border-radius: 4px; font: inherit; color: inherit; padding: 0.25rem 0.35rem; width: 100%; min-width: 4rem; }
      .et-cell-input:hover { border-color: var(--rule); }
      .et-cell-input:focus { outline: none; border-color: var(--color-iris); background: var(--surface); }
      .et-cell-select { background: none; border: 1px solid transparent; border-radius: 4px; font: inherit; font-size: 0.85rem; color: inherit; padding: 0.2rem; }
      .et-cell-select:hover { border-color: var(--rule); }
      .et-cell-link { color: var(--color-iris); font-size: 0.82rem; }
      .et-cell-empty { color: var(--ink-faint); }
      .et-open-btn, .et-row-del { opacity: 0; background: none; border: none; color: var(--ink-faint); font-size: 0.75rem; cursor: pointer; padding: 0.15rem 0.3rem; }
      tr:hover .et-open-btn, tr:hover .et-row-del { opacity: 1; }
      .et-open-btn:hover, .et-row-del:hover { color: var(--ink); }
      .et-board { display: flex; gap: 0.7rem; padding: 0.7rem; overflow-x: auto; }
      .et-board-lane { min-width: 13rem; max-width: 13rem; display: flex; flex-direction: column; gap: 0.4rem; }
      .et-board-lane-head { font-size: 0.78rem; color: var(--ink-faint); font-weight: 600; text-transform: capitalize; display: flex; gap: 0.4rem; }
      .et-board-card { background: var(--surface-2); border: 1px solid var(--rule); border-radius: 6px; padding: 0.5rem; cursor: pointer; }
      .et-board-card:hover { border-color: var(--color-iris); }
      .et-board-card-title { font-size: 0.86rem; }
      .et-board-card-prop { font-size: 0.74rem; color: var(--ink-faint); margin-top: 0.2rem; }
      .et-board-add { background: none; border: 1px dashed var(--rule); border-radius: 6px; color: var(--ink-faint); cursor: pointer; padding: 0.3rem; }
    `}</style>
  );
}
