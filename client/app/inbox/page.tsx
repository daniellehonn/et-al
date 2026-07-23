"use client";

// Inbox — captures awaiting a decision.
//
// Two things this screen must never do (spec §2.7, §7.8):
//   * hide the original input behind a summary — the raw text stays visible;
//   * treat a failed fetch as a lost capture — it stays fully reviewable, with
//     the failure stated and a retry offered.
//
// The AI proposal review that will sit here arrives in Phase 4. Until then this
// is honest manual triage rather than a placeholder for one.

import { useCallback, useEffect, useState } from "react";
import {
  getCaptures, updateCapture, retryCapture, deleteCapture, createCapture,
  type Capture,
} from "@/lib/api";

export default function InboxPage() {
  const [captures, setCaptures] = useState<Capture[] | null>(null);
  const [filter, setFilter] = useState("pending");
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback((status: string) => {
    getCaptures(status ? { review_status: status } : {})
      .then((r) => setCaptures(r.captures))
      .catch(() => setCaptures([]));
  }, []);

  useEffect(() => { load(filter); }, [load, filter]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try { await fn(); load(filter); } finally { setBusy(null); }
  }

  async function capture(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    await createCapture(draft.trim());
    setDraft("");
    load(filter);
  }

  return (
    <>
      <h1>Inbox</h1>
      <p style={{ color: "var(--ink-2)", margin: "4px 0 16px" }}>
        Raw captures, kept exactly as entered, until you decide where they belong.
      </p>

      <form className="capture" onSubmit={capture}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder="Capture a thought or paste a link…" aria-label="Capture" />
        <button className="btn primary" disabled={!draft.trim()}>Capture</button>
      </form>

      <div className="pick" style={{ marginBottom: 16 }}>
        {[["pending", "Pending"], ["accepted", "Accepted"], ["dismissed", "Dismissed"], ["", "All"]]
          .map(([value, label]) => (
            <button key={value} className={filter === value ? "on" : ""}
              onClick={() => { setCaptures(null); setFilter(value); }}>{label}</button>
          ))}
      </div>

      <div className="card">
        {!captures && <><div className="skeleton" /><div className="skeleton" /></>}
        {captures?.length === 0 && (
          <div className="empty">
            <strong>Nothing here</strong>
            Captured links and thoughts land in this queue. Processing runs in the
            background, so a capture is saved the instant you enter it.
          </div>
        )}
        {captures?.map((c) => (
          <div className="row" key={c.id}>
            <div className="lead">
              {/* The original input, never replaced by a generated summary. */}
              <div className="title" style={{ wordBreak: "break-word" }}>{c.raw_input}</div>
              <div className="meta">
                {c.input_type} · {new Date(c.created_at * 1000).toLocaleDateString()}
                {c.processing_error && (
                  <span style={{ color: "var(--error)" }}> · {c.processing_error}</span>
                )}
              </div>
            </div>

            <StatusChip status={c.processing_status} />

            <div style={{ display: "flex", gap: 6 }}>
              {c.processing_status === "failed" && (
                <button className="btn" disabled={busy === c.id}
                  onClick={() => act(c.id, () => retryCapture(c.id))}>Retry</button>
              )}
              {c.review_status === "pending" && (
                <button className="btn" disabled={busy === c.id}
                  onClick={() => act(c.id, () => updateCapture(c.id, { review_status: "accepted" }))}>
                  Keep
                </button>
              )}
              <button className="btn" disabled={busy === c.id}
                onClick={() => act(c.id, () => deleteCapture(c.id))}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function StatusChip({ status }: { status: string }) {
  if (status === "failed") return <span className="chip err">failed</span>;
  if (status === "ready") return <span className="chip ok">ready</span>;
  if (status === "processing") return <span className="chip warn">processing</span>;
  return <span className="chip">{status}</span>;
}
