"use client";

// Library — tools under test, and the sources they came from.
//
// The Test Later lifecycle is the point: a saved tool that is never tested is
// the failure mode this product exists to prevent. So the UI asks for the thing
// each transition requires — an expected use before shortlisting, a written
// verdict before a tool can be called tested — and surfaces the store's refusal
// verbatim when it is missing.

import { useCallback, useEffect, useState } from "react";
import {
  getTools, createTool, updateTool, getSources,
  ApiError, type Tool, type Source,
} from "@/lib/api";

const TOOL_STATUSES = ["saved", "shortlisted", "testing", "tested", "adopted", "rejected"] as const;

export default function LibraryPage() {
  const [tab, setTab] = useState<"Tools" | "Sources">("Tools");
  return (
    <>
      <h1>Library</h1>
      <p style={{ color: "var(--ink-2)", margin: "4px 0 16px" }}>
        Tools move through a deliberate test lifecycle so the library cannot become
        a link graveyard.
      </p>
      <div className="pick" style={{ marginBottom: 16 }}>
        {(["Tools", "Sources"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === "Tools" ? <Tools /> : <Sources />}
    </>
  );
}

function Tools() {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [expectedUse, setExpectedUse] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback((status?: string) => {
    getTools(status ? { status } : {}).then((r) => setTools(r.tools)).catch(() => setTools([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    await createTool({
      name: name.trim(),
      expected_use: expectedUse.trim() || null,
    });
    setName(""); setExpectedUse("");
    load(filter || undefined);
  }

  return (
    <>
      <form onSubmit={add} style={{ marginBottom: 16 }}>
        <div className="capture" style={{ marginBottom: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Tool name or URL…" aria-label="Tool name" />
          <button className="btn primary" disabled={!name.trim()}>Save</button>
        </div>
        {/* Prompted at save, required at shortlist — asked here so the answer
            exists while the reason is still fresh. */}
        <input className="field" value={expectedUse} onChange={(e) => setExpectedUse(e.target.value)}
          placeholder="Why might this be useful? (needed before shortlisting)"
          aria-label="Expected use" />
      </form>

      <div className="pick" style={{ marginBottom: 14 }}>
        <button className={filter === "" ? "on" : ""}
          onClick={() => { setFilter(""); setTools(null); load(); }}>All</button>
        {TOOL_STATUSES.map((s) => (
          <button key={s} className={filter === s ? "on" : ""}
            onClick={() => { setFilter(s); setTools(null); load(s); }}>{s}</button>
        ))}
      </div>

      <div className="card">
        {!tools && <><div className="skeleton" /><div className="skeleton" /></>}
        {tools?.length === 0 && (
          <div className="empty">
            <strong>No tools saved</strong>
            Save a tool with a reason you might use it, then test it against a real project.
          </div>
        )}
        {tools?.map((t) => (
          <div key={t.id}>
            <div className="row">
              <div className="lead">
                <div className="title">{t.name}</div>
                <div className="meta">{t.expected_use ?? "No expected use recorded"}</div>
              </div>
              <span className={`chip ${["tested", "adopted"].includes(t.status) ? "ok" : t.status === "testing" ? "warn" : ""}`}>
                {t.status}
              </span>
              <button className="btn" onClick={() => setOpenId(openId === t.id ? null : t.id)}>
                {openId === t.id ? "Close" : "Advance"}
              </button>
            </div>
            {openId === t.id && (
              <ToolAdvance tool={t} onSaved={() => { load(filter || undefined); }} />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** The transition form. Prompts come straight from spec §3.6. */
function ToolAdvance({ tool, onSaved }: { tool: Tool; onSaved: () => void }) {
  const [expectedUse, setExpectedUse] = useState(tool.expected_use ?? "");
  const [criteria, setCriteria] = useState(tool.test_criteria ?? "");
  const [verdict, setVerdict] = useState(tool.verdict ?? "");
  const [rating, setRating] = useState<number | null>(tool.rating);
  const [error, setError] = useState<string | null>(null);

  async function move(status: string) {
    setError(null);
    try {
      await updateTool(tool.id, {
        status,
        expected_use: expectedUse || null,
        test_criteria: criteria || null,
        verdict: verdict || null,
        rating,
      });
      onSaved();
    } catch (e) {
      // e.g. "Status 'tested' requires a written verdict…"
      setError(e instanceof ApiError ? e.message : "Could not update");
    }
  }

  return (
    <div style={{ padding: "0 14px 14px" }}>
      {error && <div className="error-box" style={{ marginBottom: 10 }}>{error}</div>}
      <input className="field" value={expectedUse} onChange={(e) => setExpectedUse(e.target.value)}
        placeholder="Why might this be useful?" aria-label="Expected use" />
      <input className="field" value={criteria} onChange={(e) => setCriteria(e.target.value)}
        placeholder="What would define success? Which project could benefit?" aria-label="Test criteria" />
      <textarea className="field" rows={3} value={verdict} onChange={(e) => setVerdict(e.target.value)}
        placeholder="Verdict — what worked, what failed, would you use it again?"
        aria-label="Verdict" />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div className="pick">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={rating === n ? "on" : ""}
              onClick={() => setRating(rating === n ? null : n)}>{n}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {TOOL_STATUSES.filter((s) => s !== tool.status).map((s) => (
          <button key={s} className="btn" onClick={() => move(s)}>→ {s}</button>
        ))}
      </div>
    </div>
  );
}

function Sources() {
  const [sources, setSources] = useState<Source[] | null>(null);
  useEffect(() => { getSources().then((r) => setSources(r.sources)).catch(() => setSources([])); }, []);

  return (
    <div className="card">
      {!sources && <><div className="skeleton" /><div className="skeleton" /></>}
      {sources?.length === 0 && (
        <div className="empty">
          <strong>No sources yet</strong>
          Paste a link into the inbox — its title, author, and text are fetched
          automatically and recorded here.
        </div>
      )}
      {sources?.map((s) => (
        <div className="row" key={s.id}>
          <div className="lead">
            <div className="title">{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}</div>
            <div className="meta">{[s.platform, s.author].filter(Boolean).join(" · ")}</div>
          </div>
          <span className="chip">{s.platform}</span>
        </div>
      ))}
    </div>
  );
}
