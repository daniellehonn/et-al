"use client";
// The parts of a collection beyond a plain table: the other view types, and the
// editors for filters, sorts and properties.
//
// Kept out of CollectionBlock so that file stays about rendering rows, and this
// one stays about configuring what rows you see.
import { useState } from "react";
import { api, props, type Page, type PropertyDef } from "@/lib/api";

export const VIEW_TYPES = ["table", "board", "list", "gallery", "calendar"] as const;

export const PROPERTY_TYPES = [
  "text", "number", "select", "multi_select", "date", "checkbox", "url",
] as const;

const FILTER_OPS = [
  { op: "is", label: "is" },
  { op: "is_not", label: "is not" },
  { op: "contains", label: "contains" },
  { op: "is_empty", label: "is empty" },
  { op: "is_not_empty", label: "is not empty" },
  { op: "gt", label: ">" },
  { op: "lt", label: "<" },
] as const;

export interface Filter { key: string; op: string; value: unknown }
export interface Sort { key: string; dir: "asc" | "desc" }

/** List view: title-only rows. The point is scanning a lot of them at once, so
 *  it deliberately shows no properties. */
export function ListView({ rows, onOpen }: { rows: Page[]; onOpen: (id: string) => void }) {
  return (
    <div className="et-listview">
      {rows.map((r) => (
        <button key={r.id} className="et-listview-row" onClick={() => onOpen(r.id)}>
          <span>{r.icon ?? "📄"}</span>
          <span className="et-listview-title">{r.title || "Untitled"}</span>
        </button>
      ))}
    </div>
  );
}

/** Gallery view: cards. Uses a page's cover when it has one, since the reason to
 *  choose a gallery is that the pages are visual. */
export function GalleryView({ rows, schema, onOpen }: { rows: Page[]; schema: PropertyDef[]; onOpen: (id: string) => void }) {
  return (
    <div className="et-gallery">
      {rows.map((r) => (
        <button key={r.id} className="et-gallery-card" onClick={() => onOpen(r.id)}>
          <div className="et-gallery-cover" style={r.cover ? { backgroundImage: `url(${r.cover})` } : undefined}>
            {!r.cover && <span className="et-gallery-icon">{r.icon ?? "📄"}</span>}
          </div>
          <div className="et-gallery-title">{r.title || "Untitled"}</div>
          {schema.slice(0, 2).map((d) => {
            const v = props(r)[d.key];
            return v == null || v === "" ? null : <div key={d.key} className="et-gallery-prop">{String(v)}</div>;
          })}
        </button>
      ))}
    </div>
  );
}

/** Calendar view: a real month grid for the first date property.
 *
 *  Rows with no date are listed under the grid rather than dropped — a calendar
 *  that silently hides undated rows makes them impossible to find or fix. */
export function CalendarView({ rows, schema, onOpen }: { rows: Page[]; schema: PropertyDef[]; onOpen: (id: string) => void }) {
  const dateKey = schema.find((d) => d.type === "date")?.key;
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });

  if (!dateKey) return <div className="et-col-empty">Add a date property to use a calendar.</div>;

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const lead = first.getDay();
  const cells: Array<number | null> = [
    ...Array(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const onDay = new Map<number, Page[]>();
  const undated: Page[] = [];
  for (const r of rows) {
    const raw = props(r)[dateKey];
    const ts = typeof raw === "number" ? raw : raw ? Date.parse(String(raw)) : NaN;
    if (!ts || Number.isNaN(ts)) { undated.push(r); continue; }
    const d = new Date(ts);
    if (d.getFullYear() !== month.getFullYear() || d.getMonth() !== month.getMonth()) continue;
    const day = d.getDate();
    if (!onDay.has(day)) onDay.set(day, []);
    onDay.get(day)!.push(r);
  }

  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  return (
    <div className="et-cal">
      <div className="et-cal-head">
        <button onClick={() => shift(-1)} aria-label="Previous month">‹</button>
        <span>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
        <button onClick={() => shift(1)} aria-label="Next month">›</button>
      </div>
      <div className="et-cal-grid">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i} className="et-cal-dow">{d}</div>)}
        {cells.map((day, i) => (
          <div key={i} className="et-cal-cell" data-empty={day === null || undefined}>
            {day !== null && <span className="et-cal-day">{day}</span>}
            {(onDay.get(day ?? -1) ?? []).map((r) => (
              <button key={r.id} className="et-cal-item" onClick={() => onOpen(r.id)}>{r.title || "Untitled"}</button>
            ))}
          </div>
        ))}
      </div>
      {undated.length > 0 && (
        <div className="et-cal-undated">
          <span className="et-cal-undated-label">No date ({undated.length})</span>
          {undated.map((r) => (
            <button key={r.id} className="et-cal-item" onClick={() => onOpen(r.id)}>{r.title || "Untitled"}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Filter and sort editor for one view. Writes straight through to the view, so
 *  a configured view is saved rather than being a per-session state. */
export function ViewConfig({
  viewId, schema, filter, sort, onSaved,
}: {
  viewId: string; schema: PropertyDef[]; filter: Filter[]; sort: Sort[]; onSaved: () => void;
}) {
  const save = async (next: { filter?: Filter[]; sort?: Sort[] }) => {
    await api.patch(`/views/${viewId}`, next);
    onSaved();
  };

  return (
    <div className="et-viewcfg">
      <div className="et-viewcfg-section">
        <span className="et-viewcfg-label">Filters</span>
        {filter.map((f, i) => (
          <div key={i} className="et-viewcfg-row">
            <select value={f.key} onChange={(e) => save({ filter: filter.map((x, j) => j === i ? { ...x, key: e.target.value } : x) })}>
              {schema.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
            </select>
            <select value={f.op} onChange={(e) => save({ filter: filter.map((x, j) => j === i ? { ...x, op: e.target.value } : x) })}>
              {FILTER_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
            {/* is_empty / is_not_empty take no operand, so no value box is shown. */}
            {!f.op.includes("empty") && (
              <input defaultValue={String(f.value ?? "")} placeholder="value"
                onBlur={(e) => save({ filter: filter.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })} />
            )}
            <button onClick={() => save({ filter: filter.filter((_, j) => j !== i) })} aria-label="Remove filter">×</button>
          </div>
        ))}
        <button className="et-viewcfg-add"
          onClick={() => save({ filter: [...filter, { key: schema[0]?.key ?? "status", op: "is", value: "" }] })}>
          + Add filter
        </button>
      </div>

      <div className="et-viewcfg-section">
        <span className="et-viewcfg-label">Sort</span>
        {sort.map((s, i) => (
          <div key={i} className="et-viewcfg-row">
            <select value={s.key} onChange={(e) => save({ sort: sort.map((x, j) => j === i ? { ...x, key: e.target.value } : x) })}>
              {schema.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
            </select>
            <select value={s.dir} onChange={(e) => save({ sort: sort.map((x, j) => j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x) })}>
              <option value="asc">ascending</option>
              <option value="desc">descending</option>
            </select>
            <button onClick={() => save({ sort: sort.filter((_, j) => j !== i) })} aria-label="Remove sort">×</button>
          </div>
        ))}
        <button className="et-viewcfg-add"
          onClick={() => save({ sort: [...sort, { key: schema[0]?.key ?? "status", dir: "asc" }] })}>
          + Add sort
        </button>
      </div>
    </div>
  );
}

/** Property editor: add, rename, retype and remove columns. */
export function PropertyConfig({
  collectionId, schema, onSaved,
}: { collectionId: string; schema: PropertyDef[]; onSaved: () => void }) {
  const put = async (next: PropertyDef[]) => {
    await api.put(`/collections/${collectionId}/properties`, { schema: next });
    onSaved();
  };

  return (
    <div className="et-viewcfg">
      <div className="et-viewcfg-section">
        <span className="et-viewcfg-label">Properties</span>
        {schema.map((d, i) => (
          <div key={d.key} className="et-viewcfg-row">
            <input defaultValue={d.name} aria-label="Property name"
              onBlur={(e) => { if (e.target.value !== d.name) put(schema.map((x, j) => j === i ? { ...x, name: e.target.value } : x)); }} />
            <select value={d.type} onChange={(e) => put(schema.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}>
              {PROPERTY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {d.type === "select" && (
              <input defaultValue={(d.options ?? []).join(", ")} placeholder="options, comma separated"
                onBlur={(e) => put(schema.map((x, j) => j === i
                  ? { ...x, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x))} />
            )}
            <button aria-label="Remove property"
              onClick={() => { if (confirm(`Remove "${d.name}"? Its values on every row are deleted.`)) put(schema.filter((_, j) => j !== i)); }}>×</button>
          </div>
        ))}
        <button className="et-viewcfg-add" onClick={() => {
          const name = prompt("Property name");
          if (!name) return;
          // The key is derived once and then fixed: it is what agents and the
          // role helpers read, so it must not drift when the label is edited.
          const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `prop_${schema.length + 1}`;
          put([...schema, { key, name, type: "text" }]);
        }}>+ Add property</button>
      </div>
    </div>
  );
}

export function CollectionExtraStyles() {
  return (
    <style jsx global>{`
      .et-listview { display: flex; flex-direction: column; }
      .et-listview-row { display: flex; align-items: center; gap: 0.5rem; background: none; border: none; border-bottom: 1px solid var(--rule); font: inherit; color: inherit; text-align: left; padding: 0.45rem 0.7rem; cursor: pointer; }
      .et-listview-row:hover { background: var(--surface-2); }
      .et-listview-title { font-size: 0.9rem; }
      .et-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 0.7rem; padding: 0.7rem; }
      .et-gallery-card { background: none; border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; cursor: pointer; text-align: left; padding: 0; font: inherit; color: inherit; }
      .et-gallery-card:hover { border-color: var(--color-iris); }
      .et-gallery-cover { height: 6rem; background: var(--surface-2); background-size: cover; background-position: center; display: flex; align-items: center; justify-content: center; }
      .et-gallery-icon { font-size: 1.8rem; }
      .et-gallery-title { padding: 0.45rem 0.55rem 0.1rem; font-size: 0.86rem; font-weight: 500; }
      .et-gallery-prop { padding: 0 0.55rem 0.35rem; font-size: 0.75rem; color: var(--ink-faint); }
      .et-cal { padding: 0.6rem; }
      .et-cal-head { display: flex; align-items: center; justify-content: center; gap: 0.8rem; font-size: 0.88rem; font-weight: 600; padding-bottom: 0.5rem; }
      .et-cal-head button { background: none; border: none; font: inherit; font-size: 1rem; color: var(--ink-faint); cursor: pointer; }
      .et-cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); }
      .et-cal-dow { background: var(--surface-2); text-align: center; font-size: 0.7rem; color: var(--ink-faint); padding: 0.25rem; }
      .et-cal-cell { background: var(--surface); min-height: 4.2rem; padding: 0.2rem; display: flex; flex-direction: column; gap: 0.15rem; }
      .et-cal-cell[data-empty] { background: var(--surface-2); }
      .et-cal-day { font-size: 0.7rem; color: var(--ink-faint); }
      .et-cal-item { background: var(--color-iris-soft); border: none; border-radius: 4px; font: inherit; font-size: 0.72rem; color: var(--ink); padding: 0.12rem 0.28rem; cursor: pointer; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .et-cal-undated { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; padding-top: 0.5rem; }
      .et-cal-undated-label { font-size: 0.72rem; color: var(--ink-faint); }
      .et-viewcfg { border-top: 1px solid var(--rule); padding: 0.5rem 0.7rem; display: flex; flex-wrap: wrap; gap: 1.2rem; background: var(--surface-2); }
      .et-viewcfg-section { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
      .et-viewcfg-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-faint); }
      .et-viewcfg-row { display: flex; gap: 0.25rem; align-items: center; flex-wrap: wrap; }
      .et-viewcfg-row select, .et-viewcfg-row input { font: inherit; font-size: 0.8rem; background: var(--surface); border: 1px solid var(--rule); border-radius: 5px; padding: 0.15rem 0.3rem; color: inherit; max-width: 10rem; }
      .et-viewcfg-row button { background: none; border: none; color: var(--ink-faint); cursor: pointer; font-size: 0.9rem; }
      .et-viewcfg-add { background: none; border: none; text-align: left; font: inherit; font-size: 0.78rem; color: var(--color-iris); cursor: pointer; padding: 0.1rem 0; }
    `}</style>
  );
}
